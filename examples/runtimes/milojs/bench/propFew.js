// Pair C control: read the LAST property of a 3-property object.
// Paired with propMany.js (30 properties). Since objGet scans props linearly
// (runtime.milo:429), the delta scales with property count and isolates the
// missing hash/shape lookup.
const N = 1000000;
const o = { a: 1, b: 2, target: 3 };
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = sink + o.target;
}
console.log(sink);
