// A derived class with no own constructor must forward args to the parent
// constructor — the implicit `constructor(...args){ super(...args) }`. zod's
// ZodString extends ZodType with no own constructor, so without this every
// z.string() had an undefined _def and the whole tRPC/zod layer failed.
class Base { constructor(def) { this._def = def; } val() { return this._def; } }
class Derived extends Base {}
const d = new Derived({ x: 1 });
console.log(JSON.stringify(d._def), d.val(), d instanceof Base, d instanceof Derived);
class Mid extends Base {}
class Leaf extends Mid {}
const l = new Leaf({ y: 2 });
console.log(JSON.stringify(l._def), l instanceof Base, l instanceof Mid, l instanceof Leaf);
