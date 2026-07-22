// process.hrtime + .bigint: shape and types (real times vary, so no value assert)
const t = process.hrtime.bigint();
console.log(typeof t, t > 0n);
const a = process.hrtime();
console.log(Array.isArray(a), a.length, typeof a[0], typeof a[1]);
const d = process.hrtime(a);
console.log(Array.isArray(d), d.length, d[0] >= 0);
