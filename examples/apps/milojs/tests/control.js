// C-style for loops
var sum = 0;
for (var i = 0; i < 5; i = i + 1) {
  sum = sum + i;
}
console.log(sum);

// nested for
var grid = 0;
for (var r = 0; r < 3; r = r + 1) {
  for (var c = 0; c < 3; c = c + 1) {
    grid = grid + r * c;
  }
}
console.log(grid);

// for with an array accumulator and .length
var xs = [10, 20, 30, 40];
var acc = 0;
for (var k = 0; k < xs.length; k = k + 1) {
  acc = acc + xs[k];
}
console.log(acc);

// typeof across every value kind
console.log(typeof 1, typeof "s", typeof true, typeof undefined);
console.log(typeof null, typeof {}, typeof [], typeof function () {});
console.log(typeof missingGlobal);

// try / catch with a thrown string
try {
  throw "boom";
} catch (e) {
  console.log("caught:", e);
}

// try / catch with a thrown object
try {
  throw { code: 42, msg: "bad" };
} catch (e) {
  console.log(e.code, e.msg);
}

// throw propagates across a function boundary to the caller's try
function deep() { throw "from deep"; }
function mid() { deep(); return "unreached"; }
try {
  mid();
} catch (e) {
  console.log("propagated:", e);
}

// finally always runs; catch handles, finally follows
var log = [];
try {
  log.push("try");
  throw "x";
} catch (e) {
  log.push("catch");
} finally {
  log.push("finally");
}
console.log(log);

// finally runs even when try returns
function withFinally() {
  try {
    return "ret";
  } finally {
    // side effect visible via the outer array
    order.push("fin");
  }
}
var order = [];
console.log(withFinally(), order);

// a for loop whose body throws is unwound; the count reflects the early exit
var n = 0;
try {
  for (var j = 0; j < 100; j = j + 1) {
    n = j;
    if (j === 3) { throw "stop"; }
  }
} catch (e) {
  console.log("stopped at", n, "via", e);
}
