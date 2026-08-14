// LAN-Transfer Protocol v2.0 (UDP 全双工, 全平台兼容)
export const PROTOCOL = 'LAN_TRANSFER_V2';

export const UDP_PORT = 8888;
export const BROADCAST_ADDR = '255.255.255.255';

// 数据报文: UDP payload 1024B (含报头整体 < 1300B, 避免 IP 分片)
export const DATA_CHUNK = 1024;
// 发送端每次从磁盘读取 1MB, 拆片发送, 控制内存占用
export const READ_BLOCK = 1024 * 1024;
// 接收端攒批 64KB 落盘一次
export const WRITE_BATCH = 64 * 1024;
// GBN 滑动窗口 (在飞切片数)
export const SEND_WINDOW = 32;
// 最老未确认切片超时重传间隔 (局域网 RTT 极低, 取 250ms)
export const RTO_MS = 250;
// 控制消息重传
export const RETRY_INTERVAL = 600;
export const RETRY_MAX = 8;

export const PING_INTERVAL = 3000;
export const DEVICE_TTL = 10000;
export const SCAN_EMPTY_TIMEOUT = 8000;
export const SUBNET_SCAN_INTERVAL = 15000;
export const ACCEPT_TIMEOUT = 30000;

// 临时文件超过 24h 自动清理
export const TEMP_TTL = 24 * 60 * 60 * 1000;

export const MSG = {
  // 发现
  PING: 'PING',
  PONG: 'PONG',
  // 控制 (可靠, 带 mid, 需 CACK)
  TRANSFER_REQ: 'TRANSFER_REQ',
  TRANSFER_RESP: 'TRANSFER_RESP',
  FILE_HEADER: 'FILE_HEADER',
  FILE_END: 'FILE_END',
  BATCH_END: 'BATCH_END',
  TRANSFER_CANCEL: 'TRANSFER_CANCEL',
  CACK: 'CACK',
  // 数据确认 (非可靠, 丢失由发送端 RTO 兜底)
  DACK: 'DACK',
};

export const RESP_STATUS = {
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  ERROR_INSUFFICIENT_STORAGE: 'ERROR_INSUFFICIENT_STORAGE',
};
