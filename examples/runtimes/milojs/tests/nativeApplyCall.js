// Function.prototype.apply/call/bind on native functions (and Reflect, which
// uses fn.apply internally).
console.log(Math.max.apply(null, [1, 5, 3]), Math.min.call(null, 4, 2, 8));
console.log(String.fromCharCode.apply(null, [72, 105]));
console.log(Reflect.apply(Math.max, null, [1, 5, 3]));
console.log(Reflect.construct(Array, [1, 2, 3]).length);
const bound = Math.max.bind(null, 10);
console.log(bound(5, 20), bound(1));
console.log([].concat.apply([], [[1], [2], [3]]));
