// Proxy has (in operator) and deleteProperty traps, with target fallthrough.
const h = new Proxy({ a: 1 }, { has: (o, k) => k === "magic" || k in o });
console.log("a" in h, "magic" in h, "z" in h);
const d = new Proxy({ a: 1, b: 2 }, { deleteProperty: (o, k) => { delete o[k]; return true; } });
delete d.a; console.log(JSON.stringify(Object.keys(d)));
const t = new Proxy({ a: 1, b: 2 }, {});   // no traps -> target
console.log("a" in t, "z" in t);
delete t.a; console.log(JSON.stringify(Object.keys(t)));
