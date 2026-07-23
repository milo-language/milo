// Proxy target/handler moved to the JSObjExtra side table; the collector must
// reach them through the proxy object. Runs under GC stress.
const p = new Proxy({ n: 1 }, {
  get(t, k) { return k in t ? t[k] * 10 : "none"; },
  set(t, k, v) { t[k] = v + 1; return true; },
  has(t, k) { return k === "secret" || k in t; },
});
console.log(p.n);
p.m = 5; console.log(p.m);
console.log("secret" in p, "nope" in p);
const fn = new Proxy(function (a) { return a + 1; }, { apply(t, th, args) { return t(args[0]) * 2; } });
console.log(fn(10));
let last = 0;
for (let i = 0; i < 15000; i++) { const q = new Proxy({ v: i }, { get(t, k) { return t[k]; } }); last = q.v; }
console.log(last);
