// multi-declarator let/const/var
let a = 1, b = 2, c = 3;
console.log(a, b, c);
let x, y, z;
console.log(x, y, z);
const p = 10, q = 20;
console.log(p + q);
var i = 0, j = i + 5, k = j * 2;
console.log(i, j, k);

// arrow functions: expression body, block body, zero/one/many params
var double = x => x * 2;
var add = (a, b) => a + b;
var answer = () => 42;
var describe = (n) => { var label = "num:"; return label + n; };
console.log(double(5), add(3, 4), answer(), describe(7));

// arrows as array-method callbacks — the idiomatic payoff
console.log([1, 2, 3, 4].map(n => n * n));
console.log([1, 2, 3, 4, 5].filter(n => n % 2 === 1));
console.log([1, 2, 3, 4].reduce((acc, n) => acc + n, 0));
console.log(["a", "b", "c"].map((ch, idx) => idx + ch));

// curried arrows
var adder = a => b => a + b;
console.log(adder(3)(4));

// arrow captures `this` lexically (unlike a normal function)
var counter = {
  count: 10,
  makeIncrementer: function () {
    return () => { this.count = this.count + 1; return this.count; };
  },
};
var inc = counter.makeIncrementer();
console.log(inc(), inc(), counter.count);

// multi-declarator inside a for loop, arrow in the body
var results = [];
for (let m = 0, limit = 3; m < limit; m++) {
  results.push((() => m * 10)());
}
console.log(results);

// chained arrows over data
var data = [{ v: 1 }, { v: 2 }, { v: 3 }];
console.log(data.map(d => d.v).filter(v => v > 1).reduce((s, v) => s + v, 0));

// arrow returning an object literal needs parens
var makePoint = (x, y) => ({ x: x, y: y });
var pt = makePoint(3, 4);
console.log(pt.x, pt.y);
