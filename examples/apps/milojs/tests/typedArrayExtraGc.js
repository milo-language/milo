// ArrayBuffer bytes + typed-array geometry (taBuf/taKind/taOffset/taLen) moved to
// the JSObjExtra side table; the collector reaches the backing buffer through
// taBuf. GC stress. (Int32Array-over-buffer and DataView methods are pre-existing
// gaps, not exercised here.)
const u8 = new Uint8Array(8); u8[0] = 255; u8[7] = 42;
console.log(u8[0], u8[7], u8.length, u8.byteLength);
const f = new Float64Array([1.5, 2.5, 3.5]);
console.log(f[0], f[1], f[2], f.length, f.reduce((a, b) => a + b, 0));
const u16 = new Uint16Array([10, 20, 30]);
console.log(u16[0], u16[1], u16.length);
const sub = u8.subarray(0, 2); console.log(sub.length, sub[0]);
const sl = f.slice(0, 2); sl[0] = 9; console.log(sl.length, sl[0], f[0]);
const m = f.map(x => x * 2); console.log(m[0], m[1], m[2]);
let acc = 0;
for (let i = 0; i < 12000; i++) { const t = new Uint8Array(4); t[0] = i & 255; acc += t[0]; }
console.log(acc);
