// Array is an object-valued constructor (not a Native), so `x instanceof Array`
// must match on the array flag; class-based instanceof is unaffected.
console.log([] instanceof Array, [] instanceof Object, ({}) instanceof Array);
console.log(new TypeError() instanceof Error, new TypeError() instanceof TypeError);
class A {}
class B extends A {}
console.log(new B() instanceof A, new B() instanceof B, new A() instanceof B);
