// Pair A variant: identical to numRead.js but the local holds a STRING.
// Every read goes through cloneValue -> s.clone() -> heap alloc + memcpy.
// The string is long enough that the memcpy is not lost in allocator noise.
const N = 2000000;
let v = "abcdefghijklmnopqrstuvwxyz0123456789";
let sink = 0;
for (let i = 0; i < N; i++) {
  const x = v;
  sink = sink + 1;
}
console.log(sink);
