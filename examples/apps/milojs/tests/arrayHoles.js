// delete arr[i] leaves a HOLE: length unchanged but `in`/hasOwnProperty false.
// length-grow padding and sparse writes create holes too.
const arr = [{ x: 0 }, { x: 1 }];
delete arr[1];
console.log(arr.length, 1 in arr, arr[1]);
arr.push({ y: 2 });
console.log(arr.length, 1 in arr, 2 in arr, arr[2].y);
const a = [0];
a.length = 245;
console.log(a.push(2), a.length, a[0], a[245], a.hasOwnProperty(1));
const b = [];
b[1] = 10; b[4] = 3;
console.log(b.length, 0 in b, 1 in b, b.hasOwnProperty(0), b.hasOwnProperty(1));
const c = [1, 2, 3];
delete c[1];
c[1] = 9;
console.log(1 in c, c.hasOwnProperty(1), c[1]);
const keys = []; for (const k in [1, , 3]) keys.push(k);
console.log(keys.join(","), Object.keys([1, , 3]).join(","));
