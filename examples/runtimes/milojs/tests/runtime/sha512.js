// SHA-512 / SHA-384 (FIPS 180-4) — real 64-bit hashing via hi/lo 32-bit pairs,
// not a sha256 substitute. Matches node on the standard vectors + HMAC (128-byte
// block) + Buffer + multi-block input.
const c = require("crypto");
console.log(c.createHash("sha512").update("abc").digest("hex"));
console.log(c.createHash("sha512").update("").digest("hex"));
console.log(c.createHash("sha384").update("abc").digest("hex"));
console.log(c.createHash("sha512").update("The quick brown fox jumps over the lazy dog").digest("hex"));
console.log(c.createHash("sha512").update("a").update("bc").digest("hex"));
console.log(c.createHmac("sha512", "key").update("data").digest("hex"));
console.log(c.createHmac("sha384", "secret").update("msg").digest("base64"));
console.log(c.createHash("sha512").update(Buffer.from([1, 2, 3, 255])).digest("hex"));
console.log(c.createHash("sha512").update("x".repeat(200)).digest("hex"));
