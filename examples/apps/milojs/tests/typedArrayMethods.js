// Typed arrays: iteration (spread/for-of) + callback methods.
const a = new Uint8Array([1, 2, 3, 4]);
console.log(JSON.stringify([...a]));
let s = 0; for (const x of a) s += x; console.log(s);
console.log(JSON.stringify([...a.map((x) => x * 2)]));
console.log(JSON.stringify([...a.filter((x) => x % 2 === 0)]));
console.log(a.reduce((acc, x) => acc + x, 0), a.reduceRight((acc, x) => acc + "" + x, ""));
console.log(a.find((x) => x > 2), a.findIndex((x) => x > 2));
console.log(a.some((x) => x > 3), a.every((x) => x > 0));
let f = 0; a.forEach((x) => f += x); console.log(f);
console.log(JSON.stringify([...new Uint8Array([5, 3, 8, 1]).sort()]));
console.log(JSON.stringify([...new Int32Array([1, 2, 3]).sort((x, y) => y - x)]));
const r = new Uint8Array([1, 2, 3]); r.reverse(); console.log(JSON.stringify([...r]));
console.log(JSON.stringify([...new Float64Array([1.5, 2.5]).map((x) => x + 1)]));
