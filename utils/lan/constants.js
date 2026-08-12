// LAN-Transfer Protocol v1.0 常量定义
export const PROTOCOL = 'LAN_TRANSFER_V1';

export const UDP_PORT = 8888;
export const TCP_PORT = 8889;
export const BROADCAST_ADDR = '255.255.255.255';

// 切片尺寸固定 1MB, 单次内存占用控制在 10MB 以内
export const CHUNK_SIZE = 1024 * 1024;
// 发送窗口: 最多 2 个未确认 Chunk (背压控制)
export const SEND_WINDOW = 2;

export const PING_INTERVAL = 3000;
export const DEVICE_TTL = 10000;
export const SCAN_EMPTY_TIMEOUT = 5000;
export const ACCEPT_TIMEOUT = 20000;

// 临时文件超过 24h 自动清理
export const TEMP_TTL = 24 * 60 * 60 * 1000;

export const MSG = {
  PING: 'PING',
  PONG: 'PONG',
  TRANSFER_REQ: 'TRANSFER_REQ',
  TRANSFER_RESP: 'TRANSFER_RESP',
  FILE_HEADER: 'FILE_HEADER',
  CHUNK_DATA: 'CHUNK_DATA',
  CHUNK_ACK: 'CHUNK_ACK',
  FILE_END: 'FILE_END',
  BATCH_END: 'BATCH_END',
  TRANSFER_CANCEL: 'TRANSFER_CANCEL',
};

export const RESP_STATUS = {
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  ERROR_INSUFFICIENT_STORAGE: 'ERROR_INSUFFICIENT_STORAGE',
};
