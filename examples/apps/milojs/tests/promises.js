// Promises settle synchronously here — there is no event loop — so callbacks run
// at .then() time rather than on a microtask. Ordering therefore differs from
// real JS; this fixture pins the value flow, which does match.
async function double(x) { return x * 2; }
async function chain() { const v = await double(21); return v; }

chain().then(v => console.log("then", v));
Promise.resolve(1).then(v => console.log("res", v));
Promise.reject(new Error("boom")).catch(e => console.log("caught", e.message));
new Promise((resolve) => resolve("hi")).then(v => console.log("np", v));
new Promise((_, reject) => reject(new Error("nope"))).catch(e => console.log("rej", e.message));

Promise.all([1, Promise.resolve(2), double(3)]).then(v => console.log("all", JSON.stringify(v)));
Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]).then(v => console.log("settled", v.length, v[0].status, v[1].status));
Promise.race([Promise.resolve("first")]).then(v => console.log("race", v));

(async () => {
  try { await Promise.reject(new Error("bad")); } catch (e) { console.log("try", e.message); }
  console.log("awaited", JSON.stringify(await Promise.all([double(1), double(2)])));
  const t = await 42;
  console.log("await non-promise", t);
})();

async function thrower() { throw new Error("async-throw"); }
thrower().catch(e => console.log("async rejected:", e.message));
