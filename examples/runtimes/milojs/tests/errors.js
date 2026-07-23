// Error objects: name + message
var e = new Error("boom");
console.log(e.name, e.message);
console.log(e instanceof Error);

// Error subtypes
var te = new TypeError("bad type");
console.log(te.name, te.message);
console.log(te instanceof TypeError, te instanceof Error);
console.log(e instanceof TypeError);

var re = new RangeError("out of range");
console.log(re instanceof RangeError, re instanceof Error, re instanceof TypeError);

// calling an Error constructor without `new` still makes an error
var e2 = Error("no new");
console.log(e2 instanceof Error, e2.message);

// throw / catch an Error, inspect it
try {
  throw new TypeError("nope");
} catch (err) {
  console.log(err instanceof TypeError, err instanceof Error, err.message);
}

// user constructor + instanceof
function Point(x, y) { this.x = x; this.y = y; }
var p = new Point(1, 2);
console.log(p instanceof Point);
console.log(p instanceof Error);
var plain = { x: 1 };
console.log(plain instanceof Point);

// a QuickJS-style test harness (the shape test262/quickjs use)
function assert(actual, expected, message) {
  if (actual === expected) { return; }
  throw new Error("assertion failed: got " + actual + ", expected " + expected);
}
function assertThrows(ctor, fn) {
  var got = false;
  try {
    fn();
  } catch (ex) {
    got = true;
    if (!(ex instanceof ctor)) {
      throw new Error("wrong error type");
    }
  }
  if (!got) { throw new Error("expected a throw"); }
}

assert(1 + 1, 2);
assert("a" + "b", "ab");
assertThrows(TypeError, function () { throw new TypeError("x"); });
assertThrows(Error, function () { throw new RangeError("subtype of Error"); });
console.log("harness ok");

// catch inspects .name to branch
function classify(fn) {
  try { fn(); } catch (ex) { return ex.name; }
  return "none";
}
console.log(classify(function () { throw new SyntaxError("s"); }));
console.log(classify(function () { return 1; }));
