// R6: locals live across a suspension point mid-loop. `sum`, `i`, `base` must
// all survive the await and resume with their own values — no interpreter state
// is ambient across the park.
let release;
const gate = new Promise((r) => { release = r; });
async function f(base) {
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    sum += base + i;
    if (i === 2) await gate; // suspend mid-loop with sum/i/base live
  }
  return sum;
}
async function main() {
  const p = f(10);
  release();
  console.log("sum", await p); // (10+0)+(10+1)+(10+2)+(10+3)+(10+4) = 60
}
main();
