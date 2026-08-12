export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m} 分 ${s} 秒`;
}

// 按扩展名映射 TDesign 图标与主题色
export function fileIconInfo(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: { icon: 'file-pdf', color: '#d54941' },
    doc: { icon: 'file-word', color: '#0052d9' },
    docx: { icon: 'file-word', color: '#0052d9' },
    xls: { icon: 'file-excel', color: '#2ba471' },
    xlsx: { icon: 'file-excel', color: '#2ba471' },
    csv: { icon: 'file-excel', color: '#2ba471' },
    ppt: { icon: 'file-powerpoint', color: '#e37318' },
    pptx: { icon: 'file-powerpoint', color: '#e37318' },
    zip: { icon: 'file-zip', color: '#8b5cf6' },
    rar: { icon: 'file-zip', color: '#8b5cf6' },
    '7z': { icon: 'file-zip', color: '#8b5cf6' },
    jpg: { icon: 'file-image', color: '#0594fa' },
    jpeg: { icon: 'file-image', color: '#0594fa' },
    png: { icon: 'file-image', color: '#0594fa' },
    gif: { icon: 'file-image', color: '#0594fa' },
    webp: { icon: 'file-image', color: '#0594fa' },
    mp4: { icon: 'video', color: '#e37318' },
    mov: { icon: 'video', color: '#e37318' },
    avi: { icon: 'video', color: '#e37318' },
    mkv: { icon: 'video', color: '#e37318' },
    mp3: { icon: 'music', color: '#2ba471' },
    wav: { icon: 'music', color: '#2ba471' },
    flac: { icon: 'music', color: '#2ba471' },
  };
  return map[ext] || { icon: 'file-unknown', color: '#8b8b8b' };
}

export function isImageFile(fileName) {
  return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(fileName);
}
