// instanceof against the built-in exotic constructors (Date/Map/Set/RegExp/
// Promise/ArrayBuffer) — recognised by the object's internal kind, not just user
// classes. Validators (zod etc.) rely on `x instanceof Date`.
console.log(new Date() instanceof Date, new Map() instanceof Map, new Set() instanceof Set);
console.log(/x/ instanceof RegExp, Promise.resolve() instanceof Promise, new ArrayBuffer(4) instanceof ArrayBuffer);
console.log(new Date() instanceof Object, [] instanceof Array, {} instanceof Object);
console.log(new Date() instanceof Map, new Map() instanceof Date, /x/ instanceof Date);
console.log(new Error() instanceof Error, new TypeError() instanceof Error, new TypeError() instanceof TypeError);
class Animal {} class Dog extends Animal {}
console.log(new Dog() instanceof Animal, new Dog() instanceof Dog, new Dog() instanceof Date);
