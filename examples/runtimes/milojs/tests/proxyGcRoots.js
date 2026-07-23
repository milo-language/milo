// a proxy's target and handler must survive collection: they are reachable only
// through the proxy itself, and losing them silently emptied a live object.
function makeCounter(tag) {
  const state = { tag, hits: 0 };
  return new Proxy({}, {
    get(_t, k) {
      if (k === "tag") return state.tag;
      if (k === "hits") return state.hits;
      state.hits++;
      return "dyn:" + state.tag + ":" + String(k);
    },
  });
}
const a = makeCounter("A");
console.log(a.tag, a.anything);
// allocate hard enough to force collections while `a` is still live
for (let i = 0; i < 2000; i++) {
  const junk = { i, s: "x".repeat(64), arr: [i, i + 1, i + 2] };
  if (junk.i < 0) console.log("unreachable");
}
const b = makeCounter("B");
for (let i = 0; i < 2000; i++) {
  const junk = { i, s: "y".repeat(64) };
  if (junk.i < 0) console.log("unreachable");
}
console.log(a.tag, a.other, b.tag, b.other);
