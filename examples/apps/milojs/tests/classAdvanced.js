class MyErr extends Error {
  constructor(m) { super(m); this.name = "MyErr"; }
}
const e = new MyErr("boom");
console.log(e.message, e instanceof Error, e instanceof MyErr, e.name);
try { throw new MyErr("thrown"); } catch (err) { console.log("caught", err.message, err instanceof Error); }

class A { greet() { return "A.greet"; } describe() { return "A"; } }
class B extends A { greet() { return "B+" + super.greet(); } }
console.log(new B().greet(), new B().describe());

const o = {};
Object.defineProperty(o, 'x', { get: function () { return "GOT:" + this._v; }, set: function (v) { this._v = v * 2; } });
o.x = 21;
console.log(o.x, o._v, o['x']);
Object.defineProperty(o, 'plain', { value: 5 });
console.log(o.plain);

const proto = { hello() { return "hi"; } };
const c = Object.create(proto);
console.log(c.hello(), Object.getPrototypeOf(c) === proto);
const d = {}; Object.setPrototypeOf(d, proto); console.log(d.hello());
const t = { a: 1 };
console.log(Object.getOwnPropertyDescriptor(t, 'a').value, Object.getOwnPropertyDescriptor(t, 'nope'));
