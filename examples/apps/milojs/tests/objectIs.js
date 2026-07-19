console.log(Object.is(1, 1), Object.is("a", "a"), Object.is(NaN, NaN));
console.log(Object.is(0, -0), Object.is(-0, -0), Object.is(null, undefined));
const o = {};
console.log(Object.is(o, o), Object.is(o, {}));
