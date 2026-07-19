// Paired with numRead.js: same loop and same add, but WITHOUT the per-iteration
// `const x = v` declaration. The delta isolates the cost of defining a fresh
// binding (and any per-iteration block scope) from the read itself.
const N = 2000000;
let v = 12345;
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = sink + 1;
}
console.log(sink);
