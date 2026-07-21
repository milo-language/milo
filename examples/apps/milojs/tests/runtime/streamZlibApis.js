// Readable.from(iterable) builds a stream that emits each item then ends; zlib
// exposes every *Sync variant (identity pass-through, but present and
// string-safe). Both are require-based, so runtime-only.
const { Readable, Writable } = require("stream");
const chunks = [];
const w = new Writable({ write(c, e, cb) { chunks.push(c.toString()); cb(); } });
Readable.from(["a", "b", "c"]).pipe(w);
w.on("finish", () => console.log("stream:", chunks.join(",")));
const zlib = require("zlib");
console.log("deflateSync", zlib.deflateSync("test").length > 0);
console.log("roundtrip", zlib.gunzipSync(zlib.gzipSync(Buffer.from("hi"))).toString());
console.log("brotli", typeof zlib.brotliCompressSync, typeof zlib.inflateRawSync);
