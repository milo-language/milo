// recursion, shadowing, nested closures, higher-order functions

function fib(n) {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}
console.log(fib(20)); // 6765

var x = "outer";
function shadow() {
  var x = "inner";
  return x;
}
console.log(shadow(), x); // inner outer

// two independent counters — each closure owns its own captured frame
function makeCounter(start) {
  var n = start;
  return function(step) { n = n + step; return n; };
}
var c1 = makeCounter(0);
var c2 = makeCounter(100);
c1(1); c1(1);
c2(5);
console.log(c1(1), c2(5)); // 3 110

// closure over a loop-updated variable (single var, shared)
function collectAdders() {
  var i = 0;
  var last = null;
  while (i < 3) {
    last = function() { return i; };
    i = i + 1;
  }
  return last;
}
console.log(collectAdders()()); // 3

// higher-order: compose
function compose(f, g) {
  return function(v) { return f(g(v)); };
}
function inc(v) { return v + 1; }
function double(v) { return v * 2; }
console.log(compose(inc, double)(10)); // 21

// block scoping + assignment through the chain
var acc = 0;
{
  var t = 5;
  acc = acc + t;
}
console.log(acc); // 5
