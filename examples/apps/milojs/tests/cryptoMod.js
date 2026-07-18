// Digests checked against the published test vectors, not against bun — the
// point is that the implementation is correct, not that two engines agree.
const c = require('crypto');
console.log(c.createHash('sha256').update('abc').digest('hex'));
console.log(c.createHash('sha1').update('abc').digest('hex'));
console.log(c.createHash('sha256').update('').digest('hex'));
console.log(c.createHash('sha256').update('hello world').digest('base64'));
console.log(c.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'));
console.log(c.createHash('sha256').update('a').update('bc').digest('hex'));
console.log(c.randomBytes(8).toString('hex').length, c.randomUUID().length);
// node's timingSafeEqual requires Buffers, so it is not compared here; milojs
// accepts strings as a convenience.
