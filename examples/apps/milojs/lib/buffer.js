// node:buffer — a Buffer backed by a plain array of byte values.
//
// There are no typed arrays in the engine, so this is not a real Uint8Array
// subclass; it carries its bytes in `.bytes` and implements the surface express,
// body-parser and node-fetch actually touch. Buffer.byteLength in particular is
// on the path of every response that sets Content-Length.

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// milojs strings are UTF-8 byte buffers, so charCodeAt already yields a byte and
// the string is its own encoding. Re-encoding here would double-encode anything
// non-ASCII — "h\u00e9llo" would measure 8 bytes instead of 6.
// Real UTF-8, not a latin1 truncation. This used to be `charCodeAt(i) & 0xff`,
// which happened to work only while engine strings were byte-indexed; once
// charCodeAt returned proper UTF-16 units it silently mangled anything non-ASCII
// (Buffer.byteLength("héllo") gave 5 instead of 6).
function utf8Encode(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    // combine a surrogate pair back into one code point
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function utf8Decode(bytes) {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i] & 0xff;
    var cp, need;
    if (b < 0x80) { cp = b; need = 0; }
    else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; need = 1; }
    else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; need = 2; }
    else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; need = 3; }
    else { out += String.fromCharCode(0xfffd); i++; continue; }
    if (i + need >= bytes.length + 0 && i + need > bytes.length - 1) {
      out += String.fromCharCode(0xfffd);
      break;
    }
    for (var k = 1; k <= need; k++) {
      var cb = bytes[i + k] & 0xff;
      if ((cb & 0xc0) !== 0x80) { cp = 0xfffd; break; }
      cp = (cp << 6) | (cb & 0x3f);
    }
    i += need + 1;
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

function hexDecode(str) {
  var out = [];
  for (var i = 0; i + 1 < str.length; i += 2) out.push(parseInt(str.substr(i, 2), 16));
  return out;
}

function hexEncode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length < 2) h = '0' + h;
    out += h;
  }
  return out;
}

function b64Encode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

function b64Decode(str) {
  var out = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (ch === '=') continue;
    var v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

function decodeTo(bytes, encoding) {
  var enc = (encoding || 'utf8').toLowerCase();
  if (enc === 'hex') return hexEncode(bytes);
  if (enc === 'base64') return b64Encode(bytes);
  if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
    return s;
  }
  return utf8Decode(bytes);
}

function encodeFrom(str, encoding) {
  var enc = (encoding || 'utf8').toLowerCase();
  if (enc === 'hex') return hexDecode(str);
  if (enc === 'base64') return b64Decode(str);
  if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
    var out = [];
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
    return out;
  }
  return utf8Encode(str);
}

function Buffer(bytes) {
  this.bytes = bytes || [];
  this.length = this.bytes.length;
  // non-enumerable marker so the engine can index buf[i] into .bytes without
  // mistaking a user object shaped { bytes, length } for a Buffer
  Object.defineProperty(this, '__isBuf', { value: true, enumerable: false });
}

Buffer.prototype.toString = function (encoding, start, end) {
  var s = start === undefined ? 0 : start;
  var e = end === undefined ? this.bytes.length : end;
  return decodeTo(this.bytes.slice(s, e), encoding);
};
Buffer.prototype.slice = function (start, end) {
  return new Buffer(this.bytes.slice(start, end));
};
Buffer.prototype.toJSON = function () {
  return { type: 'Buffer', data: this.bytes.slice() };
};
Buffer.prototype.equals = function (other) {
  var o = other && other.bytes ? other.bytes : [];
  if (o.length !== this.bytes.length) return false;
  for (var i = 0; i < o.length; i++) if (o[i] !== this.bytes[i]) return false;
  return true;
};
Buffer.prototype.indexOf = function (v) {
  var needle = typeof v === 'string' ? utf8Encode(v) : (v && v.bytes ? v.bytes : [v]);
  for (var i = 0; i + needle.length <= this.bytes.length; i++) {
    var hit = true;
    for (var j = 0; j < needle.length; j++) if (this.bytes[i + j] !== needle[j]) { hit = false; break; }
    if (hit) return i;
  }
  return -1;
};

// --- numeric accessors ------------------------------------------------------
// Integer read/write (LE/BE, 8/16/32-bit + the generic byte-length forms binary
// protocol code uses). Values are the plain 0-255 bytes in this.bytes. Up to 48
// bits stays exact in a double, which is node's own limit for the non-Big forms.
function _rdU(bytes, off, len, be) {
  var v = 0;
  for (var i = 0; i < len; i++) v = v * 256 + (bytes[off + (be ? i : len - 1 - i)] & 0xff);
  return v;
}
function _wrU(bytes, val, off, len, be) {
  var v = val;
  for (var i = 0; i < len; i++) { var b = v % 256; bytes[off + (be ? len - 1 - i : i)] = b & 0xff; v = Math.floor(v / 256); }
  return off + len;
}
function _sgn(v, bits) { var m = Math.pow(2, bits); return v >= m / 2 ? v - m : v; }

Buffer.prototype.readUInt8 = function (o) { return this.bytes[o || 0] & 0xff; };
Buffer.prototype.readUInt16BE = function (o) { return _rdU(this.bytes, o || 0, 2, true); };
Buffer.prototype.readUInt16LE = function (o) { return _rdU(this.bytes, o || 0, 2, false); };
Buffer.prototype.readUInt32BE = function (o) { return _rdU(this.bytes, o || 0, 4, true); };
Buffer.prototype.readUInt32LE = function (o) { return _rdU(this.bytes, o || 0, 4, false); };
Buffer.prototype.readUIntBE = function (o, len) { return _rdU(this.bytes, o || 0, len, true); };
Buffer.prototype.readUIntLE = function (o, len) { return _rdU(this.bytes, o || 0, len, false); };
Buffer.prototype.readInt8 = function (o) { return _sgn(this.bytes[o || 0] & 0xff, 8); };
Buffer.prototype.readInt16BE = function (o) { return _sgn(_rdU(this.bytes, o || 0, 2, true), 16); };
Buffer.prototype.readInt16LE = function (o) { return _sgn(_rdU(this.bytes, o || 0, 2, false), 16); };
Buffer.prototype.readInt32BE = function (o) { return _sgn(_rdU(this.bytes, o || 0, 4, true), 32); };
Buffer.prototype.readInt32LE = function (o) { return _sgn(_rdU(this.bytes, o || 0, 4, false), 32); };
Buffer.prototype.writeUInt8 = function (v, o) { o = o || 0; this.bytes[o] = v & 0xff; return o + 1; };
Buffer.prototype.writeUInt16BE = function (v, o) { return _wrU(this.bytes, v, o || 0, 2, true); };
Buffer.prototype.writeUInt16LE = function (v, o) { return _wrU(this.bytes, v, o || 0, 2, false); };
Buffer.prototype.writeUInt32BE = function (v, o) { return _wrU(this.bytes, v, o || 0, 4, true); };
Buffer.prototype.writeUInt32LE = function (v, o) { return _wrU(this.bytes, v, o || 0, 4, false); };
Buffer.prototype.writeUIntBE = function (v, o, len) { return _wrU(this.bytes, v, o || 0, len, true); };
Buffer.prototype.writeUIntLE = function (v, o, len) { return _wrU(this.bytes, v, o || 0, len, false); };
Buffer.prototype.writeInt8 = function (v, o) { o = o || 0; this.bytes[o] = v & 0xff; return o + 1; };
Buffer.prototype.writeInt16BE = function (v, o) { return _wrU(this.bytes, v < 0 ? v + 0x10000 : v, o || 0, 2, true); };
Buffer.prototype.writeInt16LE = function (v, o) { return _wrU(this.bytes, v < 0 ? v + 0x10000 : v, o || 0, 2, false); };
Buffer.prototype.writeInt32BE = function (v, o) { return _wrU(this.bytes, v < 0 ? v + 0x100000000 : v, o || 0, 4, true); };
Buffer.prototype.writeInt32LE = function (v, o) { return _wrU(this.bytes, v < 0 ? v + 0x100000000 : v, o || 0, 4, false); };

Buffer.prototype.fill = function (val, start, end) {
  var s = start || 0, e = end === undefined ? this.bytes.length : end;
  var b = typeof val === 'number' ? (val & 0xff) : (utf8Encode(String(val))[0] || 0);
  for (var i = s; i < e; i++) this.bytes[i] = b;
  return this;
};
Buffer.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
  var ts = targetStart || 0, ss = sourceStart || 0, se = sourceEnd === undefined ? this.bytes.length : sourceEnd;
  var n = 0;
  for (var i = ss; i < se; i++) { target.bytes[ts + n] = this.bytes[i]; n++; }
  if (target.bytes.length > target.length) target.length = target.bytes.length;
  return n;
};
Buffer.prototype.subarray = function (start, end) { return new Buffer(this.bytes.slice(start, end)); };
Buffer.prototype.includes = function (v) { return this.indexOf(v) >= 0; };
// iterable over its bytes, like a Uint8Array: [...buf], for-of, Array.from(buf).
// The returned iterators are self-iterable (Symbol.iterator returns this) so
// [...buf.keys()] and for-of over them work too.
function bufIter(next) {
  var it = { next: next };
  it[Symbol.iterator] = function () { return this; };
  return it;
}
Buffer.prototype[Symbol.iterator] = function () {
  var self = this, i = 0;
  return bufIter(function () { return i < self.bytes.length ? { value: self.bytes[i++], done: false } : { value: undefined, done: true }; });
};
Buffer.prototype.values = function () { return this[Symbol.iterator](); };
Buffer.prototype.keys = function () {
  var self = this, i = 0;
  return bufIter(function () { return i < self.bytes.length ? { value: i++, done: false } : { value: undefined, done: true }; });
};
Buffer.prototype.entries = function () {
  var self = this, i = 0;
  return bufIter(function () { return i < self.bytes.length ? { value: [i, self.bytes[i++]], done: false } : { value: undefined, done: true }; });
};
Buffer.prototype.write = function (str, offset, length, encoding) {
  var off = typeof offset === 'number' ? offset : 0;
  var enc = typeof offset === 'string' ? offset : (typeof length === 'string' ? length : encoding);
  var enc2 = enc || 'utf8';
  var src = encodeFrom(str, enc2);
  var max = typeof length === 'number' ? length : src.length;
  var n = 0;
  for (var i = 0; i < src.length && n < max; i++) { this.bytes[off + n] = src[i]; n++; }
  return n;
};

Buffer.from = function (value, encoding) {
  if (typeof value === 'string') return new Buffer(encodeFrom(value, encoding));
  if (value && value.bytes) return new Buffer(value.bytes.slice());
  if (Array.isArray(value)) {
    var copy = [];
    for (var i = 0; i < value.length; i++) copy.push(value[i] & 0xff);
    return new Buffer(copy);
  }
  return new Buffer([]);
};

Buffer.alloc = function (size, fill) {
  var out = [];
  var f = typeof fill === 'number' ? (fill & 0xff) : 0;
  for (var i = 0; i < size; i++) out.push(f);
  return new Buffer(out);
};

Buffer.concat = function (list, totalLength) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    var bytes = b && b.bytes ? b.bytes : (typeof b === 'string' ? utf8Encode(b) : []);
    for (var j = 0; j < bytes.length; j++) out.push(bytes[j]);
  }
  if (typeof totalLength === 'number' && totalLength < out.length) out = out.slice(0, totalLength);
  return new Buffer(out);
};

Buffer.byteLength = function (value, encoding) {
  if (value && value.bytes) return value.bytes.length;
  if (typeof value !== 'string') return 0;
  // An engine string already IS its UTF-8 bytes, so ask for that count directly.
  // Round-tripping through charCodeAt loses data on any byte that isn't valid
  // UTF-8: binary decodes to U+FFFD and re-encodes to 3 bytes, so a 48KB font
  // measured 90KB. Only fall back to re-encoding for a declared text encoding.
  if (encoding === undefined || encoding === null || encoding === 'utf8' || encoding === 'utf-8') {
    return __byteLength(value);
  }
  return encodeFrom(value, encoding).length;
};

Buffer.isBuffer = function (v) { return !!(v && v.bytes && typeof v.length === 'number'); };

// safe-buffer takes its pass-through path only when all four exist; otherwise it
// rebuilds Buffer via for-in copyProps, which drops the static methods here
Buffer.allocUnsafe = function (size) { return Buffer.alloc(size); };
Buffer.allocUnsafeSlow = function (size) { return Buffer.alloc(size); };
Buffer.isEncoding = function (enc) {
  var e = String(enc).toLowerCase();
  return e === 'utf8' || e === 'utf-8' || e === 'hex' || e === 'base64' || e === 'ascii' || e === 'latin1' || e === 'binary';
};
Buffer.compare = function (a, b) {
  var x = a && a.bytes ? a.bytes : [], y = b && b.bytes ? b.bytes : [];
  for (var i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
};

exports.Buffer = Buffer;
exports.kMaxLength = 2147483647;
exports.constants = { MAX_LENGTH: 2147483647, MAX_STRING_LENGTH: 536870888 };
