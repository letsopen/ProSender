// 本机身份信息管理
const NAME_KEY = 'custom_device_name';
const ID_KEY = 'lan_device_id';

function randomHash(len) {
  let s = '';
  const chars = '0123456789ABCDEF';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * 16)];
  }
  return s;
}

export function getDeviceType() {
  let platform = 'devtools';
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    platform = (info.platform || 'devtools').toLowerCase();
  } catch (e) {
    console.warn('[lan] getDeviceInfo failed', e);
  }
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'ohos' || platform === 'harmonyos') return 'HarmonyOS';
  return 'Devtools';
}

export function getDeviceId() {
  let id = wx.getStorageSync(ID_KEY);
  if (!id) {
    id = `${Date.now().toString(16)}${randomHash(8)}`;
    wx.setStorageSync(ID_KEY, id);
  }
  return id;
}

// 默认命名: [系统平台] + 随机4位hash, 例如 Android_A1F8
export function getDeviceName() {
  let name = wx.getStorageSync(NAME_KEY);
  if (!name) {
    const prefixMap = { iOS: 'iPhone', Android: 'Android', HarmonyOS: 'HarmonyOS', Devtools: 'PC' };
    name = `${prefixMap[getDeviceType()] || 'Device'}_${randomHash(4)}`;
    wx.setStorageSync(NAME_KEY, name);
  }
  return name;
}

export function setDeviceName(name) {
  wx.setStorageSync(NAME_KEY, name);
}

export function getLocalIp() {
  return getLocalIps().then((ips) => ips[0] || '未知');
}

// 获取本机全部局域网 IPv4 (PC 端微信多网卡会返回多个, 以分隔符连接)
export function getLocalIps() {
  return new Promise((resolve) => {
    if (!wx.getLocalIPAddress) {
      resolve([]);
      return;
    }
    wx.getLocalIPAddress({
      success: (res) => {
        const raw = res.localip || '';
        const ips = raw.split(/[,;\s]+/).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
        resolve(ips);
      },
      fail: () => resolve([]),
    });
  });
}

export function subnetOf(ip) {
  const m = String(ip).match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? m[1] : '';
}

export function isPrivateIp(ip) {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip)
  );
}

export function getWifiSsid() {
  return new Promise((resolve) => {
    if (!wx.getConnectedWifi) {
      resolve('未连接');
      return;
    }
    const done = (text) => resolve(text);
    try {
      wx.startWifi({
        success: () => {
          wx.getConnectedWifi({
            success: (res) => done((res.wifi && res.wifi.SSID) || '未知 Wi-Fi'),
            fail: () => done('未授权定位, 无法获取'),
          });
        },
        fail: () => done('Wi-Fi 不可用'),
      });
    } catch (e) {
      done('未知 Wi-Fi');
    }
  });
}
