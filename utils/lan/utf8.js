// 纯 JS UTF-8 编解码 (小程序部分基础库无 TextEncoder)
export function utf8Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export function utf8Decode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let i = 0;
  while (i < view.length) {
    const b = view[i];
    let code;
    if (b < 0x80) {
      code = b;
      i += 1;
    } else if (b < 0xe0) {
      code = ((b & 0x1f) << 6) | (view[i + 1] & 0x3f);
      i += 2;
    } else if (b < 0xf0) {
      code = ((b & 0x0f) << 12) | ((view[i + 1] & 0x3f) << 6) | (view[i + 2] & 0x3f);
      i += 3;
    } else {
      code =
        ((b & 0x07) << 18) |
        ((view[i + 1] & 0x3f) << 12) |
        ((view[i + 2] & 0x3f) << 6) |
        (view[i + 3] & 0x3f);
      i += 4;
    }
    if (code <= 0xffff) {
      out += String.fromCharCode(code);
    } else {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
  }
  return out;
}
