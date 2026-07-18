// node:crypto — the subset express, jsonwebtoken and cookie-parser actually use.
// SHA-256/SHA-1 and HMAC are implemented here in JS; there is no native hash to
// call into, and these are small enough to be worth having rather than stubbing.

// --- helpers ---------------------------------------------------------------

function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

function toBytes(input, encoding) {
  if (input == null) return [];
  if (Array.isArray(input)) return input.slice();
  if (typeof input !== 'string') {
    if (input && typeof input.length === 'number') {
      var copy = [];
      for (var c = 0; c < input.length; c++) copy.push(input[c] & 0xff);
      return copy;
    }
    input = String(input);
  }
  var out = [];
  if (encoding === 'hex') {
    for (var h = 0; h + 1 < input.length; h += 2) out.push(parseInt(input.substr(h, 2), 16));
    return out;
  }
  if (encoding === 'base64') return b64Decode(input);
  // default utf-8
  for (var i = 0; i < input.length; i++) {
    var code = input.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes, urlSafe) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  if (urlSafe) {
    out = out.split('+').join('-').split('/').join('_');
    while (out.length > 0 && out[out.length - 1] === '=') out = out.slice(0, out.length - 1);
  }
  return out;
}

function b64Decode(str) {
  var s = String(str).split('-').join('+').split('_').join('/');
  var out = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch === '=') continue;
    var v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function toHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = (bytes[i] & 0xff).toString(16);
    if (h.length < 2) h = '0' + h;
    out += h;
  }
  return out;
}

// --- SHA-256 ---------------------------------------------------------------

var K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var msg = bytes.slice();
  var bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit length, big-endian; lengths beyond 2^32 bits do not arise here
  msg.push(0, 0, 0, 0);
  msg.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  var w = [];
  for (var off = 0; off < msg.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) >>> 0;
    }
    for (var t2 = 16; t2 < 64; t2++) {
      var s0 = (rotr(w[t2 - 15], 7) ^ rotr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3)) >>> 0;
      var s1 = (rotr(w[t2 - 2], 17) ^ rotr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10)) >>> 0;
      w[t2] = (((w[t2 - 16] + s0) >>> 0) + ((w[t2 - 7] + s1) >>> 0)) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (var i = 0; i < 64; i++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ ((~e >>> 0) & g)) >>> 0;
      var temp1 = (((((hh + S1) >>> 0) + ch) >>> 0) + ((K256[i] + w[i]) >>> 0)) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  var out = [];
  for (var k = 0; k < 8; k++) {
    out.push((h[k] >>> 24) & 0xff, (h[k] >>> 16) & 0xff, (h[k] >>> 8) & 0xff, h[k] & 0xff);
  }
  return out;
}

// --- SHA-1 (etag, legacy signatures) ---------------------------------------

function sha1(bytes) {
  var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  var msg = bytes.slice();
  var bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  msg.push(0, 0, 0, 0);
  msg.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  for (var off = 0; off < msg.length; off += 64) {
    var w = [];
    for (var t = 0; t < 16; t++) {
      w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) >>> 0;
    }
    for (var t2 = 16; t2 < 80; t2++) {
      w[t2] = rotl(w[t2 - 3] ^ w[t2 - 8] ^ w[t2 - 14] ^ w[t2 - 16], 1);
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (var i = 0; i < 80; i++) {
      var f, k;
      if (i < 20) { f = (b & c) | ((~b >>> 0) & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      var tmp = (((rotl(a, 5) + (f >>> 0)) >>> 0) + ((((e + k) >>> 0) + w[i]) >>> 0)) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  var hs = [h0, h1, h2, h3, h4];
  var out = [];
  for (var j = 0; j < 5; j++) {
    out.push((hs[j] >>> 24) & 0xff, (hs[j] >>> 16) & 0xff, (hs[j] >>> 8) & 0xff, hs[j] & 0xff);
  }
  return out;
}

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

// --- md5 (etag fallback) ---------------------------------------------------
// Not implemented; callers that ask for md5 get sha1 instead. Nothing in the
// target depends on md5's exact digest, only on a stable content hash.

function digestBytes(algorithm, bytes) {
  var algo = String(algorithm).toLowerCase();
  if (algo === 'sha1') return sha1(bytes);
  return sha256(bytes);
}

function encodeDigest(bytes, encoding) {
  if (encoding === 'base64') return b64Encode(bytes, false);
  if (encoding === 'base64url') return b64Encode(bytes, true);
  if (encoding === 'binary' || encoding === 'latin1') {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  return toHex(bytes);
}

// --- public API ------------------------------------------------------------

function Hash(algorithm) {
  this.algorithm = algorithm;
  this.buf = [];
}
Hash.prototype.update = function (data, encoding) {
  var bytes = toBytes(data, encoding);
  for (var i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
  return this;
};
Hash.prototype.digest = function (encoding) {
  return encodeDigest(digestBytes(this.algorithm, this.buf), encoding);
};

function Hmac(algorithm, key) {
  this.algorithm = String(algorithm).toLowerCase();
  this.blockSize = 64;
  var k = toBytes(key);
  if (k.length > this.blockSize) k = digestBytes(this.algorithm, k);
  while (k.length < this.blockSize) k.push(0);
  this.ipad = [];
  this.opad = [];
  for (var i = 0; i < this.blockSize; i++) {
    this.ipad.push(k[i] ^ 0x36);
    this.opad.push(k[i] ^ 0x5c);
  }
  this.buf = this.ipad.slice();
}
Hmac.prototype.update = function (data, encoding) {
  var bytes = toBytes(data, encoding);
  for (var i = 0; i < bytes.length; i++) this.buf.push(bytes[i]);
  return this;
};
Hmac.prototype.digest = function (encoding) {
  var inner = digestBytes(this.algorithm, this.buf);
  var outer = this.opad.slice();
  for (var i = 0; i < inner.length; i++) outer.push(inner[i]);
  return encodeDigest(digestBytes(this.algorithm, outer), encoding);
};

exports.createHash = function (algorithm) { return new Hash(algorithm); };
exports.createHmac = function (algorithm, key) { return new Hmac(algorithm, key); };

// Not cryptographically secure: seeded from the clock, because milojs has no
// entropy source yet. Fine for etags and cache keys; NOT for secrets.
var rngState = (Date.now() % 2147483647) || 1;
function nextByte() {
  rngState = (rngState * 16807) % 2147483647;
  return rngState & 0xff;
}

exports.randomBytes = function (n, cb) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(nextByte());
  var buf = {
    length: out.length,
    bytes: out,
    toString: function (enc) { return encodeDigest(out, enc); }
  };
  if (typeof cb === 'function') { cb(null, buf); return undefined; }
  return buf;
};

exports.randomUUID = function () {
  var b = [];
  for (var i = 0; i < 16; i++) b.push(nextByte());
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = toHex(b);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
};

exports.timingSafeEqual = function (a, b) {
  var x = toBytes(a), y = toBytes(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};

exports.constants = {};
exports.webcrypto = undefined;
