// object literals, property get/set (dot + computed), nesting, reference
// equality, and console.log's inspect formatting
var p = { x: 1, y: 2 };
console.log(p.x, p.y);
console.log(p);

p.x = 10;
p.z = 3;
console.log(p.x, p.z);
console.log(p);

// computed access
var k = "y";
console.log(p[k]);
p["w"] = 42;
console.log(p["w"]);

// nested objects + inspect
var user = { name: "ada", addr: { city: "london", zip: "n1" } };
console.log(user.name, user.addr.city);
console.log(user);

// reference semantics: alias mutates the same object
var q = p;
q.x = 99;
console.log(p.x);
console.log(p === q, p === user);

// object returned from a function, mutated through a closure
function makeCounter() {
  var state = { n: 0 };
  return { inc: function () { state.n = state.n + 1; return state.n; } };
}
var c = makeCounter();
console.log(c.inc(), c.inc(), c.inc());

// missing property is undefined
console.log(p.nope);

// churn: allocate many short-lived objects so the GC reclaims object slots
var sum = 0;
var i = 0;
while (i < 100000) {
  var tmp = { a: i, b: i + 1 };
  sum = sum + tmp.a + tmp.b;
  i = i + 1;
}
console.log(sum);
