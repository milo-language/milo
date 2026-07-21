// class fields: public + private instance fields, static fields, private
// encapsulation (non-enumerable), accessor + same-named private (no collision).
class Pub { x = 5; y = "hi"; }
const p = new Pub(); console.log(p.x, p.y);
class Priv { #x = 1; get() { return this.#x; } set(v) { this.#x = v; } }
const pr = new Priv(); console.log(pr.get()); pr.set(9); console.log(pr.get());
console.log(pr.x, JSON.stringify(pr));            // private does not leak
class St { static v = 10; static make() { return 42; } inst = 1; }
console.log(St.v, St.make(), new St().inst);
class G { #v = 1; get v() { return this.#v; } set v(n) { this.#v = n; } }
const g = new G(); g.v = 7; console.log(g.v);      // accessor + private, no recursion
class Base { constructor() { this.b = 1; } }
class Sub extends Base { s = 2; constructor() { super(); this.t = this.b + this.s; } }
console.log(new Sub().t);
class Der extends Base { d = 9; }                  // derived, no ctor
const dd = new Der(); console.log(dd.b, dd.d);
class Mix { n = 10; constructor() { this.n = this.n + 1; } }
console.log(new Mix().n);
class Enc { #secret = 42; pub = 1; }
const e = new Enc();
console.log(JSON.stringify(e), Object.keys(e).join(","));
