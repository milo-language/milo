// R1a: a settled `await` still yields a microtask tick, so a microtask queued
// before the await runs before the await's continuation (node semantics). Only
// the microtasks pending AT the await run first — ones they queue run after.
async function main() {
  let seq = [];
  Promise.resolve().then(() => seq.push("micro"));
  seq.push("sync");
  await Promise.resolve();
  seq.push("after-await");
  console.log(JSON.stringify(seq));            // ["sync","micro","after-await"]
  let order = [];
  Promise.resolve().then(() => order.push("m1")).then(() => order.push("m2"));
  await 0;                                     // await a non-thenable
  order.push("await-done");
  console.log(JSON.stringify(order));          // ["m1","await-done"] (m2 runs later)
  let r = [];
  Promise.resolve().then(() => r.push("a"));
  Promise.resolve().then(() => r.push("b"));
  await null;
  r.push("done");
  console.log(JSON.stringify(r));              // ["a","b","done"]
}
main();
