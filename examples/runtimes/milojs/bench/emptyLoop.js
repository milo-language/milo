// Floor probe: the loop and nothing else. If this is already close to the cost
// of benches that do real work, the dominant cost is per-iteration interpreter
// machinery (block scope alloc, statement dispatch, GC safepoint), not any
// individual operation.
const N = 2000000;
for (let i = 0; i < N; i++) {}
console.log("done");
