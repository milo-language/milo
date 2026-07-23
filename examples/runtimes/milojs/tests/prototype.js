// shared methods via F.prototype
function Animal(name) {
  this.name = name;
}
Animal.prototype.describe = function () {
  return this.name + " the animal";
};
Animal.prototype.legs = 4;

var a = new Animal("dog");
var b = new Animal("cat");
console.log(a.describe());
console.log(b.describe());
console.log(a.legs, b.legs);

// instanceof still works with prototype-based methods
console.log(a instanceof Animal);

// own property shadows the prototype
a.legs = 3;
console.log(a.legs, b.legs);

// a prototype method calling another prototype method through `this`
function Counter() {
  this.n = 0;
}
Counter.prototype.inc = function () {
  this.n = this.n + 1;
  return this;
};
Counter.prototype.value = function () {
  return this.n;
};
var c = new Counter();
console.log(c.inc().inc().inc().value());

// prototype method used with array methods over instances
var animals = [new Animal("a"), new Animal("b"), new Animal("c")];
console.log(animals.map(function (x) { return x.describe(); }));

// classic "class" pattern: constructor + several prototype methods
function Rect(w, h) {
  this.w = w;
  this.h = h;
}
Rect.prototype.area = function () { return this.w * this.h; };
Rect.prototype.scale = function (k) { this.w = this.w * k; this.h = this.h * k; return this; };
var r = new Rect(3, 4);
console.log(r.area());
console.log(r.scale(2).area());

// a method missing on both instance and prototype is undefined
console.log(a.missing);
console.log(typeof a.describe);

// prototype shared identity: both instances see the same function
console.log(a.describe === b.describe);
