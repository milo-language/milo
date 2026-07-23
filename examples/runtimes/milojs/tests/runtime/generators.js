// Core generator protocol on the milojs runtime (generators run on green tasks,
// so they work on the runtime binary, not the engine — see the R1b note in
// docs/milojs-async-suspension.md).
function* g() { yield 1; yield 2; yield 3; }
const it = g();
console.log(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));
// bidirectional next(v) — the value passed in becomes the yield expression result
function* echo() { const a = yield "first"; const b = yield a; return b; }
const e = echo();
console.log(JSON.stringify(e.next()), JSON.stringify(e.next("A")), JSON.stringify(e.next("B")));
// early return carries a value with done:true
function* r() { yield 1; return 99; yield 2; }
const rr = r();
console.log(JSON.stringify(rr.next()), JSON.stringify(rr.next()), JSON.stringify(rr.next()));
// for-of, spread, Array.from consume a generator
function* three() { yield 10; yield 20; yield 30; }
let sum = 0; for (const x of three()) sum += x;
console.log("forof", sum, "spread", JSON.stringify([...three()]), "from", JSON.stringify(Array.from(three())));
// yield* delegation
function* inner() { yield "a"; yield "b"; }
function* outer() { yield 1; yield* inner(); yield 2; }
console.log("yield*", JSON.stringify([...outer()]));
// infinite generator, partially consumed (must not hang at exit)
function* nat() { let i = 0; while (true) { yield i++; } }
const n = nat();
console.log("nat", n.next().value, n.next().value, n.next().value);
// break out of for-of over an infinite generator
let taken = [];
for (const x of nat()) { if (x >= 3) break; taken.push(x); }
console.log("take", JSON.stringify(taken));
