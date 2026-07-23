// milojs stage 1 smoke test: variables, arithmetic, strings, control flow,
// functions, closures.

var a = 2;
let b = 3;
const c = a + b * 4;
console.log(c);                    // 14
console.log(10 / 4);               // 2.5
console.log(7 % 3);                // 1
console.log(-a);                   // -2

console.log("sum:" + (2 + 3));     // sum:5
console.log("a" + "b" + "c");      // abc
console.log("x", 1, true, null, undefined); // x 1 true null undefined

if (c > 10) {
  console.log("big");
} else {
  console.log("small");
}

var i = 0;
var total = 0;
while (i < 5) {
  total = total + i;
  i = i + 1;
}
console.log(total);                // 10

function square(x) {
  return x * x;
}
console.log(square(6));            // 36

function makeAdder(x) {
  return function(y) { return x + y; };
}
var add5 = makeAdder(5);
console.log(add5(10));             // 15
console.log(add5(1) + makeAdder(100)(1)); // 107

function makeCounter() {
  var n = 0;
  return function() { n = n + 1; return n; };
}
var count = makeCounter();
count();
count();
console.log(count());              // 3

console.log(1 == "1", 1 === 2, null == undefined, "a" != "b"); // true false true true
console.log(true && "yes", false || "fallback", !0);           // yes fallback true
console.log(1 < 2, 2 <= 2, "apple" < "banana");                // true true true
console.log(0.1 + 0.2);            // 0.30000000000000004
console.log(1 / 0, 0 / 0);         // Infinity NaN
