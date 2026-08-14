import Emitter from './emitter';
import { PROTOCOL, MSG, UDP_PORT, RETRY_INTERVAL, RETRY_MAX } from './constants';
import { utf8Encode, utf8Decode } from './utf8';

// 数据报文魔数 'LTD1'
const MAGIC = 0x4c544431;

// 共享 UDP 链路: 全平台 (Android/iOS/Win/Mac/开发者工具) 均可 bind 收包, 无需监听端口
// - send: 普通 JSON 控制报文
// - sendReliable: 带 mid 的可靠控制报文 (对方自动回 CACK, 超时重传, 接收侧去重)
// - sendData: 二进制数据报文 (magic + headerLen + header JSON + payload)
export default class UdpLink extends Emitter {
  constructor() {
    super();
    this._socket = null;
    this._mid = 1;
    this._pending = new Map(); // mid -> {ip, port, packet, left, timer, resolve, reject}
    this._seen = new Map(); // ip -> [最近收到的 mid]
  }

  start(port = UDP_PORT) {
    if (this._socket) return;
    try {
      this._socket = wx.createUDPSocket();
      this._socket.bind(port);
      this._socket.onMessage((res) => this._onMessage(res));
      this._socket.onError((err) => this.emit('error', err));
    } catch (e) {
      console.error('[lan] udp init failed', e);
      this.emit('error', e);
    }
  }

  stop() {
    if (!this._socket) return;
    try {
      this._socket.close();
    } catch (e) {}
    this._socket = null;
    this._pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(new Error('link closed'));
    });
    this._pending.clear();
  }

  // 普通 JSON 控制报文
  send(obj, ip, port = UDP_PORT) {
    if (!this._socket) return;
    try {
      this._socket.send({ address: ip, port, message: JSON.stringify(obj) });
    } catch (e) {
      console.warn('[lan] udp send failed', e);
    }
  }

  // 可靠控制报文: 注入 mid, 等待 CACK, 最多重传 RETRY_MAX 次
  sendReliable(obj, ip, port = UDP_PORT) {
    return new Promise((resolve, reject) => {
      const mid = `${Date.now().toString(36)}_${this._mid++}`;
      const packet = { ...obj, protocol: PROTOCOL, mid };
      const entry = { ip, port, packet, left: RETRY_MAX, timer: null, resolve, reject };
      const tick = () => {
        if (!this._pending.has(mid)) return;
        if (entry.left-- <= 0) {
          this._pending.delete(mid);
          reject(new Error('reliable send timeout'));
          return;
        }
        this.send(packet, ip, port);
        entry.timer = setTimeout(tick, RETRY_INTERVAL);
      };
      this._pending.set(mid, entry);
      tick();
    });
  }

  // 二进制数据报文
  sendData(ip, port, header, payload) {
    if (!this._socket) return;
    const hb = utf8Encode(JSON.stringify(header));
    const out = new Uint8Array(6 + hb.length + payload.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, false);
    dv.setUint16(4, hb.length, false);
    out.set(hb, 6);
    out.set(new Uint8Array(payload), 6 + hb.length);
    try {
      this._socket.send({ address: ip, port, message: out.buffer });
    } catch (e) {}
  }

  _onMessage(res) {
    const ip = res.remoteInfo && res.remoteInfo.address;
    const port = (res.remoteInfo && res.remoteInfo.port) || UDP_PORT;
    if (!ip || !res.message) return;
    const raw = typeof res.message === 'string' ? null : new Uint8Array(res.message);

    // 二进制数据报文
    if (raw && raw.length >= 6) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      if (dv.getUint32(0, false) === MAGIC) {
        const hlen = dv.getUint16(4, false);
        if (raw.length < 6 + hlen) return;
        let header;
        try {
          header = JSON.parse(utf8Decode(raw.subarray(6, 6 + hlen)));
        } catch (e) {
          return;
        }
        this.emit('data', { ip, port, header, payload: raw.slice(6 + hlen).buffer });
        return;
      }
    }

    // JSON 控制报文
    let obj;
    try {
      obj = JSON.parse(typeof res.message === 'string' ? res.message : utf8Decode(raw));
    } catch (e) {
      return;
    }
    if (!obj || obj.protocol !== PROTOCOL) return;

    // 可靠回执
    if (obj.action === MSG.CACK) {
      const entry = this._pending.get(obj.ack);
      if (entry) {
        clearTimeout(entry.timer);
        this._pending.delete(obj.ack);
        entry.resolve();
      }
      return;
    }

    // 带 mid 的可靠报文: 先回 CACK, 再按 mid 去重分发
    if (obj.mid) {
      this.send({ protocol: PROTOCOL, action: MSG.CACK, ack: obj.mid }, ip, port);
      const seen = this._seen.get(ip) || [];
      if (seen.indexOf(obj.mid) >= 0) return;
      seen.push(obj.mid);
      if (seen.length > 64) seen.shift();
      this._seen.set(ip, seen);
    }
    this.emit('packet', { ip, port, obj });
  }
}
