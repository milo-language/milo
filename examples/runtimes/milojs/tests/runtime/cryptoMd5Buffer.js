// createHash("md5") returns a real MD5 (RFC 1321), not a substituted sha256; and
// hashing a Buffer reads its bytes correctly (toBytes was indexing buf[i], which
// is undefined on a milojs Buffer, and hashing all zeros).
const c = require("crypto");
console.log(c.createHash("md5").update("abc").digest("hex"));
console.log(c.createHash("md5").update("").digest("hex"));
console.log(c.createHash("md5").update("The quick brown fox jumps over the lazy dog").digest("hex"));
console.log(c.createHash("md5").update("a").update("bc").digest("hex"));
console.log(c.createHmac("md5", "key").update("data").digest("hex"));
console.log(c.createHash("md5").update("abc").digest("base64"));
console.log(c.createHash("md5").update(Buffer.from([1, 2, 3, 255])).digest("hex"));
console.log(c.createHash("sha256").update(Buffer.from([1, 2, 3, 255])).digest("hex"));
