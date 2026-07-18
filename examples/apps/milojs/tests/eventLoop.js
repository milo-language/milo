// Timer ordering, deferred resolvers, and combinators over real pending promises.
// The .expected here is milojs's own output, not bun's: `await` cannot suspend a
// native frame (no coroutines), so a nested drain runs the loop in place and the
// interleaving differs from real JS. Every value matches bun; only order does not.
console.log("start");
setTimeout(() => console.log("t 20"), 20);
setTimeout(() => console.log("t 0"), 0);
let n = 0;
const iv = setInterval(() => { n++; console.log("tick", n); if (n === 3) clearInterval(iv); }, 5);
setTimeout((a, b) => console.log("args", a, b), 1, "x", "y");
const cancelled = setTimeout(() => console.log("NEVER"), 5);
clearTimeout(cancelled);
queueMicrotask(() => console.log("micro"));
setImmediate(() => console.log("immediate"));

let r; const p = new Promise(res => { r = res; });
p.then(v => console.log("deferred handler", v));
setTimeout(() => r(42), 8);

const slow = (v, ms) => new Promise(res => setTimeout(() => res(v), ms));
const fail = (e, ms) => new Promise((_, rj) => setTimeout(() => rj(new Error(e)), ms));
Promise.all([slow(1, 5), slow(2, 10), 3]).then(v => console.log("all", JSON.stringify(v)));
Promise.race([slow("fast", 3), slow("slow", 40)]).then(v => console.log("race", v));
Promise.allSettled([slow("ok", 4), fail("bad", 6)]).then(v => console.log("settled", v[0].status, v[1].status));
Promise.all([slow(1, 2), fail("boom", 4)]).catch(e => console.log("all rejects:", e.message));
Promise.reject(new Error("keep")).finally(() => console.log("cleanup")).catch(e => console.log("still rejected:", e.message));
console.log("end sync");
