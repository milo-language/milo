// Symbol-keyed properties never appear in string-key enumeration: Object.keys,
// for-in, JSON.stringify, getOwnPropertyNames, spread. Only y is a string key.
const s = {};
const sym = Symbol("x");
s[sym] = 1;
s.y = 2;
console.log(JSON.stringify(Object.keys(s)));
console.log(JSON.stringify(Object.getOwnPropertyNames(s)));
console.log(JSON.stringify(s));
let ks = []; for (const k in s) ks.push(k); console.log(JSON.stringify(ks));
console.log(JSON.stringify({ ...s }));
console.log(s[sym]);
