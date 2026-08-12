import { utf8Encode, utf8Decode } from './utf8';

// 帧格式: 4 Bytes header_len (Uint32 BE) + JSON Header (UTF-8) + Raw Payload
export function encodeFrame(headerObj, payload) {
  const headerBytes = utf8Encode(JSON.stringify(headerObj));
  const payloadLen = payload ? payload.byteLength : 0;
  const out = new Uint8Array(4 + headerBytes.length + payloadLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, headerBytes.length, false);
  out.set(headerBytes, 4);
  if (payloadLen > 0) {
    out.set(new Uint8Array(payload), 4 + headerBytes.length);
  }
  return out.buffer;
}

// TCP 流式粘包/半包解析器
export class FrameParser {
  constructor(onFrame) {
    this._buf = new Uint8Array(0);
    this._onFrame = onFrame;
  }

  push(arrayBuffer) {
    const chunk = new Uint8Array(arrayBuffer);
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf, 0);
    merged.set(chunk, this._buf.length);
    this._buf = merged;
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this._buf.length < 4) return;
      const dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.length);
      const headerLen = dv.getUint32(0, false);
      if (headerLen <= 0 || headerLen > 64 * 1024) {
        throw new Error('invalid frame header length');
      }
      if (this._buf.length < 4 + headerLen) return;
      const headerBytes = this._buf.subarray(4, 4 + headerLen);
      let header;
      try {
        header = JSON.parse(utf8Decode(headerBytes));
      } catch (e) {
        throw new Error('invalid frame json header');
      }
      const payloadLen = header.type === 'CHUNK_DATA' ? header.chunkSize || 0 : 0;
      if (this._buf.length < 4 + headerLen + payloadLen) return;
      let payload = null;
      if (payloadLen > 0) {
        payload = this._buf.slice(4 + headerLen, 4 + headerLen + payloadLen).buffer;
      }
      this._buf = this._buf.slice(4 + headerLen + payloadLen);
      this._onFrame(header, payload);
    }
  }

  reset() {
    this._buf = new Uint8Array(0);
  }
}
