// var hoists to the function scope through nesting; let/const do not.
if (false) { var z = 1; }
console.log(typeof z);
for (var i = 0; i < 3; i++) {}
console.log(i);
function outer() { if (true) { var inner = "hoisted"; } return inner; }
console.log(outer());

// let gets a fresh binding per iteration
const fns = []; for (let j = 0; j < 3; j++) fns.push(() => j);
console.log(fns.map(f => f()).join(","));

// Array is callable and constructible, and has a prototype
console.log(new Array(3).length, Array(2).length, Array(1,2,3).join("-"));
function args1() { return Array.prototype.slice.call(arguments, 1); }
console.log(JSON.stringify(args1(1,2,3)));

// array length is writable
const a = [1,2,3]; a.length = 1; console.log(JSON.stringify(a));
a.length = 3; console.log(a.length, a[2]);

// accessors survive reads through optional chaining and calls
const o = {}; Object.defineProperty(o, 'q', { get: () => 42 });
console.log(o.q, o?.q, o['q'], o?.['q']);
const m = {}; Object.defineProperty(m, 'fn', { get: () => (() => "called") });
console.log(m.fn());

// Map/Set iterate directly
const mp = new Map([["a",1],["b",2]]);
for (const [k,v] of mp) console.log(k,v);
for (const v of new Set([7,8])) console.log(v);

// runaway recursion is catchable.
// NB: not a tail call — `return boom()` is optimised into an infinite loop by
// JSC's proper tail calls, so bun spins at 100% CPU instead of overflowing.
function boom(n) { return boom(n + 1) + 1; }
try { boom(0); } catch (e) { console.log("caught", e.name); }
console.log("survived");
