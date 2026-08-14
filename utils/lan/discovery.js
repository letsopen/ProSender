import Emitter from './emitter';
import { PROTOCOL, UDP_PORT, BROADCAST_ADDR, MSG, PING_INTERVAL, DEVICE_TTL, SUBNET_SCAN_INTERVAL } from './constants';
import { getDeviceId, getDeviceName, getDeviceType, getLocalIps, subnetOf, isPrivateIp } from './device';

// 最多跟踪的网段数, 防止异常网络环境下扫描面失控
const MAX_SUBNETS = 8;

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
    this._learnedSubnets = new Set(); // 本机各网卡网段 + 对端报文学习到的网段
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
    this.scanSubnets();
    this._pingTimer = setInterval(() => this.ping(), PING_INTERVAL);
    this._scanTimer = setInterval(() => this.scanSubnets(), SUBNET_SCAN_INTERVAL);
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

  // 多网段子网轮扫: 本机所有网卡的 /24 + 学习到的对端网段, 逐个 C 段串行扫描
  async scanSubnets() {
    if (this._scanning) return;
    const ips = await getLocalIps();
    const selfSet = new Set(ips);
    ips.forEach((ip) => {
      const s = subnetOf(ip);
      if (s) this._learnedSubnets.add(s);
    });
    const subnets = Array.from(this._learnedSubnets).slice(0, MAX_SUBNETS);
    if (!subnets.length) return;
    this._scanning = true;
    let si = 0;
    let host = 1;
    const timer = setInterval(() => {
      if (!this._running) {
        clearInterval(timer);
        this._scanning = false;
        return;
      }
      // 每 tick 发 16 台, 避免瞬时洪泛
      for (let k = 0; k < 16 && si < subnets.length; k++) {
        const target = `${subnets[si]}.${host}`;
        host += 1;
        if (host > 254) {
          si += 1;
          host = 1;
        }
        if (selfSet.has(target)) continue;
        this._link.send(this._selfPacket(MSG.PING), target, UDP_PORT);
      }
      if (si >= subnets.length) {
        clearInterval(timer);
        this._scanning = false;
      }
    }, 50);
  }

  _handle(ip, obj) {
    if (!ip) return;
    if (obj.deviceId === getDeviceId()) return;
    // 网段学习: 对端报文来自未知私网网段时, 纳入扫描范围 (多网段路由互通场景)
    if (isPrivateIp(ip)) {
      const s = subnetOf(ip);
      if (s && !this._learnedSubnets.has(s) && this._learnedSubnets.size < MAX_SUBNETS) {
        this._learnedSubnets.add(s);
        this.scanSubnets();
      }
    }
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
      subnet: subnetOf(ip) || '未知网段',
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
