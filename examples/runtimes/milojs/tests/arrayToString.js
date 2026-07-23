// Array.prototype.toString is join(","), NOT the "[object Array]" type tag.
console.log([1, 2, 3].toString());
console.log([1, [2, 3], 4].toString());
console.log([1, [2, [3, 4]], 5].join());
console.log([].toString());
console.log([1, { a: 1 }, 2].toString());   // plain objects stay [object Object]
console.log(["a", "b", "c"].join("-"));
console.log([1, null, 2, undefined, 3].join());  // null/undefined -> empty
console.log(Object.prototype.toString.call([1, 2]));  // the type tag, unchanged
