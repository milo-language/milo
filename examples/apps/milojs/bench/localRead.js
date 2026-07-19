// Pair B control: read a variable in the INNERMOST scope.
// Paired with deepRead.js. Delta isolates the cost of walking the scope parent
// chain doing string-compare lookups (runtime.milo:1057) from loop overhead.
const N = 1000000;
function run() {
  let target = 7;
  let sink = 0;
  for (let i = 0; i < N; i++) {
    sink = sink + target;
  }
  return sink;
}
console.log(run());
