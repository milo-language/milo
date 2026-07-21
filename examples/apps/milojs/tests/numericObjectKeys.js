// Object-literal numeric keys `{2: v}` must key on ToString(num) ("2"), not the
// token's empty text. (Enumeration ORDER — integer keys ascending first — is a
// separate JS rule not yet implemented, so this asserts order-independently.)
const o = { 2: "a", 1: "b", 10: "c", x: "d" };
console.log(o[1], o[2], o[10], o.x);
console.log("1" in o, "2" in o, "10" in o, "5" in o);
console.log(Object.keys(o).length, Object.keys(o).slice().sort().join(","));
const status = { 200: "ok", 404: "missing" };
console.log(status[200], status[404]);
const f = { 1.5: "x", 0: "y" };
console.log(f[1.5], f[0]);
