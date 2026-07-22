// Array.includes uses SameValueZero (finds NaN); Object.getOwnPropertySymbols;
// symbols render as Symbol(desc) bare / nested / in objects
console.log([NaN].includes(NaN), [1,NaN,3].includes(NaN), [1,2,3].includes(2), ["a"].includes("b"));
console.log([0].includes(-0), [-0].includes(0));
console.log(Object.getOwnPropertySymbols({[Symbol("s")]:1, a:2}));
console.log(Object.getOwnPropertySymbols({}).length);
console.log(Object.getOwnPropertyNames({[Symbol("x")]:1, a:2}));
const sy = Symbol("hi");
console.log(sy, [sy]);
console.log(String(Symbol("z")), typeof Symbol());
