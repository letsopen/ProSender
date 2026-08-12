import Emitter from './emitter';
import Discovery from './discovery';
import SenderSession from './sender';
import ReceiverSession from './receiver';
import { TCP_PORT, TEMP_TTL } from './constants';

const fsm = wx.getFileSystemManager();

// LAN 核心协调器 (单例): 管理 UDP 发现, TCP 服务监听, 收发会话生命周期
class LanCore extends Emitter {
  constructor() {
    super();
    this._inited = false;
    this.discovery = new Discovery();
    this._server = null;
    this._sender = null;
    this._receiver = null;
  }

  init() {
    if (this._inited) return;
    this._inited = true;
    this._cleanupTempFiles();
    this._checkLocalNetworkPermission();
    this._wireDiscovery();
    this.discovery.start();
    this._startTcpServer();
  }

  _wireDiscovery() {
    this.discovery.on('devices', (list) => this.emit('devices', list));
    this.discovery.on('error', (err) => this.emit('discoveryError', err));
  }

  rescan() {
    if (!this.discovery.running) {
      this.discovery.start();
    }
    this.discovery.ping();
  }

  _startTcpServer() {
    if (!wx.createTCPServer) {
      console.warn('[lan] createTCPServer unsupported, receiving disabled');
      return;
    }
    try {
      this._server = wx.createTCPServer();
      this._server.onConnect((res) => {
        if (this._receiver) {
          // 同一时刻仅处理一个接收会话
          try {
            res.socket.close();
          } catch (e) {}
          return;
        }
        const session = new ReceiverSession(res.socket, res.remoteInfo || {});
        this._receiver = session;
        session.on('request', (payload) => this.emit('request', payload));
        session.on('progress', (p) => this.emit('recvProgress', p));
        session.on('done', (d) => {
          this._receiver = null;
          this.emit('recvDone', d);
        });
        session.on('error', (e) => {
          this._receiver = null;
          this.emit('recvError', e);
        });
      });
      this._server.onError((err) => {
        console.warn('[lan] tcp server error', err);
      });
      this._server.listen(TCP_PORT);
    } catch (e) {
      console.error('[lan] tcp server init failed', e);
    }
  }

  // 发送端入口: target = {ip, tcpPort, deviceName}, files = [{path, name, size}]
  sendFiles(target, files) {
    if (this._sender) {
      return { ok: false, message: '当前存在进行中的发送任务' };
    }
    const session = new SenderSession(target, files);
    this._sender = session;
    session.on('status', (text) => this.emit('sendStatus', text));
    session.on('progress', (p) => this.emit('sendProgress', p));
    session.on('done', (d) => {
      this._sender = null;
      this.emit('sendDone', d);
    });
    session.on('error', (e) => {
      this._sender = null;
      this.emit('sendError', e);
    });
    session.start();
    return { ok: true, session };
  }

  cancelTransfer() {
    if (this._sender) this._sender.cancel();
    if (this._receiver) this._receiver.cancel();
  }

  get busy() {
    return !!(this._sender || this._receiver);
  }

  // iOS 本地网络权限探测: 失败时引导用户前往系统设置
  _checkLocalNetworkPermission() {
    if (!wx.startLocalServiceDiscovery) return;
    try {
      wx.startLocalServiceDiscovery({
        serviceType: '_lantransfer._udp.',
        success: () => {
          wx.stopLocalServiceDiscovery({ serviceType: '_lantransfer._udp.', complete: () => {} });
        },
        fail: (err) => {
          const msg = (err && err.errMsg) || '';
          if (/deny|permission|auth/i.test(msg)) {
            this.emit('localNetworkDenied', err);
          }
        },
      });
    } catch (e) {}
  }

  // 清理超过 24h 的 temp_* 临时切片缓存
  _cleanupTempFiles() {
    try {
      const dir = wx.env.USER_DATA_PATH;
      const files = fsm.readdirSync(dir) || [];
      const now = Date.now();
      files.forEach((name) => {
        if (!name.startsWith('temp_')) return;
        const fullPath = `${dir}/${name}`;
        try {
          const stat = fsm.statSync(fullPath);
          const mtime = (stat.lastModifiedTime || 0) * 1000;
          if (now - mtime > TEMP_TTL) {
            fsm.unlinkSync(fullPath);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }
}

export default new LanCore();
