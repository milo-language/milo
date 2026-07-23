// Pair E variant: identical call count via an arrow function, which does not
// build `arguments`.
const N = 500000;
const f = (a) => a + 1;
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = f(sink);
}
console.log(sink);
