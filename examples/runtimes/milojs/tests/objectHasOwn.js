console.log(Object.hasOwn({ a: 1 }, "a"), Object.hasOwn({ a: 1 }, "b"));
console.log(Object.hasOwn([10, 20], 0), Object.hasOwn([10, 20], 5));
console.log(Object.hasOwn({}, "toString"));
const o = Object.create({ inherited: 1 });
o.own = 2;
console.log(Object.hasOwn(o, "own"), Object.hasOwn(o, "inherited"));
