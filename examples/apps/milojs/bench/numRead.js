// Pair A control: read a NUMBER local N times.
// Paired with strRead.js, which is identical except the variable holds a string.
// The delta between the two isolates cloneValue's per-read heap copy of an owned
// string (value.milo:44) from all other loop overhead.
const N = 2000000;
let v = 12345;
let sink = 0;
for (let i = 0; i < N; i++) {
  const x = v;
  sink = sink + 1;
}
console.log(sink);
