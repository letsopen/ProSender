import Emitter from './emitter';
import { PROTOCOL, UDP_PORT, TCP_PORT, BROADCAST_ADDR, MSG, PING_INTERVAL, DEVICE_TTL } from './constants';
import { getDeviceId, getDeviceName, getDeviceType } from './device';
import { utf8Decode } from './utf8';

// UDP 设备发现: 每 3s 广播 PING (兼作心跳), 收到 PING 回 PONG, 10s 无心跳剔除
export default class Discovery extends Emitter {
  constructor() {
    super();
    this._socket = null;
    this._devices = new Map();
    this._pingTimer = null;
    this._ttlTimer = null;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    try {
      this._socket = wx.createUDPSocket();
      this._socket.bind(UDP_PORT);
      this._socket.onMessage((res) => this._onMessage(res));
      this._socket.onError((err) => {
        console.warn('[lan] udp error', err);
        this.emit('error', err);
      });
      if (this._socket.onListening) this._socket.onListening(() => this.ping());
    } catch (e) {
      console.error('[lan] udp init failed', e);
      this.emit('error', e);
      return;
    }
    this.ping();
    this._pingTimer = setInterval(() => this.ping(), PING_INTERVAL);
    this._ttlTimer = setInterval(() => this._sweep(), 2000);
  }

  stop() {
    this._running = false;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._ttlTimer) clearInterval(this._ttlTimer);
    this._pingTimer = null;
    this._ttlTimer = null;
    if (this._socket) {
      try {
        this._socket.close();
      } catch (e) {}
      this._socket = null;
    }
    this._devices.clear();
    this.emit('devices', []);
  }

  _selfPacket(action) {
    return JSON.stringify({
      protocol: PROTOCOL,
      action,
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
      deviceType: getDeviceType(),
      tcpPort: TCP_PORT,
      timestamp: Date.now(),
    });
  }

  ping() {
    if (!this._socket) return;
    try {
      this._socket.send({
        address: BROADCAST_ADDR,
        port: UDP_PORT,
        message: this._selfPacket(MSG.PING),
      });
    } catch (e) {
      console.warn('[lan] udp broadcast failed', e);
    }
  }

  _onMessage(res) {
    let packet;
    try {
      const text = typeof res.message === 'string' ? res.message : utf8Decode(new Uint8Array(res.message));
      packet = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!packet || packet.protocol !== PROTOCOL) return;
    if (packet.deviceId === getDeviceId()) return;
    const ip = res.remoteInfo && res.remoteInfo.address;
    if (!ip) return;

    if (packet.action === MSG.PING) {
      this._upsert(ip, packet);
      try {
        this._socket.send({
          address: ip,
          port: res.remoteInfo.port || UDP_PORT,
          message: this._selfPacket(MSG.PONG),
        });
      } catch (e) {}
    } else if (packet.action === MSG.PONG) {
      this._upsert(ip, packet);
    }
  }

  _upsert(ip, packet) {
    const existed = this._devices.has(ip);
    this._devices.set(ip, {
      ip,
      deviceId: packet.deviceId,
      deviceName: packet.deviceName || '未知设备',
      deviceType: packet.deviceType || 'Unknown',
      tcpPort: packet.tcpPort || TCP_PORT,
      lastSeen: Date.now(),
    });
    if (!existed) this._emitDevices();
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    this._devices.forEach((dev, ip) => {
      if (now - dev.lastSeen > DEVICE_TTL) {
        this._devices.delete(ip);
        changed = true;
      }
    });
    if (changed) this._emitDevices();
  }

  _emitDevices() {
    const list = Array.from(this._devices.values()).sort((a, b) => a.ip.localeCompare(b.ip));
    this.emit('devices', list);
  }

  getDevices() {
    return Array.from(this._devices.values());
  }
}
