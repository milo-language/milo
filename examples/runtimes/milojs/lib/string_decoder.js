// node:string_decoder — decodes byte chunks to strings. Multi-byte sequences
// split across chunk boundaries are not stitched; the target only decodes whole
// bodies, and doing it properly needs the partial-sequence state machine.
var Buffer = require('buffer').Buffer;

function StringDecoder(encoding) {
  this.encoding = encoding || 'utf8';
}
StringDecoder.prototype.write = function (chunk) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  return Buffer.from(chunk).toString(this.encoding);
};
StringDecoder.prototype.end = function (chunk) {
  return chunk == null ? '' : this.write(chunk);
};

exports.StringDecoder = StringDecoder;
