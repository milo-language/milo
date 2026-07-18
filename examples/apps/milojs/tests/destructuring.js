const f = ({ a, b }) => a + b;
console.log(f({ a: 1, b: 2 }));
const { x, y: yy, z = 9 } = { x: 1, y: 2 };
console.log(x, yy, z);
const [p, q, r = 7] = [10, 20];
console.log(p, q, r);
function g({ a: { b } }, [c]) { return b + c; }
console.log(g({ a: { b: 5 } }, [6]));
const h = (a, b = 3) => a + b;
console.log(h(1), h(1, 10));
const o = { a: 1, b: 2 };
for (const [k, v] of Object.entries(o)) console.log(k, v);
for (const { n } of [{ n: 1 }, { n: 2 }]) console.log(n);
function rest(...args) { return args.length; }
console.log(rest(1, 2, 3));
console.log(JSON.stringify({ ...o, b: 9, c: 3 }));
