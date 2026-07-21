// Object.getPrototypeOf / __proto__ must resolve builtin instances to the right
// prototype singleton even though milojs fakes the prototype chain.
console.log(Object.getPrototypeOf([]) === Array.prototype);
console.log(Object.getPrototypeOf({}) === Object.prototype);
console.log(Object.getPrototypeOf(Array.prototype) === Object.prototype);
console.log(Object.getPrototypeOf(Object.prototype) === null);
console.log([].__proto__ === Array.prototype);
console.log(({}).__proto__ === Object.prototype);
// an explicit link (Object.create / setPrototypeOf) still wins
const base = { tag: 1 };
const derived = Object.create(base);
console.log(Object.getPrototypeOf(derived) === base);
