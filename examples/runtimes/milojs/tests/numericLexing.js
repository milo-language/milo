// member access on a numeric literal (second dot) + ES2021 digit separators
console.log(0.1.toString(), 1..toString(), 0..toString(), 1.5.toFixed(0));
console.log(1_000, 1_000_000, 0xFF_FF, 1_000.5, 0b1010_0101);
console.log(1_000n, (123456_789_012n).toString());
console.log(.5, 1., 3.14, 1e10, 1_2e1_0);
console.log((255).toString(16), (5).toString(2));
