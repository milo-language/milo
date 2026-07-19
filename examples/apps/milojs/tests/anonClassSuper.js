// two anonymous subclasses in one scope: each must keep its own base binding.
// they previously shared a `__super$` key, so A's super() resolved to A itself.
class Base {
  constructor(tag) { this.tag = tag; }
}
const A = class extends Base {};
const B = class extends A {};
console.log(new A("a").tag);
console.log(new B("b").tag);
console.log(new B("b") instanceof A);
