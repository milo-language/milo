// Object is a constructor, not a plain namespace object: `typeof Object` is
// "function", `new Object()` makes an empty object, and Object(x) passes a
// non-nullish argument through. Registering the global as an object broke all
// three — and `new Object()` is used constantly.
console.log(typeof Object, typeof Object.keys, typeof Object.assign);
console.log(typeof new Object(), JSON.stringify(new Object()));
console.log(JSON.stringify(Object({ a: 1 })), JSON.stringify(Object()));
console.log(JSON.stringify(Object.keys({ x: 1, y: 2 })));
console.log(JSON.stringify(Object.assign({}, { a: 1 }, { b: 2 })));
console.log(Object.prototype.toString.call([]));
console.log(new Object() instanceof Object, {} instanceof Object);
