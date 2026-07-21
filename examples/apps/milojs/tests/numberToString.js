// String(n) uses plain decimal until 1e21 / below 1e-6; toPrecision switches to
// exponential when precision < digit count; toFixed keeps -0's sign;
// toExponential(>17) is the exact expansion.
console.log(String(1000000000000000128));
console.log(String(1e16), String(1e20), String(1e21));
console.log(String(0.000001), String(1e-7), String(0.0000012));
console.log(String(-1e16), String(2e15));
console.log((25).toPrecision(1), (2.5).toPrecision(1), (99.9).toPrecision(2));
console.log((-1e-10).toFixed(0), (-0.04).toFixed(1));
console.log((123.456).toExponential(100));
