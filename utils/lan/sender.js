import Emitter from './emitter';
import { encodeFrame, FrameParser } from './frame';
import { MSG, RESP_STATUS, CHUNK_SIZE, SEND_WINDOW, ACCEPT_TIMEOUT } from './constants';
import { getDeviceId, getDeviceName, getDeviceType } from './device';
import Md5 from './md5';

const fsm = wx.getFileSystemManager();

function readChunk(filePath, position, length) {
  return new Promise((resolve, reject) => {
    fsm.readFile({
      filePath,
      position,
      length,
      success: (res) => resolve(res.data),
      fail: reject,
    });
  });
}

// 发送端会话: 单 TCP 通道串行发送批量文件, 1MB 切片 + 窗口为 2 的 CHUNK_ACK 背压控制
export default class SenderSession extends Emitter {
  constructor(target, files) {
    super();
    this.target = target;
    this.files = files; // [{path, name, size}]
    this.totalSize = files.reduce((sum, f) => sum + f.size, 0);
    this.batchId = `${Date.now().toString(16)}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
    this._socket = null;
    this._parser = new FrameParser((h, p) => this._onFrame(h, p));
    this._state = 'IDLE';
    this._canceled = false;
    this._acceptTimer = null;
    // 当前文件发送游标
    this._fileIndex = -1;
    this._sentOffset = 0;
    this._nextChunkIndex = 0;
    this._inflight = 0;
    this._reading = false;
    this._pendingAcks = new Map();
    // 进度统计
    this._ackedTotal = 0;
    this._prevFileBytes = 0;
    this._speedBps = 0;
    this._lastSpeedAt = 0;
    this._lastSpeedBytes = 0;
  }

  start() {
    this._state = 'CONNECTING';
    this.emit('status', '正在连接对端设备...');
    const socket = wx.createTCPSocket();
    this._socket = socket;
    socket.onConnect(() => {
      this._state = 'WAITING_ACCEPT';
      this.emit('status', '等待对方确认接收...');
      this._write({
        type: MSG.TRANSFER_REQ,
        protocol: 'LAN_TRANSFER_V1',
        batchId: this.batchId,
        deviceId: getDeviceId(),
        deviceName: getDeviceName(),
        deviceType: getDeviceType(),
        totalFiles: this.files.length,
        totalSize: this.totalSize,
        files: this.files.map((f, i) => ({ fileIndex: i, fileName: f.name, fileSize: f.size })),
      });
      this._acceptTimer = setTimeout(() => {
        this._fail('对方长时间未响应, 传输已取消');
      }, ACCEPT_TIMEOUT);
    });
    socket.onMessage((res) => {
      try {
        this._parser.push(res.message);
      } catch (e) {
        this._fail('数据帧解析失败, 传输中断');
      }
    });
    socket.onClose(() => {
      if (!['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) {
        this._fail('传输中断, 网络已断线');
      }
    });
    socket.onError(() => {
      this._fail('连接失败, 请确认两台设备处于同一 Wi-Fi 网络');
    });
    socket.connect({ address: this.target.ip, port: this.target.tcpPort || 8889 });
  }

  cancel(userReason) {
    if (this._canceled || ['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) return;
    this._canceled = true;
    try {
      this._write({ type: MSG.TRANSFER_CANCEL, batchId: this.batchId, reason: userReason || 'USER_CANCELED' });
    } catch (e) {}
    this._state = 'CANCELED';
    this._teardown();
    this.emit('error', { canceled: true, message: '传输已取消' });
  }

  _write(header, payload) {
    this._socket.write(encodeFrame(header, payload));
  }

  _onFrame(header) {
    switch (header.type) {
      case MSG.TRANSFER_RESP: {
        if (this._state !== 'WAITING_ACCEPT') return;
        clearTimeout(this._acceptTimer);
        this._acceptTimer = null;
        if (header.status === RESP_STATUS.ACCEPTED) {
          this._state = 'TRANSFERRING';
          this._lastSpeedAt = Date.now();
          this._lastSpeedBytes = 0;
          this._sendNextFile();
        } else if (header.status === RESP_STATUS.ERROR_INSUFFICIENT_STORAGE) {
          this._fail('对方存储空间不足, 已拒绝接收');
        } else {
          this._fail('对方拒绝了本次传输');
        }
        break;
      }
      case MSG.CHUNK_ACK: {
        if (this._state !== 'TRANSFERRING') return;
        const size = this._pendingAcks.get(header.chunkIndex);
        if (size != null) {
          this._pendingAcks.delete(header.chunkIndex);
          this._inflight = Math.max(0, this._inflight - 1);
          this._ackedTotal += size;
          this._reportProgress();
        }
        this._maybeAdvance();
        break;
      }
      case MSG.TRANSFER_CANCEL: {
        this._fail(`对方中断了传输${header.reason ? `: ${header.reason}` : ''}`);
        break;
      }
      default:
        break;
    }
  }

  async _sendNextFile() {
    this._fileIndex += 1;
    if (this._fileIndex >= this.files.length) {
      this._write({ type: MSG.BATCH_END, batchId: this.batchId, totalFiles: this.files.length });
      this._state = 'COMPLETED';
      this._emitProgress(1, 1);
      this._teardown();
      this.emit('done', { totalFiles: this.files.length, totalSize: this.totalSize });
      return;
    }
    const file = this.files[this._fileIndex];
    this._prevFileBytes = this._ackedTotal;
    this._sentOffset = 0;
    this._nextChunkIndex = 0;
    this._inflight = 0;
    this._pendingAcks.clear();
    this.emit('status', `正在校验文件 (${this._fileIndex + 1}/${this.files.length}): ${file.name}`);
    let md5 = '';
    try {
      md5 = await this._hashFile(file.path);
    } catch (e) {
      console.warn('[lan] md5 failed, continue without checksum', e);
    }
    if (this._canceled || this._state !== 'TRANSFERRING') return;
    this.emit('status', `正在发送 (${this._fileIndex + 1}/${this.files.length}): ${file.name}`);
    this._write({
      type: MSG.FILE_HEADER,
      batchId: this.batchId,
      fileIndex: this._fileIndex,
      fileName: file.name,
      fileSize: file.size,
      md5,
    });
    this._maybeAdvance();
  }

  async _hashFile(filePath) {
    const md5 = new Md5();
    const stat = this.files[this._fileIndex].size;
    let offset = 0;
    while (offset < stat) {
      const len = Math.min(CHUNK_SIZE, stat - offset);
      const buf = await readChunk(filePath, offset, len);
      md5.update(new Uint8Array(buf));
      offset += len;
    }
    return md5.digest();
  }

  // 背压核心: 窗口内最多 SEND_WINDOW 个未确认切片, 收到 ACK 后推进
  _maybeAdvance() {
    if (this._canceled || this._state !== 'TRANSFERRING' || this._reading) return;
    const file = this.files[this._fileIndex];
    if (!file) return;
    if (this._sentOffset >= file.size) {
      if (this._inflight === 0) {
        this._write({
          type: MSG.FILE_END,
          batchId: this.batchId,
          fileIndex: this._fileIndex,
          fileName: file.name,
          fileSize: file.size,
        });
        this._sendNextFile();
      }
      return;
    }
    if (this._inflight >= SEND_WINDOW) return;
    this._pump(file);
  }

  async _pump(file) {
    this._reading = true;
    try {
      while (
        !this._canceled &&
        this._state === 'TRANSFERRING' &&
        this._inflight < SEND_WINDOW &&
        this._sentOffset < file.size
      ) {
        const offset = this._sentOffset;
        const len = Math.min(CHUNK_SIZE, file.size - offset);
        this._sentOffset += len;
        const chunkIndex = this._nextChunkIndex++;
        const buf = await readChunk(file.path, offset, len);
        this._write(
          {
            type: MSG.CHUNK_DATA,
            batchId: this.batchId,
            fileIndex: this._fileIndex,
            chunkIndex,
            offset,
            chunkSize: buf.byteLength,
          },
          buf,
        );
        this._pendingAcks.set(chunkIndex, buf.byteLength);
        this._inflight += 1;
      }
    } catch (e) {
      console.error('[lan] read chunk failed', e);
      this._fail('文件读取失败, 传输中断');
      return;
    } finally {
      this._reading = false;
    }
    this._maybeAdvance();
  }

  _reportProgress() {
    const now = Date.now();
    const dt = now - this._lastSpeedAt;
    if (dt >= 500) {
      this._speedBps = ((this._ackedTotal - this._lastSpeedBytes) / dt) * 1000;
      this._lastSpeedAt = now;
      this._lastSpeedBytes = this._ackedTotal;
    }
    const percent = this.totalSize > 0 ? this._ackedTotal / this.totalSize : 1;
    const remain = this.totalSize - this._ackedTotal;
    const etaSec = this._speedBps > 0 ? remain / this._speedBps : Infinity;
    const file = this.files[this._fileIndex];
    const fileSent = this._ackedTotal - this._prevFileBytes;
    const filePercent = file && file.size > 0 ? Math.min(1, fileSent / file.size) : 1;
    this.emit('progress', {
      percent,
      filePercent,
      currentName: file ? file.name : '',
      doneFiles: this._fileIndex,
      totalFiles: this.files.length,
      speedBps: this._speedBps,
      etaSec,
    });
  }

  _emitProgress(percent, filePercent) {
    this.emit('progress', {
      percent,
      filePercent,
      currentName: '',
      doneFiles: this.files.length,
      totalFiles: this.files.length,
      speedBps: this._speedBps,
      etaSec: 0,
    });
  }

  _fail(message) {
    if (['ERROR', 'CANCELED', 'COMPLETED'].includes(this._state)) return;
    this._state = 'ERROR';
    this._teardown();
    this.emit('error', { canceled: false, message });
  }

  _teardown() {
    if (this._acceptTimer) {
      clearTimeout(this._acceptTimer);
      this._acceptTimer = null;
    }
    if (this._socket) {
      try {
        this._socket.close();
      } catch (e) {}
      this._socket = null;
    }
  }
}
