// A sort comparator that resizes the backing buffer mid-sort must not overflow
// the interpreter (issue #1297) — it survives instead of panicking with an
// out-of-bounds access.
const ab = new ArrayBuffer(256, { maxByteLength: 2560 });
const u8 = new Uint8Array(ab);
for (let i = 0; i < 256; i++) u8[i] = i & 0xff;
let cnt = 0;
u8.sort((a, b) => {
  if (cnt++ === 0) { try { ab.resize(10); } catch (e) {} }
  return a - b;
});
console.log("survived sort-with-resize");
const ab2 = new ArrayBuffer(16, { maxByteLength: 64 });
const v = new Int32Array(ab2);
v[3] = 9;
try { ab2.resize(4); } catch (e) {}
v.map((x) => x);   // iterating a shrunk view must not overflow either
console.log("survived shrink+map");
