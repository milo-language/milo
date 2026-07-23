console.log((255).toString(16), (255).toString(2), (255).toString());
console.log((123 >>> 0).toString(16));
console.log((3.7).toFixed(2), (3.14159).toFixed(3), (-2.5).toFixed(1), (5).toFixed(0));
console.log(true.toString(), "abc".toString(), (42).valueOf());
console.log(parseInt("42"), parseInt("42px"), parseInt("0x1f"), parseInt("ff", 16), parseInt("abc"));
console.log(parseFloat("3.14"), parseFloat("2.5rem"), parseFloat("nope"), parseInt("  7  "));
console.log(parseInt("-13"), parseFloat("-0.5"));
const bound = function(){ return this.v; }.bind({v:7});
console.log(bound(), typeof bound);
function add(a,b,c) { return this.base + a + b + c; }
console.log(add.bind({base:100}, 1, 2)(3));
class K { constructor(){ this.z = 9; } m(){ return this.z; } }
const k = new K();
console.log(k.m.bind(k)());
console.log(typeof Symbol("x"));
const o = {}; Object.defineProperties(o, { a: { value: 1 }, b: { get: () => 2 } });
console.log(o.a, o.b);
