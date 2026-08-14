import Emitter from './emitter';
import { MSG, RESP_STATUS, DATA_CHUNK, READ_BLOCK, SEND_WINDOW, RTO_MS, ACCEPT_TIMEOUT } from './constants';
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

// 发送端会话 (UDP): 可靠控制消息 + GBN 滑动窗口数据通道
// 内存约束: 1MB 读块缓冲 + 32 片在飞窗口 (32KB), 远低于 10MB 上限
export default class SenderSession extends Emitter {
  constructor(link, target, files) {
    super();
    this._link = link;
    this.target = target; // {ip, udpPort, deviceName}
    this.files = files; // [{path, name, size}]
    this.totalSize = files.reduce((sum, f) => sum + f.size, 0);
    this.batchId = `${Date.now().toString(16)}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
    this._state = 'IDLE';
    this._acceptTimer = null;
    // GBN 状态
    this._fileIndex = -1;
    this._totalSeq = 0;
    this._base = 0; // 最老未确认
    this._next = 0; // 下一个待发
    this._buf = null; // 当前 1MB 读块
    this._bufStartSeq = 0;
    this._bufChunks = 0;
    this._loading = false;
    this._rtoTimer = null;
    // 进度统计
    this._ackedTotal = 0;
    this._prevFileBytes = 0;
    this._speedBps = 0;
    this._lastSpeedAt = 0;
    this._lastSpeedBytes = 0;

    this._onPacket = ({ ip, obj }) => this._handlePacket(ip, obj);
  }

  start() {
    this._state = 'WAITING_ACCEPT';
    this.emit('status', '等待对方确认接收...');
    this._link.on('packet', this._onPacket);
    this._acceptTimer = setTimeout(() => this._fail('对方长时间未响应, 传输已取消'), ACCEPT_TIMEOUT);
    this._reliable({
      type: MSG.TRANSFER_REQ,
      batchId: this.batchId,
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
      deviceType: getDeviceType(),
      totalFiles: this.files.length,
      totalSize: this.totalSize,
      files: this.files.map((f, i) => ({ fileIndex: i, fileName: f.name, fileSize: f.size })),
    }).catch(() => this._fail('无法送达对端设备, 请确认双方在同一 Wi-Fi 网络'));
  }

  cancel() {
    if (['COMPLETED', 'ERROR', 'CANCELED'].includes(this._state)) return;
    this._state = 'CANCELED';
    this._reliable({ type: MSG.TRANSFER_CANCEL, batchId: this.batchId, reason: 'USER_CANCELED' }).catch(() => {});
    this._teardown();
    this.emit('error', { canceled: true, message: '传输已取消' });
  }

  _reliable(obj) {
    return this._link.sendReliable(obj, this.target.ip, this.target.udpPort || 8888);
  }

  _handlePacket(ip, obj) {
    if (ip !== this.target.ip) return;
    if (obj.batchId && obj.batchId !== this.batchId) return;
    switch (obj.type) {
      case MSG.TRANSFER_RESP: {
        if (this._state !== 'WAITING_ACCEPT') return;
        clearTimeout(this._acceptTimer);
        this._acceptTimer = null;
        if (obj.status === RESP_STATUS.ACCEPTED) {
          this._state = 'TRANSFERRING';
          this._lastSpeedAt = Date.now();
          this._lastSpeedBytes = 0;
          this._sendNextFile();
        } else if (obj.status === RESP_STATUS.ERROR_INSUFFICIENT_STORAGE) {
          this._fail('对方存储空间不足, 已拒绝接收');
        } else {
          this._fail('对方拒绝了本次传输');
        }
        break;
      }
      case MSG.DACK: {
        if (this._state !== 'TRANSFERRING') return;
        // 忽略上一文件的延迟确认包, 防止串文件推进窗口
        if (obj.fileIndex !== this._fileIndex) return;
        this._onDack(obj.cum);
        break;
      }
      case MSG.TRANSFER_CANCEL: {
        this._fail('对方中断了本次传输');
        break;
      }
      default:
        break;
    }
  }

  async _sendNextFile() {
    this._fileIndex += 1;
    if (this._fileIndex >= this.files.length) {
      try {
        await this._reliable({ type: MSG.BATCH_END, batchId: this.batchId, totalFiles: this.files.length });
      } catch (e) {}
      this._state = 'COMPLETED';
      this._emitFinal();
      this._teardown();
      this.emit('done', { totalFiles: this.files.length, totalSize: this.totalSize });
      return;
    }
    const file = this.files[this._fileIndex];
    this._prevFileBytes = this._ackedTotal;
    this._totalSeq = Math.ceil(file.size / DATA_CHUNK);
    this._base = 0;
    this._next = 0;
    this._buf = null;
    this._bufStartSeq = 0;
    this._bufChunks = 0;
    this.emit('status', `正在校验文件 (${this._fileIndex + 1}/${this.files.length}): ${file.name}`);
    let md5 = '';
    try {
      md5 = await this._hashFile(file);
    } catch (e) {
      console.warn('[lan] md5 failed, continue without checksum', e);
    }
    if (this._state !== 'TRANSFERRING') return;
    this.emit('status', `正在发送 (${this._fileIndex + 1}/${this.files.length}): ${file.name}`);
    try {
      await this._reliable({
        type: MSG.FILE_HEADER,
        batchId: this.batchId,
        fileIndex: this._fileIndex,
        fileName: file.name,
        fileSize: file.size,
        totalSeq: this._totalSeq,
        md5,
      });
    } catch (e) {
      this._fail('文件信息发送失败, 传输中断');
      return;
    }
    if (this._totalSeq === 0) {
      // 空文件: 无数据片, 直接结束
      this._reliable({
        type: MSG.FILE_END,
        batchId: this.batchId,
        fileIndex: this._fileIndex,
        fileName: file.name,
        fileSize: 0,
      }).catch(() => {});
      this._sendNextFile();
      return;
    }
    this._pump();
  }

  async _hashFile(file) {
    const md5 = new Md5();
    let offset = 0;
    while (offset < file.size) {
      const len = Math.min(READ_BLOCK, file.size - offset);
      const buf = await readChunk(file.path, offset, len);
      md5.update(new Uint8Array(buf));
      offset += len;
    }
    return md5.digest();
  }

  // GBN 泵: 窗口未满且数据在缓冲块内则持续发片
  async _pump() {
    if (this._state !== 'TRANSFERRING' || this._loading) return;
    const file = this.files[this._fileIndex];
    while (this._next - this._base < SEND_WINDOW && this._next < this._totalSeq) {
      if (this._next >= this._bufStartSeq + this._bufChunks) {
        // 缓冲块已耗尽: 只有全部确认 (base 越过块尾) 才能读下一块, 否则等 ACK
        if (this._base >= this._bufStartSeq + this._bufChunks) {
          this._loading = true;
          try {
            const position = this._next * DATA_CHUNK;
            const len = Math.min(READ_BLOCK, file.size - position);
            this._buf = await readChunk(file.path, position, len);
            this._bufStartSeq = this._next;
            this._bufChunks = Math.ceil(len / DATA_CHUNK);
          } catch (e) {
            this._loading = false;
            this._fail('文件读取失败, 传输中断');
            return;
          }
          this._loading = false;
          if (this._state !== 'TRANSFERRING') return;
          continue;
        }
        break;
      }
      this._sendSeq(this._next);
      this._next += 1;
    }
    this._armRto();
  }

  _sendSeq(seq) {
    const start = (seq - this._bufStartSeq) * DATA_CHUNK;
    const end = Math.min(start + DATA_CHUNK, this._buf.byteLength);
    const payload = this._buf.slice(start, end);
    this._link.sendData(
      this.target.ip,
      this.target.udpPort || 8888,
      { b: this.batchId, f: this._fileIndex, s: seq },
      payload,
    );
  }

  _onDack(cum) {
    if (typeof cum !== 'number') return;
    if (cum < this._base) {
      // 重复确认: 连续 3 次触发快速重传 (局域网 RTT 极低, 不必苦等 RTO)
      if (cum === this._base - 1 && this._base < this._totalSeq) {
        this._dupAcks = (this._dupAcks || 0) + 1;
        if (this._dupAcks >= 3) {
          this._dupAcks = 0;
          this._retransmitWindow();
        }
      }
      return;
    }
    this._dupAcks = 0;
    const acked = Math.min(cum + 1, this._totalSeq) - this._base;
    if (acked <= 0) return;
    this._base += acked;
    this._ackedTotal += Math.min(acked * DATA_CHUNK, this.files[this._fileIndex].size - (this._base - acked) * DATA_CHUNK);
    this._reportProgress();
    if (this._base >= this._totalSeq) {
      // 当前文件全部确认
      const file = this.files[this._fileIndex];
      this._clearRto();
      this._reliable({
        type: MSG.FILE_END,
        batchId: this.batchId,
        fileIndex: this._fileIndex,
        fileName: file.name,
        fileSize: file.size,
      }).catch(() => this._fail('传输中断, 网络已断线'));
      this._sendNextFile();
      return;
    }
    this._pump();
  }

  _armRto() {
    this._clearRto();
    if (this._base < this._next) {
      this._rtoTimer = setTimeout(() => this._onRto(), RTO_MS);
    }
  }

  _clearRto() {
    if (this._rtoTimer) {
      clearTimeout(this._rtoTimer);
      this._rtoTimer = null;
    }
  }

  _onRto() {
    if (this._state !== 'TRANSFERRING') return;
    this._retransmitWindow();
  }

  // GBN: 重发窗口内所有未确认切片
  _retransmitWindow() {
    for (let seq = this._base; seq < this._next; seq++) {
      this._sendSeq(seq);
    }
    this._armRto();
  }

  _reportProgress() {
    const now = Date.now();
    const dt = now - this._lastSpeedAt;
    if (dt >= 500) {
      this._speedBps = ((this._ackedTotal - this._lastSpeedBytes) / dt) * 1000;
      this._lastSpeedAt = now;
      this._lastSpeedBytes = this._ackedTotal;
    }
    const remain = this.totalSize - this._ackedTotal;
    const file = this.files[this._fileIndex];
    const fileSent = Math.min(this._ackedTotal - this._prevFileBytes, file ? file.size : 0);
    this.emit('progress', {
      percent: this.totalSize > 0 ? this._ackedTotal / this.totalSize : 1,
      filePercent: file && file.size > 0 ? Math.min(1, fileSent / file.size) : 1,
      currentName: file ? file.name : '',
      doneFiles: this._fileIndex,
      totalFiles: this.files.length,
      speedBps: this._speedBps,
      etaSec: this._speedBps > 0 ? remain / this._speedBps : Infinity,
    });
  }

  _emitFinal() {
    this.emit('progress', {
      percent: 1,
      filePercent: 1,
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
    this._clearRto();
    this._link.off('packet', this._onPacket);
    this._buf = null;
  }
}
