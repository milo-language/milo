// Number.prototype.toString(radix) must include the fractional part, with
// QuickJS/JSC shortest-round-trip digits.
console.log((1.3).toString(7));
console.log((1.3).toString(35));
console.log((1 - 2 ** -53).toString(12));
console.log((0.5).toString(2));
console.log((255.5).toString(16));
console.log((123.456).toString(16));
console.log((-255).toString(16));
console.log((0).toString(2));
console.log((1e30).toString(16));
console.log((0.1).toString(3));
console.log(Number.MAX_SAFE_INTEGER.toString(36));
