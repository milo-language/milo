// Buffer integer read/write accessors (UInt/Int 8/16/32, LE/BE, generic byte-len)
// plus fill/copy/write/subarray/includes — binary-protocol surface node deps use.
// Runtime-only: Buffer comes from the required buffer.js module, absent in the engine.
const b = Buffer.alloc(8);
b.writeUInt32BE(0x01020304, 0); b.writeUInt16LE(0x0506, 4); b.writeUInt8(0xff, 6);
console.log(b.toString("hex"));
console.log(b.readUInt32BE(0), b.readUInt16LE(4), b.readUInt8(6));
const s = Buffer.alloc(4); s.writeInt16BE(-2, 0); console.log(s.readInt16BE(0));
s.writeInt32LE(-1000000, 0); console.log(s.readInt32LE(0));
const f = Buffer.alloc(4).fill(0xAB); console.log(f.toString("hex"));
const src = Buffer.from("hello"); const dst = Buffer.alloc(5); src.copy(dst); console.log(dst.toString());
const w = Buffer.alloc(5); w.write("hi", 1); console.log(w.toString("hex"));
console.log(Buffer.from("abcdef").subarray(2, 4).toString(), Buffer.from("abc").includes("b"));
console.log(Buffer.from([1, 2, 3, 4]).readUIntBE(0, 3));
