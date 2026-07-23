// Property-descriptor attributes are enforced, not just stored. Mutations are
// wrapped in try/catch so the observable end state is identical in strict and
// sloppy mode (node runs this strict; the milojs engine runs it sloppy).
const o = {};
Object.defineProperty(o, "x", { value: 1, writable: true, enumerable: false, configurable: true });
console.log(o.propertyIsEnumerable("x"), Object.keys(o).length);
Object.defineProperty(o, "y", { value: 5, writable: false, enumerable: true, configurable: true });
try { o.y = 99; } catch (e) {}
console.log(o.y, o.propertyIsEnumerable("y"));
Object.defineProperty(o, "z", { value: 7, writable: true, enumerable: true, configurable: false });
try { delete o.z; } catch (e) {}
console.log("z" in o, o.z);
const p = { a: 1 };
console.log(delete p.a, "a" in p, p.propertyIsEnumerable("a"));
