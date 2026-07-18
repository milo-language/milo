const o = { a: 1, b: 2, c: 3 };
delete o.a; console.log(JSON.stringify(o));
const k = "b"; delete o[k]; console.log(JSON.stringify(o));
const arr = [1, 2, 3]; delete arr[1]; console.log(arr.length, arr[1]);
console.log(delete o.nothere);
const nested = { x: { y: 1 } }; delete nested.x.y; console.log(JSON.stringify(nested));
