console.log(JSON.stringify(Array.from({ length: 3 }, (_, i) => i)));
console.log(JSON.stringify(Array.from({ length: 3 })));
console.log(JSON.stringify(Array.from([1, 2, 3], (x) => x * 2)));
console.log(JSON.stringify(Array.from("abc", (c) => c.toUpperCase())));
console.log(JSON.stringify(Array.from(new Set([1, 2, 2]), (x) => x + 1)));
console.log(JSON.stringify(Array.from({ length: 5 }, (_, i) => i * i)));
