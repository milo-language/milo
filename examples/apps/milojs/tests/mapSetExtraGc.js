// Map/Set entries moved to the JSObjExtra side table; the collector must reach
// keys+values through the Map/Set object. Runs under GC stress.
const m = new Map();
m.set("a", { v: 1 }); m.set("b", { v: 2 }); m.set("a", { v: 9 });
console.log(m.size, m.get("a").v, m.get("b").v, m.has("c"));
const s = new Set([1, 2, 2, 3]);
console.log(s.size, s.has(2), s.has(5));
const s2 = new Set([2, 3, 4]);
console.log([...s.union(s2)].sort().join(","));
const objKey = {};
const m2 = new Map(); m2.set(objKey, "byident"); console.log(m2.get(objKey), m2.get({}));
let acc = 0;
for (let i = 0; i < 15000; i++) { const mm = new Map(); mm.set(i, i * 2); acc += mm.get(i); }
console.log(acc);
const entries = [];
m.forEach((v, k) => entries.push(k + "=" + v.v));
console.log(entries.join(","));
