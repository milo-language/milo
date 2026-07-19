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
