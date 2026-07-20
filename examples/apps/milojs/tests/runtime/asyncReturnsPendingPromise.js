// An async function that returns a still-pending promise must have its own
// result promise adopt it: awaiting the async call resolves only when the
// returned promise later settles. Reading the returned promise's state at
// return time settles the activation with "pending", and the caller's await
// then hangs forever. This is the tahoeroads cache wrapper shape:
//   async get(url) { return fetchData(url).then(d => ...); }
//   const data = await cache.get(url);   // hung
// Network-free: the inner promises are settled by timers we control.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const a = deferred();
const b = deferred();
async function innerA() { return a.promise.then((v) => v + "!"); }
async function innerB() { return b.promise.then((v) => v.toUpperCase()); }
async function outer() {
  console.log("first:", await innerA());
  console.log("second:", await innerB());
}
outer().then(() => console.log("done")).catch((e) => console.log("CATCH", e.message));
setTimeout(() => a.resolve("value"), 10);
setTimeout(() => b.resolve("next"), 20);
