// Baseline dispatch cost: tight arithmetic, no calls, no property access, no
// strings. Every binary op pays the `if op == "..."` string-compare chain
// (eval.milo:2957) because Expr.Bin stores the operator as a string (ast.milo:9).
const N = 2000000;
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = sink + i * 2 - 1;
}
console.log(sink);
