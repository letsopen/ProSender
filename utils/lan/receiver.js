import Emitter from './emitter';
import { encodeFrame, FrameParser } from './frame';
import { MSG, RESP_STATUS, CHUNK_SIZE } from './constants';
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

// 接收端会话: CHUNK_DATA 直接 appendFile 流式落盘, 写完即 ACK (天然背压)
export default class ReceiverSession extends Emitter {
  constructor(socket, remoteInfo) {
    super();
    this._socket = socket;
    this._remote = remoteInfo || {};
    this._parser = new FrameParser((h, p) => this._onFrame(h, p));
    this._state = 'LISTENING';
    this._meta = null;
    this._curFile = null;
    this._writeQueue = Promise.resolve();
    this._savedFiles = [];
    this._receivedTotal = 0;
    this._speedBps = 0;
    this._lastSpeedAt = 0;
    this._lastSpeedBytes = 0;

    socket.onMessage((res) => {
      try {
        this._parser.push(res.message);
      } catch (e) {
        this._abort('数据帧解析失败, 传输中断');
      }
    });
    socket.onClose(() => {
      if (!['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) {
        this._abort('传输中断, 网络已断线');
      }
    });
    socket.onError(() => {
      if (!['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) {
        this._abort('连接异常, 传输中断');
      }
    });
  }

  get meta() {
    return this._meta;
  }

  accept() {
    if (this._state !== 'PROMPTING') return;
    this._state = 'RECEIVING';
    this._lastSpeedAt = Date.now();
    this._lastSpeedBytes = 0;
    this._write({ type: MSG.TRANSFER_RESP, batchId: this._meta.batchId, status: RESP_STATUS.ACCEPTED });
  }

  reject() {
    if (this._state !== 'PROMPTING') return;
    this._write({ type: MSG.TRANSFER_RESP, batchId: this._meta.batchId, status: RESP_STATUS.REJECTED });
    this._state = 'CANCELED';
    this._close();
  }

  cancel(reason) {
    if (['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) return;
    try {
      this._write({
        type: MSG.TRANSFER_CANCEL,
        batchId: this._meta ? this._meta.batchId : '',
        reason: reason || 'USER_CANCELED',
      });
    } catch (e) {}
    this._abort('传输已取消', true);
  }

  _write(header, payload) {
    this._socket.write(encodeFrame(header, payload));
  }

  _onFrame(header, payload) {
    switch (header.type) {
      case MSG.TRANSFER_REQ:
        this._onTransferReq(header);
        break;
      case MSG.FILE_HEADER:
        this._onFileHeader(header);
        break;
      case MSG.CHUNK_DATA:
        this._onChunkData(header, payload);
        break;
      case MSG.FILE_END:
        this._onFileEnd(header);
        break;
      case MSG.BATCH_END:
        this._onBatchEnd(header);
        break;
      case MSG.TRANSFER_CANCEL:
        this._abort('对方取消了本次传输');
        break;
      default:
        break;
    }
  }

  _onTransferReq(header) {
    if (this._state !== 'LISTENING') {
      // 同一时刻仅处理一个传输请求
      this._write({ type: MSG.TRANSFER_RESP, batchId: header.batchId, status: RESP_STATUS.REJECTED });
      return;
    }
    if (!hasEnoughStorage(header.totalSize || 0)) {
      this._write({
        type: MSG.TRANSFER_RESP,
        batchId: header.batchId,
        status: RESP_STATUS.ERROR_INSUFFICIENT_STORAGE,
      });
      this._state = 'CANCELED';
      this._close();
      this.emit('error', { message: '存储空间不足, 已自动拒绝传输' });
      return;
    }
    this._meta = {
      batchId: header.batchId,
      deviceName: header.deviceName,
      deviceType: header.deviceType,
      ip: this._remote.address || '未知 IP',
      totalFiles: header.totalFiles,
      totalSize: header.totalSize,
      files: header.files || [],
    };
    this._state = 'PROMPTING';
    this.emit('request', { meta: this._meta, session: this });
  }

  _onFileHeader(header) {
    if (this._state !== 'RECEIVING') return;
    const tempPath = `${wx.env.USER_DATA_PATH}/temp_${header.batchId}_${header.fileIndex}`;
    try {
      fsm.writeFileSync(tempPath, new ArrayBuffer(0));
    } catch (e) {
      this._abort('临时文件创建失败, 传输中断');
      return;
    }
    this._curFile = {
      fileIndex: header.fileIndex,
      fileName: header.fileName,
      fileSize: header.fileSize,
      md5: header.md5 || '',
      tempPath,
      received: 0,
    };
  }

  _onChunkData(header, payload) {
    if (this._state !== 'RECEIVING' || !this._curFile || !payload) return;
    const file = this._curFile;
    const chunkIndex = header.chunkIndex;
    const size = payload.byteLength;
    // 串行写盘队列, 保证切片顺序; ACK 在落盘成功后发送, 形成背压
    this._writeQueue = this._writeQueue
      .then(() => appendFile(file.tempPath, payload))
      .then(() => {
        file.received += size;
        this._receivedTotal += size;
        this._reportProgress();
        this._write({
          type: MSG.CHUNK_ACK,
          batchId: this._meta.batchId,
          fileIndex: header.fileIndex,
          chunkIndex,
        });
      })
      .catch((e) => {
        console.error('[lan] append chunk failed', e);
        this._abort('文件写入失败, 传输中断');
      });
  }

  _onFileEnd(header) {
    if (this._state !== 'RECEIVING' || !this._curFile) return;
    const file = this._curFile;
    this._curFile = null;
    this._writeQueue = this._writeQueue
      .then(async () => {
        let verifyOk = true;
        if (file.md5) {
          verifyOk = (await this._hashFile(file.tempPath, file.fileSize)) === file.md5;
        }
        const finalPath = `${wx.env.USER_DATA_PATH}/recv_${this._meta.batchId}_${sanitizeName(file.fileName)}`;
        await renameFile(file.tempPath, finalPath);
        this._savedFiles.push({
          name: file.fileName,
          size: file.fileSize,
          path: finalPath,
          verifyOk,
        });
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
      const len = Math.min(CHUNK_SIZE, fileSize - offset);
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
      this._close();
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
    this._close();
    // 清理未完成的临时切片文件
    const tasks = [];
    if (this._curFile) tasks.push(removeFile(this._curFile.tempPath));
    this._savedFiles = [];
    await Promise.all(tasks);
    if (!silent) this.emit('error', { canceled: false, message });
    else this.emit('error', { canceled: true, message });
  }

  _close() {
    if (this._socket) {
      try {
        this._socket.close();
      } catch (e) {}
      this._socket = null;
    }
  }
}
