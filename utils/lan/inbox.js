import { formatBytes, fileIconInfo } from '../format';

const fsm = wx.getFileSystemManager();

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// 扫描接收目录 (recv_* 文件), 按时间倒序返回展示模型
export function listReceived() {
  const dir = wx.env.USER_DATA_PATH;
  let names = [];
  try {
    names = fsm.readdirSync(dir) || [];
  } catch (e) {
    return [];
  }
  const list = [];
  names.forEach((n) => {
    if (!n.startsWith('recv_')) return;
    const fullPath = `${dir}/${n}`;
    try {
      const stat = fsm.statSync(fullPath);
      if (stat.isDirectory && stat.isDirectory()) return;
      const displayName = n.replace(/^recv_[0-9a-f]+_[0-9a-f]+_/, '') || n;
      const mtime = (stat.lastModifiedTime || 0) * 1000;
      const d = new Date(mtime);
      const { icon, color } = fileIconInfo(displayName);
      list.push({
        path: fullPath,
        name: displayName,
        size: stat.size,
        mtime,
        icon,
        iconColor: color,
        sizeText: formatBytes(stat.size),
        timeText: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      });
    } catch (e) {}
  });
  return list.sort((a, b) => b.mtime - a.mtime);
}

export function removeReceived(filePath) {
  return new Promise((resolve) => {
    fsm.unlink({ filePath, success: resolve, fail: resolve });
  });
}
