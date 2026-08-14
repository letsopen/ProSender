import Emitter from './emitter';
import { PROTOCOL, MSG, RESP_STATUS, WRITE_BATCH, READ_BLOCK } from './constants';
import Md5 from './md5';

const fsm = wx.getFileSystemManager();

function appendFile(filePath, data) {
  return new Promise((resolve, reject) => {
    fsm.appendFile({ filePath, data, success: resolve, fail: reject });
  });
}

function renameFile(oldPath, newPath) {
  return new Promise((resolve, reject) => {
    fsm.rename({ oldPath, newPath, success: resolve, fail: reject });
  });
}

function removeFile(filePath) {
  return new Promise((resolve) => {
    fsm.unlink({ filePath, success: resolve, fail: resolve });
  });
}

function readChunk(filePath, position, length) {
  return new Promise((resolve, reject) => {
    fsm.readFile({ filePath, position, length, success: (res) => resolve(res.data), fail: reject });
  });
}

function hasEnoughStorage(needBytes) {
  try {
    const info = wx.getStorageInfoSync();
    // limitSize 为 0 表示未限制, 视为充足
    if (!info.limitSize) return true;
    return (info.limitSize - info.currentSize) * 1024 >= needBytes;
  } catch (e) {
    return true;
  }
}

function sanitizeName(name) {
  return String(name || 'unnamed').replace(/[\\/:*?"<>|]/g, '_');
}

// 接收端会话 (UDP): 按序接收, 攒批 64KB 落盘, 累积确认 DACK
// 内存约束: 攒批缓冲 64KB, 写完即释
export default class ReceiverSession extends Emitter {
  constructor(link, peerIp, peerPort) {
    super();
    this._link = link;
    this._peerIp = peerIp;
    this._peerPort = peerPort || 8888;
    this._state = 'LISTENING';
    this._meta = null;
    this._curFile = null;
    this._batch = []; // 攒批切片
    this._batchBytes = 0;
    this._writeQueue = Promise.resolve();
    this._savedFiles = [];
    this._receivedTotal = 0;
    this._speedBps = 0;
    this._lastSpeedAt = 0;
    this._lastSpeedBytes = 0;

    this._onPacket = ({ ip, obj }) => this._handlePacket(ip, obj);
    this._onData = ({ ip, header, payload }) => this._handleData(ip, header, payload);
    link.on('packet', this._onPacket);
    link.on('data', this._onData);
  }

  get meta() {
    return this._meta;
  }

  // 供 core 转发会话首个报文 (会话创建于 TRANSFER_REQ 到达之后)
  dispatch(ip, obj) {
    this._handlePacket(ip, obj);
  }

  accept() {
    if (this._state !== 'PROMPTING') return;
    this._state = 'RECEIVING';
    this._lastSpeedAt = Date.now();
    this._lastSpeedBytes = 0;
    this._reliable({ type: MSG.TRANSFER_RESP, batchId: this._meta.batchId, status: RESP_STATUS.ACCEPTED }).catch(
      () => {},
    );
  }

  reject() {
    if (this._state !== 'PROMPTING') return;
    this._state = 'CANCELED';
    this._reliable({ type: MSG.TRANSFER_RESP, batchId: this._meta.batchId, status: RESP_STATUS.REJECTED }).catch(
      () => {},
    );
    this._detach();
  }

  cancel() {
    if (['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) return;
    this._reliable({
      type: MSG.TRANSFER_CANCEL,
      batchId: this._meta ? this._meta.batchId : '',
      reason: 'USER_CANCELED',
    }).catch(() => {});
    this._abort('传输已取消', true);
  }

  _reliable(obj) {
    return this._link.sendReliable(obj, this._peerIp, this._peerPort);
  }

  _handlePacket(ip, obj) {
    if (ip !== this._peerIp) return;
    switch (obj.type) {
      case MSG.TRANSFER_REQ:
        this._onTransferReq(obj);
        break;
      case MSG.FILE_HEADER:
        this._onFileHeader(obj);
        break;
      case MSG.FILE_END:
        this._onFileEnd(obj);
        break;
      case MSG.BATCH_END:
        this._onBatchEnd();
        break;
      case MSG.TRANSFER_CANCEL:
        this._abort('对方取消了本次传输');
        break;
      default:
        break;
    }
  }

  _onTransferReq(obj) {
    if (this._state !== 'LISTENING') {
      // 同一会话重复投递已由 link 层去重; 此处为会话内二次请求, 直接拒绝
      if (this._state === 'PROMPTING') return;
      this._reliable({ type: MSG.TRANSFER_RESP, batchId: obj.batchId, status: RESP_STATUS.REJECTED }).catch(() => {});
      return;
    }
    if (!hasEnoughStorage(obj.totalSize || 0)) {
      this._state = 'CANCELED';
      this._reliable({
        type: MSG.TRANSFER_RESP,
        batchId: obj.batchId,
        status: RESP_STATUS.ERROR_INSUFFICIENT_STORAGE,
      }).catch(() => {});
      this.emit('error', { canceled: false, message: '存储空间不足, 已自动拒绝传输' });
      this._detach();
      return;
    }
    this._meta = {
      batchId: obj.batchId,
      deviceName: obj.deviceName,
      deviceType: obj.deviceType,
      ip: this._peerIp,
      totalFiles: obj.totalFiles,
      totalSize: obj.totalSize,
      files: obj.files || [],
    };
    this._state = 'PROMPTING';
    this.emit('request', { meta: this._meta, session: this });
  }

  _onFileHeader(obj) {
    if (this._state !== 'RECEIVING') return;
    if (obj.batchId !== this._meta.batchId) return;
    const tempPath = `${wx.env.USER_DATA_PATH}/temp_${obj.batchId}_${obj.fileIndex}`;
    try {
      fsm.writeFileSync(tempPath, new ArrayBuffer(0));
    } catch (e) {
      this._abort('临时文件创建失败, 传输中断');
      return;
    }
    this._curFile = {
      fileIndex: obj.fileIndex,
      fileName: obj.fileName,
      fileSize: obj.fileSize,
      totalSeq: obj.totalSeq || 0,
      md5: obj.md5 || '',
      tempPath,
      expectSeq: 0,
      received: 0,
    };
    this._batch = [];
    this._batchBytes = 0;
  }

  _handleData(ip, header, payload) {
    if (this._state !== 'RECEIVING' || !this._curFile) return;
    if (ip !== this._peerIp || header.b !== this._meta.batchId) return;
    const file = this._curFile;
    if (header.f !== file.fileIndex) return;
    if (header.s === file.expectSeq) {
      // 按序到达: 入攒批缓冲, 立即累积确认
      this._batch.push(payload);
      this._batchBytes += payload.byteLength;
      file.expectSeq += 1;
      file.received += payload.byteLength;
      this._receivedTotal += payload.byteLength;
      if (this._batchBytes >= WRITE_BATCH) this._flushBatch();
      this._reportProgress();
    }
    // 乱序/重复: 仅重发当前累积确认, 由发送端 RTO 重传补齐
    this._link.send(
      { protocol: PROTOCOL, type: MSG.DACK, batchId: this._meta.batchId, fileIndex: file.fileIndex, cum: file.expectSeq - 1 },
      this._peerIp,
      this._peerPort,
    );
  }

  _flushBatch() {
    if (!this._batch.length) return;
    const file = this._curFile;
    const total = this._batchBytes;
    const merged = new Uint8Array(total);
    let offset = 0;
    this._batch.forEach((buf) => {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    });
    // 写完即释, 保持堆内存低水位
    this._batch = [];
    this._batchBytes = 0;
    this._writeQueue = this._writeQueue
      .then(() => appendFile(file.tempPath, merged.buffer))
      .catch((e) => {
        console.error('[lan] append batch failed', e);
        this._abort('文件写入失败, 传输中断');
      });
  }

  _onFileEnd(obj) {
    if (this._state !== 'RECEIVING' || !this._curFile) return;
    if (obj.batchId !== this._meta.batchId) return;
    const file = this._curFile;
    if (file.expectSeq < file.totalSeq) {
      this._abort('文件数据不完整, 传输中断');
      return;
    }
    this._flushBatch();
    this._curFile = null;
    this._writeQueue = this._writeQueue
      .then(async () => {
        let verifyOk = true;
        if (file.md5 && file.fileSize > 0) {
          verifyOk = (await this._hashFile(file.tempPath, file.fileSize)) === file.md5;
        }
        const finalPath = `${wx.env.USER_DATA_PATH}/recv_${this._meta.batchId}_${sanitizeName(file.fileName)}`;
        await renameFile(file.tempPath, finalPath);
        this._savedFiles.push({ name: file.fileName, size: file.fileSize, path: finalPath, verifyOk });
      })
      .catch((e) => {
        console.error('[lan] save file failed', e);
        this._abort('文件保存失败, 传输中断');
      });
  }

  async _hashFile(filePath, fileSize) {
    const md5 = new Md5();
    let offset = 0;
    while (offset < fileSize) {
      const len = Math.min(READ_BLOCK, fileSize - offset);
      const buf = await readChunk(filePath, offset, len);
      md5.update(new Uint8Array(buf));
      offset += len;
    }
    return md5.digest();
  }

  _onBatchEnd() {
    if (this._state !== 'RECEIVING') return;
    this._state = 'COMPLETED';
    this._writeQueue.then(() => {
      this._detach();
      this.emit('done', {
        files: this._savedFiles.slice(),
        totalSize: this._receivedTotal,
        from: this._meta ? this._meta.deviceName : '',
      });
    });
  }

  _reportProgress() {
    const now = Date.now();
    const dt = now - this._lastSpeedAt;
    if (dt >= 500) {
      this._speedBps = ((this._receivedTotal - this._lastSpeedBytes) / dt) * 1000;
      this._lastSpeedAt = now;
      this._lastSpeedBytes = this._receivedTotal;
    }
    const total = this._meta ? this._meta.totalSize : 0;
    const remain = total - this._receivedTotal;
    const cur = this._curFile;
    this.emit('progress', {
      percent: total > 0 ? this._receivedTotal / total : 0,
      filePercent: cur && cur.fileSize > 0 ? Math.min(1, cur.received / cur.fileSize) : 1,
      currentName: cur ? cur.fileName : '',
      doneFiles: this._savedFiles.length,
      totalFiles: this._meta ? this._meta.totalFiles : 0,
      speedBps: this._speedBps,
      etaSec: this._speedBps > 0 ? remain / this._speedBps : Infinity,
    });
  }

  async _abort(message, silent) {
    if (['ERROR', 'CANCELED', 'COMPLETED'].includes(this._state)) return;
    this._state = 'ERROR';
    this._detach();
    // 清理未完成的临时切片文件
    if (this._curFile) await removeFile(this._curFile.tempPath);
    this._curFile = null;
    this._batch = [];
    this._batchBytes = 0;
    this._savedFiles = [];
    this.emit('error', { canceled: !!silent, message });
  }

  _detach() {
    this._link.off('packet', this._onPacket);
    this._link.off('data', this._onData);
  }
}
