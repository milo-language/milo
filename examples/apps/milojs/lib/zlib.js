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

var Buffer = require('buffer').Buffer;
// node returns a Buffer even for a string input, so coerce — a caller doing
// .length / .toString() on the result (the common shape) then works, and the
// identity round-trip gunzipSync(gzipSync(x)) still yields x's bytes.
function toBuf(x) { return typeof x === 'string' ? Buffer.from(x) : x; }

function identity(buf, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  var out = toBuf(buf);
  if (cb) cb(null, out);
  return out;
}
function identitySync(buf) { return toBuf(buf); }

exports.gzip = identity;
exports.gunzip = identity;
exports.deflate = identity;
exports.inflate = identity;
exports.deflateRaw = identity;
exports.inflateRaw = identity;
exports.brotliCompress = identity;
exports.brotliDecompress = identity;
exports.unzip = identity;
// every *Sync variant a dep might reach for — all identity, all string-safe
exports.gzipSync = identitySync;
exports.gunzipSync = identitySync;
exports.deflateSync = identitySync;
exports.inflateSync = identitySync;
exports.deflateRawSync = identitySync;
exports.inflateRawSync = identitySync;
exports.brotliCompressSync = identitySync;
exports.brotliDecompressSync = identitySync;
exports.unzipSync = identitySync;
exports.constants = { Z_SYNC_FLUSH: 2, Z_NO_FLUSH: 0, Z_BEST_SPEED: 1 };
