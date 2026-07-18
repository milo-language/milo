// node:zlib — identity pass-through. compression middleware only needs these to
// exist and to hand back what it was given; nothing here actually compresses.
var stream = require('stream');

function passthrough() { return new stream.PassThrough(); }

exports.createGzip = passthrough;
exports.createDeflate = passthrough;
exports.createDeflateRaw = passthrough;
exports.createGunzip = passthrough;
exports.createInflate = passthrough;
exports.createInflateRaw = passthrough;
exports.createBrotliCompress = passthrough;
exports.createBrotliDecompress = passthrough;

function identity(buf, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  if (cb) cb(null, buf);
  return buf;
}
exports.gzip = identity;
exports.gunzip = identity;
exports.deflate = identity;
exports.inflate = identity;
exports.gzipSync = function (buf) { return buf; };
exports.gunzipSync = function (buf) { return buf; };
exports.constants = { Z_SYNC_FLUSH: 2, Z_NO_FLUSH: 0, Z_BEST_SPEED: 1 };
