import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import LanCore from '../../utils/lan/core';
import { getDeviceName, setDeviceName, getDeviceType, getLocalIp, getWifiSsid } from '../../utils/lan/device';
import { formatBytes, formatSpeed, formatEta, fileIconInfo, isImageFile } from '../../utils/format';
import { SCAN_EMPTY_TIMEOUT } from '../../utils/lan/constants';

Page({
  data: {
    deviceName: '',
    deviceType: '',
    ip: '获取中...',
    ssid: '获取中...',
    devices: [],
    scanHint: '',
    pickerVisible: false,
    authVisible: false,
    targetDevice: {},
    selectedFiles: [],
    totalSizeText: '0 B',
    transferVisible: false,
    transfer: {
      role: 'send',
      peerText: '',
      statusText: '',
      speedText: '0 B/s',
      etaText: '--',
      percent: 0,
      filePercent: 0,
      currentName: '',
      doneFiles: 0,
      totalFiles: 0,
    },
  },

  onLoad() {
    LanCore.init();
    this._scanTimer = null;
    this._bindCoreEvents();
    this._refreshSelfInfo();
    this._markScanning();
  },

  onReady() {
    this._initRadar();
  },

  onUnload() {
    this._unbindCoreEvents();
    if (this._scanTimer) clearTimeout(this._scanTimer);
    if (this._rafId && this._canvas) this._canvas.cancelAnimationFrame(this._rafId);
  },

  _bindCoreEvents() {
    this._handlers = {
      devices: (list) => this._onDevices(list),
      request: (payload) => this._onTransferRequest(payload),
      recvProgress: (p) => this._onProgress('recv', p),
      recvDone: (d) => this._onRecvDone(d),
      recvError: (e) => this._onTransferError(e),
      sendStatus: (text) => this.setData({ 'transfer.statusText': text }),
      sendProgress: (p) => this._onProgress('send', p),
      sendDone: () => this._onSendDone(),
      sendError: (e) => this._onTransferError(e),
      localNetworkDenied: () => this._onLocalNetworkDenied(),
    };
    Object.keys(this._handlers).forEach((name) => LanCore.on(name, this._handlers[name]));
  },

  _unbindCoreEvents() {
    if (!this._handlers) return;
    Object.keys(this._handlers).forEach((name) => LanCore.off(name, this._handlers[name]));
  },

  _refreshSelfInfo() {
    this.setData({ deviceName: getDeviceName(), deviceType: getDeviceType() });
    getLocalIp().then((ip) => this.setData({ ip }));
    getWifiSsid().then((ssid) => this.setData({ ssid }));
  },

  _onDevices(list) {
    this.setData({ devices: list });
    if (list.length && this.data.scanHint) {
      this.setData({ scanHint: '' });
    }
    this._syncRadarDots();
  },

  _markScanning() {
    if (this._scanTimer) clearTimeout(this._scanTimer);
    this.setData({ scanHint: '' });
    this._scanTimer = setTimeout(() => {
      if (!this.data.devices.length) {
        this.setData({
          scanHint: '未发现局域网设备, 请检查路由器是否开启了 AP 隔离或允许局域网互联',
        });
      }
    }, SCAN_EMPTY_TIMEOUT);
  },

  onRescan() {
    LanCore.rescan();
    this._refreshSelfInfo();
    this._markScanning();
    Toast({ context: this, selector: '#t-toast', message: '正在重新扫描', theme: 'loading', duration: 1200 });
  },

  // ---------- 设备名修改 ----------
  // 使用原生可输入模态框, 规避弹层内嵌套 input 的事件兼容问题
  onRenameTap() {
    wx.showModal({
      title: '修改设备名',
      editable: true,
      placeholderText: '请输入新的设备名',
      content: this.data.deviceName,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim().slice(0, 24);
        if (!name) {
          Toast({ context: this, selector: '#t-toast', message: '设备名不能为空', theme: 'warning' });
          return;
        }
        setDeviceName(name);
        this.setData({ deviceName: name });
        LanCore.rescan();
        Toast({ context: this, selector: '#t-toast', message: '设备名已更新', theme: 'success' });
      },
    });
  },

  // ---------- 文件选择 ----------
  onPickTarget(e) {
    const device = this.data.devices[e.currentTarget.dataset.index];
    if (!device) return;
    this.setData({ targetDevice: device, pickerVisible: true, selectedFiles: [], totalSizeText: '0 B' });
  },

  onClosePicker() {
    this.setData({ pickerVisible: false });
  },

  onPickerVisibleChange(e) {
    this.setData({ pickerVisible: e.detail.visible });
  },

  onChooseMessageFile() {
    wx.chooseMessageFile({
      count: 20,
      type: 'file',
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => this._normalizeFile(f.path, f.name, f.size));
        this._appendFiles(files);
      },
      fail: () => {},
    });
  },

  onChooseMedia() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      sourceType: ['album'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f, i) => {
          const ext = (f.tempFilePath.split('.').pop() || (f.fileType === 'video' ? 'mp4' : 'jpg')).toLowerCase();
          const prefix = f.fileType === 'video' ? 'VIDEO' : 'IMG';
          const name = `${prefix}_${Date.now()}_${i}.${ext}`;
          return this._normalizeFile(f.tempFilePath, name, f.size);
        });
        this._appendFiles(files);
      },
      fail: () => {},
    });
  },

  _normalizeFile(path, name, size) {
    const { icon, color } = fileIconInfo(name);
    return { path, name, size, icon, iconColor: color, sizeText: formatBytes(size) };
  },

  _appendFiles(files) {
    const exist = this.data.selectedFiles;
    const keys = new Set(exist.map((f) => `${f.path}|${f.size}`));
    const added = files.filter((f) => !keys.has(`${f.path}|${f.size}`));
    const selectedFiles = exist.concat(added);
    this.setData({ selectedFiles, totalSizeText: this._totalText(selectedFiles) });
  },

  onRemoveFile(e) {
    const idx = e.currentTarget.dataset.index;
    const selectedFiles = this.data.selectedFiles.slice();
    selectedFiles.splice(idx, 1);
    this.setData({ selectedFiles, totalSizeText: this._totalText(selectedFiles) });
  },

  _totalText(files) {
    return formatBytes(files.reduce((sum, f) => sum + f.size, 0));
  },

  // ---------- 发送流程 ----------
  onConfirmSend() {
    const { selectedFiles, targetDevice } = this.data;
    if (!selectedFiles.length) {
      Toast({ context: this, selector: '#t-toast', message: '请先选择要发送的文件', theme: 'warning' });
      return;
    }
    const result = LanCore.sendFiles(targetDevice, selectedFiles);
    if (!result.ok) {
      Toast({ context: this, selector: '#t-toast', message: result.message, theme: 'warning' });
      return;
    }
    this.setData({
      pickerVisible: false,
      transferVisible: true,
      transfer: this._baseTransfer('send', `发送至 ${targetDevice.deviceName} (${targetDevice.ip})`, selectedFiles.length),
    });
  },

  _baseTransfer(role, peerText, totalFiles) {
    return {
      role,
      peerText,
      statusText: role === 'send' ? '正在建立连接...' : '准备接收...',
      speedText: '0 B/s',
      etaText: '--',
      percent: 0,
      filePercent: 0,
      currentName: '',
      doneFiles: 0,
      totalFiles,
    };
  },

  _onProgress(role, p) {
    if (!this.data.transferVisible) return;
    this.setData({
      transfer: {
        ...this.data.transfer,
        role,
        statusText: '',
        speedText: formatSpeed(p.speedBps || 0),
        etaText: formatEta(p.etaSec),
        percent: Math.min(100, Math.floor((p.percent || 0) * 100)),
        filePercent: Math.min(100, Math.floor((p.filePercent || 0) * 100)),
        currentName: p.currentName || '',
        doneFiles: p.doneFiles || 0,
        totalFiles: p.totalFiles || this.data.transfer.totalFiles,
      },
    });
  },

  _onSendDone() {
    this.setData({ transferVisible: false, selectedFiles: [] });
    Toast({ context: this, selector: '#t-toast', message: '发送完成', theme: 'success' });
  },

  _onRecvDone(d) {
    Toast({ context: this, selector: '#t-toast', message: '接收完成', theme: 'success' });
    const files = d.files || [];
    if (!files.length) {
      this.setData({ transferVisible: false });
      return;
    }
    const first = files[0];
    const bad = files.filter((f) => !f.verifyOk).length;
    const content =
      `已保存 ${files.length} 个文件至小程序目录` +
      (bad ? `, 其中 ${bad} 个文件校验未通过` : '') +
      `, 首个文件: ${first.name}`;
    this.setData({ transferVisible: false, authVisible: true });
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '接收完成',
      content,
      confirmBtn: '打开文件',
      cancelBtn: '完成',
    })
      .then(() => this._openFile(first))
      .catch(() => {})
      .finally(() => {
        this.setData({ authVisible: false });
      });
  },

  _openFile(file) {
    if (isImageFile(file.name)) {
      wx.previewImage({ urls: [file.path], fail: () => {} });
      return;
    }
    wx.openDocument({
      filePath: file.path,
      showMenu: true,
      fail: () => {
        Toast({ context: this, selector: '#t-toast', message: '该文件类型暂不支持预览', theme: 'warning' });
      },
    });
  },

  _onTransferError(e) {
    this.setData({ transferVisible: false });
    Toast({
      context: this,
      selector: '#t-toast',
      message: (e && e.message) || '传输失败',
      theme: e && e.canceled ? 'warning' : 'error',
      duration: 2500,
    });
  },

  // ---------- 接收授权 ----------
  _onTransferRequest({ meta, session }) {
    this._pendingSession = session;
    const content = `设备 [${meta.deviceName}] (${meta.ip}) 请求向您发送 ${meta.totalFiles} 个文件, 共计 ${formatBytes(
      meta.totalSize,
    )}`;
    // canvas 为原生组件, 层级高于弹窗, 弹窗期间隐藏雷达避免遮挡
    this.setData({ authVisible: true });
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '收到局域网文件传输请求',
      content,
      confirmBtn: { content: '同意接收', theme: 'primary' },
      cancelBtn: { content: '拒绝', theme: 'default' },
    })
      .then(() => {
        session.accept();
        this.setData({
          transferVisible: true,
          transfer: this._baseTransfer('recv', `来自 ${meta.deviceName} (${meta.ip})`, meta.totalFiles),
        });
      })
      .catch(() => {
        session.reject();
      })
      .finally(() => {
        this.setData({ authVisible: false });
      });
  },

  _onLocalNetworkDenied() {
    this.setData({ authVisible: true });
    Dialog.alert({
      context: this,
      selector: '#t-dialog',
      title: '本地网络权限受限',
      content: '请在系统设置中为微信开启"本地网络"权限, 否则无法发现局域网设备',
      confirmBtn: '我知道了',
    }).finally(() => {
      this.setData({ authVisible: false });
    });
  },

  // ---------- 取消传输 ----------
  onCancelTransfer() {
    Dialog.confirm({
      context: this,
      selector: '#t-dialog',
      title: '取消传输',
      content: '确定要中断当前的文件传输吗?',
      confirmBtn: { content: '取消传输', theme: 'danger' },
      cancelBtn: '继续传输',
    })
      .then(() => {
        LanCore.cancelTransfer();
      })
      .catch(() => {});
  },

  // ---------- 雷达动画 (Canvas 2D) ----------
  _initRadar() {
    wx.createSelectorQuery()
      .select('#radarCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2;
        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        ctx.scale(dpr, dpr);
        this._canvas = canvas;
        this._radar = { ctx, size: res[0].width, angle: 0, pulses: [0, 0.33, 0.66] };
        this._syncRadarDots();
        this._radarLoop();
      });
  },

  _syncRadarDots() {
    // 依据 IP 生成稳定的雷达落点
    this._dots = this.data.devices.map((d) => {
      let hash = 0;
      for (let i = 0; i < d.ip.length; i++) hash = (hash * 31 + d.ip.charCodeAt(i)) >>> 0;
      const angle = ((hash % 360) * Math.PI) / 180;
      const radius = 0.35 + ((hash >> 8) % 50) / 100;
      return { angle, radius };
    });
  },

  _radarLoop() {
    if (!this._canvas || !this._radar) return;
    // 弹层展示期间画布被隐藏 (原生组件层级最高, 避免遮挡弹窗), 暂停绘制
    if (this.data.pickerVisible || this.data.transferVisible || this.data.authVisible) {
      this._rafId = this._canvas.requestAnimationFrame(() => this._radarLoop());
      return;
    }
    const { ctx, size } = this._radar;
    const c = size / 2;
    const R = c - 4;
    ctx.clearRect(0, 0, size, size);

    // 底色圆盘
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fillStyle = '#0a2463';
    ctx.fill();

    // 同心圆
    ctx.strokeStyle = 'rgba(97, 141, 255, 0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(c, c, (R * i) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 十字线
    ctx.beginPath();
    ctx.moveTo(c - R, c);
    ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R);
    ctx.lineTo(c, c + R);
    ctx.strokeStyle = 'rgba(97, 141, 255, 0.25)';
    ctx.stroke();

    // 旋转扫描扇形 (多段递减透明度模拟渐变)
    const sweep = Math.PI / 3;
    const segments = 24;
    for (let i = 0; i < segments; i++) {
      const a0 = this._radar.angle - sweep + (sweep * i) / segments;
      const a1 = this._radar.angle - sweep + (sweep * (i + 1)) / segments;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = `rgba(54, 110, 244, ${(0.35 * (i + 1)) / segments})`;
      ctx.fill();
    }
    // 扫描前沿
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + R * Math.cos(this._radar.angle), c + R * Math.sin(this._radar.angle));
    ctx.strokeStyle = '#8eabff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 脉冲波纹
    this._radar.pulses = this._radar.pulses.map((t) => (t + 0.004) % 1);
    this._radar.pulses.forEach((t) => {
      ctx.beginPath();
      ctx.arc(c, c, R * t, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(142, 171, 255, ${0.5 * (1 - t)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // 在线设备落点
    (this._dots || []).forEach((dot) => {
      const x = c + R * dot.radius * Math.cos(dot.angle);
      const y = c + R * dot.radius * Math.sin(dot.angle);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#37d67a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(55, 214, 122, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    this._radar.angle = (this._radar.angle + 0.02) % (Math.PI * 2);
    this._rafId = this._canvas.requestAnimationFrame(() => this._radarLoop());
  },
});
