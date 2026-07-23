// `+` and String()/template coercion on objects: interp-aware ToPrimitive.
console.log([1, 2] + [3, 4]);
console.log("x=" + [1, 2, 3]);
console.log(`arr:${[1, 2, 3]}`);
console.log(`obj:${{ a: 1 }}`);
console.log(1 + 2, "a" + "b", "n" + 5, 5 + "n");
console.log({ valueOf() { return 10; } } + 5);
console.log({ toString() { return "T"; } } + "!");
console.log([1] + 1, 1 + [2]);
console.log(String([1, 2, 3]));
console.log(String([1, [2, 3]]));
console.log("" + [1, null, 2]);
