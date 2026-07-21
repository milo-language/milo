// Map/Set forEach with the callback mutating the collection: deleting the
// current key must not skip the entry that shifts into its slot; entries added
// during iteration are visited.
const m = new Map([[1, "a"], [2, "b"], [3, "c"], [4, "d"]]);
m.forEach((v, k) => { m.delete(k); });
console.log(m.size);
const s = new Set([1, 2, 3, 4]);
s.forEach(v => s.delete(v));
console.log(s.size);
const m2 = new Map([[1, "a"]]);
m2.forEach((v, k) => { if (k < 3) m2.set(k + 1, "x"); });
console.log(m2.size);
const order = [];
const m3 = new Map([[1, 1], [2, 2], [3, 3], [4, 4]]);
m3.forEach((v, k) => { order.push(k); if (k === 1) m3.delete(2); });
console.log(order.join(","));
const s2 = new Set([1, 2, 3]);
const o5 = [];
s2.forEach(v => { o5.push(v); if (v === 2) { s2.clear(); s2.add(9); } });
console.log(o5.join(","));
