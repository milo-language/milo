// rounding family
console.log(Math.floor(3.7), Math.floor(-3.2), Math.floor(5));
console.log(Math.ceil(3.2), Math.ceil(-3.7), Math.ceil(5));
console.log(Math.round(2.5), Math.round(-2.5), Math.round(2.4), Math.round(3.5));
console.log(Math.trunc(4.9), Math.trunc(-4.9));

// abs / sign
console.log(Math.abs(-7), Math.abs(7), Math.abs(-0.5));
console.log(Math.sign(-3), Math.sign(3), Math.sign(0));

// sqrt / pow
console.log(Math.sqrt(16), Math.sqrt(2));
console.log(Math.pow(2, 10), Math.pow(3, 3), Math.pow(2, 0.5));

// min / max, variadic
console.log(Math.min(3, 1, 2), Math.max(3, 1, 2));
console.log(Math.min(-5, -1), Math.max(-5, -1));

// constants
console.log(Math.PI, Math.E);

// used in expressions the way real code does
var xs = [4, 9, 16, 25];
console.log(xs.map(function (n) { return Math.sqrt(n); }));

// NaN handling
console.log(Math.floor(0 / 0), Math.min(1, 0 / 0));

// random is in [0, 1) — test the range, not the value
var r = Math.random();
console.log(r >= 0 && r < 1);
var allInRange = true;
for (var i = 0; i < 100; i++) {
  var v = Math.random();
  if (v < 0 || v >= 1) { allInRange = false; }
}
console.log(allInRange);
