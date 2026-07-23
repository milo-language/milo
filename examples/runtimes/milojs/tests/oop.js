// object method using `this`
var counter = {
  n: 0,
  inc: function () { this.n = this.n + 1; return this.n; },
};
console.log(counter.inc(), counter.inc(), counter.inc());
console.log(counter.n);

// constructor with `new` + `this`, methods assigned in the constructor
function Point(x, y) {
  this.x = x;
  this.y = y;
  this.sum = function () { return this.x + this.y; };
}
var p = new Point(3, 4);
console.log(p.x, p.y);
console.log(p.sum());

// each instance is independent
var q = new Point(10, 20);
console.log(q.sum(), p.sum());

// a constructor that returns an object replaces the instance
function Maker(v) {
  this.v = v;
  return { v: v * 100 };
}
var m = new Maker(5);
console.log(m.v);

// method on an object stored in an array, `this` still binds to the element
var shapes = [{ side: 2, area: function () { return this.side * this.side; } }];
console.log(shapes[0].area());

// `this` inside a method calling another method on the same receiver
var acct = {
  bal: 100,
  deposit: function (a) { this.bal = this.bal + a; return this; },
  report: function () { return this.bal; },
};
console.log(acct.deposit(50).report());

// nested constructor: object holding an array it fills via `this`
function Bag() {
  this.items = [];
  this.add = function (x) { this.items.push(x); return this.items.length; };
}
var bag = new Bag();
console.log(bag.add("a"), bag.add("b"), bag.add("c"));
console.log(bag.items);

// GC stress on method dispatch: the receiver `new Point(...)` is a temporary and
// the argument is a call — both must survive a collection triggered mid-dispatch
function id(x) { return x; }
var total = 0;
var i = 0;
while (i < 30000) {
  var pt = new Point(id(i), id(1));
  total = total + pt.sum();
  i = i + 1;
}
console.log(total);
