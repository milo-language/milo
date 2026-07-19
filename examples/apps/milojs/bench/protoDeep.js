// Pair D: method call resolved 3 levels up the prototype chain. Compare against
// propFew.js: getMember re-runs the linear prop scan at every proto level
// (eval.milo:715), so express-style deep class hierarchies pay chain depth x
// props per level on every call site.
const N = 500000;
class A { hit() { return 1; } }
class B extends A {}
class C extends B {}
const o = new C();
let sink = 0;
for (let i = 0; i < N; i++) {
  sink = sink + o.hit();
}
console.log(sink);
