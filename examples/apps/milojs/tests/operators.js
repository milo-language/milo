// postfix vs prefix ++/--
var a = 5;
console.log(a++, a);
console.log(++a, a);
console.log(a--, a);
console.log(--a, a);

// the idiomatic for loop the other agent flagged
var out = [];
for (var i = 0; i < 3; i++) {
  out.push(i);
}
console.log(out);

// compound assignment
var n = 10;
n += 5;
console.log(n);
n -= 3;
console.log(n);
n *= 2;
console.log(n);
n /= 4;
console.log(n);
n %= 4;
console.log(n);

// string concat via +=
var s = "a";
s += "b";
s += "c";
console.log(s);

// ++ / += on an object property and an array element
var o = { count: 0 };
o.count++;
o.count += 10;
console.log(o.count);

var arr = [1, 2, 3];
arr[1]++;
arr[2] += 5;
console.log(arr);

// ternary, including nested and as an argument
var x = 7;
console.log(x > 5 ? "big" : "small");
console.log(x > 10 ? "a" : x > 5 ? "b" : "c");
console.log([x % 2 === 0 ? "even" : "odd"]);

// ++ in a while condition-ish accumulation
var total = 0;
var k = 0;
while (k < 5) {
  total += k++;
}
console.log(total, k);

// classic fizzbuzz-ish loop using everything at once
var buf = [];
for (var j = 1; j <= 5; j++) {
  buf.push(j % 2 === 0 ? j * 10 : j);
}
console.log(buf);
