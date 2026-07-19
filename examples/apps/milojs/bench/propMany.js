// Pair C variant: same read count, but `target` is the 30th property, so each
// objGet does ~30 string compares instead of ~3.
const N = 1000000;
const o = {
  p0: 0, p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6, p7: 7, p8: 8, p9: 9,
  q0: 0, q1: 1, q2: 2, q3: 3, q4: 4, q5: 5, q6: 6, q7: 7, q8: 8, q9: 9,
  r0: 0, r1: 1, r2: 2, r3: 3, r4: 4, r5: 5, r6: 6, r7: 7, r8: 8,
  target: 3
};
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = sink + o.target;
}
console.log(sink);
