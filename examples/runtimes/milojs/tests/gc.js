// GC stress: every iteration allocates a fresh block scope AND a closure whose
// captured environment is dead the moment the iteration ends. Without the
// mark-sweep collector the scope arena would grow to ~800k slots; with it the
// arena stays tiny (slots reused via the free-list). The sum proves correctness;
// run with MILOJS_GC_STATS=1 to watch the arena stay bounded.
function makeAdder(x) { return function (y) { return x + y; }; }

var total = 0;
var i = 0;
while (i < 200000) {
  var add = makeAdder(i);
  total = total + add(1);
  i = i + 1;
}
console.log(total);

// closure-over-loop-var still correct after churn
function counter() {
  var n = 0;
  return function () { n = n + 1; return n; };
}
var c = counter();
var k = 0;
while (k < 5) { c(); k = k + 1; }
console.log(c());
