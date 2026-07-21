// Object-literal numeric keys `{2: v}` key on ToString(num), and enumerate in JS
// order: integer-index keys ascending first, then string keys in insertion order.
const o = { 2: "a", 1: "b", 10: "c", x: "d" };
console.log(o[1], o[2], o[10], o.x);
console.log("1" in o, "2" in o, "10" in o, "5" in o);
console.log(JSON.stringify(Object.keys(o)));
console.log(JSON.stringify(o));
console.log(JSON.stringify(Object.values(o)));
console.log(JSON.stringify(Object.entries(o)));
let ks = []; for (const k in o) ks.push(k); console.log(JSON.stringify(ks));
console.log(JSON.stringify({ ...o }));
const mixed = { b: 1, 0: 2, a: 3, 5: 4 };
console.log(JSON.stringify(Object.keys(mixed)), JSON.stringify(Object.assign({}, mixed)));
const status = { 200: "ok", 404: "missing" };
console.log(status[200], status[404]);
const f = { 1.5: "x", 0: "y" };
console.log(f[1.5], f[0]);
