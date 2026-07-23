// array literals, index read/write, .length, push/pop, grow-by-assignment,
// nesting, arrays of objects, and console.log formatting
var a = [1, 2, 3];
console.log(a.length);
console.log(a[0], a[1], a[2]);
console.log(a);

a[1] = 20;
console.log(a);

// grow past the end fills holes with undefined
a[5] = 99;
console.log(a.length);
console.log(a[4], a[5]);

// push / pop
var b = [];
b.push(10);
b.push(20, 30);
console.log(b.length, b);
console.log(b.pop());
console.log(b);

// iterate with a while loop over indices, skipping holes
var sum = 0;
var i = 0;
while (i < a.length) {
  if (a[i] !== undefined) {
    sum = sum + a[i];
  }
  i = i + 1;
}
console.log(sum);

// nested arrays + arrays of objects, exercised by indexing into them
var grid = [[1, 2], [3, 4]];
console.log(grid[0][0], grid[0][1], grid[1][0], grid[1][1]);
var objs = [{ x: 1 }, { y: "hi" }];
console.log(objs[0].x, objs[1].y);

// build an array in a loop, then reduce it by hand
var squares = [];
var k = 1;
while (k <= 5) {
  squares.push(k * k);
  k = k + 1;
}
console.log(squares);

// churn: many short-lived arrays exercise the GC over the object heap
var total = 0;
var j = 0;
while (j < 50000) {
  var tmp = [j, j + 1, j + 2];
  total = total + tmp[0] + tmp[1] + tmp[2];
  j = j + 1;
}
console.log(total);
