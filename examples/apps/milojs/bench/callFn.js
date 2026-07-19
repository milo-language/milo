// Pair E control: N calls to a `function`, which eagerly materializes an
// `arguments` array object on every call (eval.milo:3971) whether or not the
// body uses it. Paired with callArrow.js, where arrows skip that path; the
// delta is the cost of the unused `arguments` object.
const N = 500000;
function f(a) { return a + 1; }
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = f(sink);
}
console.log(sink);
