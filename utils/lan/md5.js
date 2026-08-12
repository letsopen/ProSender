// 增量式 MD5 (支持分块 update Uint8Array, 用于流式校验)
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
}

function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

export default class Md5 {
  constructor() {
    this.reset();
  }

  reset() {
    this._a0 = 0x67452301;
    this._b0 = 0xefcdab89;
    this._c0 = 0x98badcfe;
    this._d0 = 0x10325476;
    this._buf = new Uint8Array(64);
    this._bufLen = 0;
    this._totalLen = 0;
    return this;
  }

  update(data) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._totalLen += input.length;
    let pos = 0;
    if (this._bufLen > 0) {
      const need = 64 - this._bufLen;
      const take = Math.min(need, input.length);
      this._buf.set(input.subarray(0, take), this._bufLen);
      this._bufLen += take;
      pos += take;
      if (this._bufLen === 64) {
        this._process(this._buf, 0);
        this._bufLen = 0;
      }
    }
    while (pos + 64 <= input.length) {
      this._process(input, pos);
      pos += 64;
    }
    if (pos < input.length) {
      this._buf.set(input.subarray(pos), 0);
      this._bufLen = input.length - pos;
    }
    return this;
  }

  _process(block, offset) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      M[i] = block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24);
    }
    let a = this._a0;
    let b = this._b0;
    let c = this._c0;
    let d = this._d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + M[g]) | 0, S[i])) | 0;
      a = tmp;
    }
    this._a0 = (this._a0 + a) | 0;
    this._b0 = (this._b0 + b) | 0;
    this._c0 = (this._c0 + c) | 0;
    this._d0 = (this._d0 + d) | 0;
  }

  digest() {
    const bitLen = this._totalLen * 8;
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 4294967296) >>> 0;
    this.update(new Uint8Array([0x80]));
    while (this._bufLen !== 56) {
      this.update(new Uint8Array([0]));
    }
    const tail = new Uint8Array(8);
    const dv = new DataView(tail.buffer);
    dv.setUint32(0, lo, true);
    dv.setUint32(4, hi, true);
    this.update(tail);
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, this._a0, true);
    odv.setUint32(4, this._b0, true);
    odv.setUint32(8, this._c0, true);
    odv.setUint32(12, this._d0, true);
    let hex = '';
    for (let i = 0; i < 16; i++) {
      hex += out[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}
