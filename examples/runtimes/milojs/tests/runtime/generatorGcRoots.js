// R7-style: objects reachable ONLY through a suspended generator must survive a
// collection while it is parked at a yield. Run under MILOJS_GC_THRESHOLD=1 (the
// *Gc* name triggers it in run.sh) so a collection actually fires between yields.
function* holder() {
  const a = { tag: "alpha", n: 1 };
  yield a.tag;
  const b = { tag: "beta", n: 2 };
  yield a.tag + b.tag;          // a must have survived the park
  return a.n + b.n;
}
const h = holder();
function churn() { for (let i = 0; i < 8000; i++) { const j = { x: i, y: i * 2 }; } }
console.log(h.next().value);   // alpha
churn();
console.log(h.next().value);   // alphabeta  (a survived GC while parked)
churn();
console.log(JSON.stringify(h.next())); // {value:3,done:true}
