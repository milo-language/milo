// Values held in Milo locals across a nested call must stay rooted: evaluating a
// later argument/key/operand can run user code and trigger a collection.
// Run with MILOJS_GC_THRESHOLD=1 to collect at every safepoint.
function churn(v) { for (let i = 0; i < 40; i++) { const t = { x: i, y: [i] }; } return v; }
function mk() { return { p: "BASE", q: [7, 8, 9] }; }

function f(arr, n) { return arr.length + ":" + arr[0] + ":" + n; }
console.log(f([1, 2, 3], churn(9)));

console.log(mk()[churn("p")]);
console.log(mk().q[churn(2)]);
console.log(({ z: "LIT" })[churn("z")]);

const o = mk();
o[churn("nk")] = churn("nv");
console.log(o.nk);

console.log(mk().p + churn("!"));
console.log(({ id: "A" }) === churn({ id: "B" }) ? "eq" : "ne");
