// Object.prototype.toString type tags (the standard type-detection idiom) and
// Object.create's second descriptors argument — express builds app.request /
// app.response with Object.create(proto, { app: { value: app } }), so dropping
// the descriptors left req.app and res.app undefined and every route 500'd.
const ts = Object.prototype.toString;
console.log(ts.call({}), ts.call([]), ts.call(5), ts.call(null), ts.call(undefined), ts.call(new Date()));
const base = { hi() { return "hi"; } };
const o = Object.create(base, { x: { value: 42, enumerable: true }, g: { get: () => "getter" } });
console.log(o.x, o.g, o.hi(), Object.getPrototypeOf(o) === base);
console.log(({}).valueOf() !== undefined, base.isPrototypeOf(o));
