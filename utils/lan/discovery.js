import Emitter from './emitter';
import { PROTOCOL, UDP_PORT, BROADCAST_ADDR, MSG, PING_INTERVAL, DEVICE_TTL, SUBNET_SCAN_INTERVAL } from './constants';
import { getDeviceId, getDeviceName, getDeviceType, getLocalIp } from './device';

// UDP 设备发现: 广播 + 子网单播轮扫双通道 (真机普遍丢弃广播包, 单播全平台可靠)
// 收到 PING 回 PONG 并互相收录, 10s 无心跳剔除
export default class Discovery extends Emitter {
  constructor(link) {
    super();
    this._link = link;
    this._devices = new Map();
    this._pingTimer = null;
    this._ttlTimer = null;
    this._scanTimer = null;
    this._scanning = false;
    this._running = false;
    this._onPacket = ({ ip, obj }) => this._handle(ip, obj);
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._link.on('packet', this._onPacket);
    this.ping();
    this.scanSubnet();
    this._pingTimer = setInterval(() => this.ping(), PING_INTERVAL);
    this._scanTimer = setInterval(() => this.scanSubnet(), SUBNET_SCAN_INTERVAL);
    this._ttlTimer = setInterval(() => this._sweep(), 2000);
  }

  stop() {
    this._running = false;
    this._link.off('packet', this._onPacket);
    [this._pingTimer, this._ttlTimer, this._scanTimer].forEach((t) => t && clearInterval(t));
    this._pingTimer = this._ttlTimer = this._scanTimer = null;
    this._devices.clear();
    this.emit('devices', []);
  }

  _selfPacket(action) {
    return {
      protocol: PROTOCOL,
      action,
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
      deviceType: getDeviceType(),
      udpPort: UDP_PORT,
      timestamp: Date.now(),
    };
  }

  // 广播发现 (对开发者工具/PC 端有效)
  ping() {
    this._link.send(this._selfPacket(MSG.PING), BROADCAST_ADDR, UDP_PORT);
  }

  // 子网 /24 单播轮扫 (对真机有效), 每 tick 发 16 台, 避免瞬时洪泛
  async scanSubnet() {
    if (this._scanning) return;
    const ip = await getLocalIp();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
    this._scanning = true;
    const prefix = ip.split('.').slice(0, 3).join('.');
    let host = 1;
    const timer = setInterval(() => {
      if (!this._running) {
        clearInterval(timer);
        this._scanning = false;
        return;
      }
      for (let k = 0; k < 16 && host <= 254; k++, host++) {
        const target = `${prefix}.${host}`;
        if (target === ip) continue;
        this._link.send(this._selfPacket(MSG.PING), target, UDP_PORT);
      }
      if (host > 254) {
        clearInterval(timer);
        this._scanning = false;
      }
    }, 50);
  }

  _handle(ip, obj) {
    if (!ip) return;
    if (obj.deviceId === getDeviceId()) return;
    if (obj.action === MSG.PING) {
      this._upsert(ip, obj);
      this._link.send(this._selfPacket(MSG.PONG), ip, UDP_PORT);
    } else if (obj.action === MSG.PONG) {
      this._upsert(ip, obj);
    }
  }

  _upsert(ip, packet) {
    const prev = this._devices.get(ip);
    const deviceName = packet.deviceName || '未知设备';
    const deviceType = packet.deviceType || 'Unknown';
    this._devices.set(ip, {
      ip,
      deviceId: packet.deviceId,
      deviceName,
      deviceType,
      udpPort: packet.udpPort || UDP_PORT,
      lastSeen: Date.now(),
    });
    // 新设备上线或设备信息变更 (如改名) 时, 均需刷新 UI 列表
    if (!prev || prev.deviceName !== deviceName || prev.deviceType !== deviceType) {
      this._emitDevices();
    }
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
