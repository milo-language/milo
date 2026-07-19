// Object.prototype.toString.call(x).slice(8, -1) is the classic type-tag idiom;
// it must ignore x's own toString.
const tag = (o) => Object.prototype.toString.call(o).slice(8, -1);
console.log(tag(undefined), tag(null), tag(1), tag("s"), tag(true));
console.log(tag([]), tag({}), tag(/x/), tag(new Date(0)), tag(function () {}));
console.log(tag(new Map()), tag(new Set()), tag(Promise.resolve()));
class Loud { toString() { return "nope"; } }
console.log(tag(new Loud()));
// borrowed from the constructor, not the prototype
console.log(Object.hasOwnProperty.call({ a: 1 }, "a"), Object.hasOwnProperty.call({}, "a"));
// this.constructor.name works through the inherited prototype link
class Base { who() { return this.constructor.name; } }
class Derived extends Base {}
console.log(new Base().who(), new Derived().who());
function Old() {}
console.log(new Old().constructor === Old);
