// .constructor resolves for builtins (a fallback when milojs's faked prototype
// chain has none), and native constructors expose .name. User constructors,
// resolved through the chain, are unaffected.
console.log(({}).constructor === Object, ({}).constructor.name);
console.log([].constructor === Array, [].constructor.name);
const e = new TypeError("x");
console.log(e.constructor === TypeError, e.constructor.name);
console.log(Object.prototype.constructor === Object, Array.prototype.constructor === Array);
// error thrown by the engine reports its real constructor (app error handling)
try { null.x; } catch (err) { console.log(err.constructor.name, err instanceof TypeError); }
// user classes still resolve through the chain, not the builtin fallback
class C {}
console.log((new C()).constructor === C, (new C()).constructor.name);
