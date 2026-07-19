// Allocation cost: every {} allocates a JSObj arena slot carrying ~40 inline
// fields (runtime.milo:220) — promise state, date, typed-array window, etc. —
// regardless of use. Also exercises the mark-sweep GC safepoint path.
const N = 300000;
let sink = 0;
for (let i = 0; i < N; i++) {
  const o = { a: i, b: i + 1, c: i + 2 };
  sink = sink + o.c;
}
console.log(sink);
