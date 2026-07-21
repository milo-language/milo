// Array.from drives Symbol.iterator for real iterables (before the array-like
// fallback), and Array.from(map) yields [key,value] PAIRS not just keys.
console.log(Array.from({ length: 3 }, (_, i) => i * 2).join(","));
console.log(Array.from(new Set([1, 2, 2, 3])).join(","));
console.log(Array.from("café").join("-"));
console.log(Array.from([1, 2, 3], x => x * 10).join(","));
console.log(Array.from(new Map([["a", 1], ["b", 2]])).map(e => e.join(":")).join(","));
console.log(Array.from(new Map([["a", 1]]), ([k, v]) => k + "=" + v).join(","));
