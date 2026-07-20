// Object.keys/values/entries on a primitive must not reach for a property bag
// that isn't there: a string enumerates as its character indices, every other
// primitive has none. Indexing the heap with the -1 that means "no bag" used to
// abort the process ("array index out of bounds: -1/...").
console.log(JSON.stringify(Object.keys("abc")));
console.log(JSON.stringify(Object.keys(5)), JSON.stringify(Object.keys(true)));
console.log(JSON.stringify(Object.values("ab")), JSON.stringify(Object.values(9)));
console.log(JSON.stringify(Object.entries("ab")));
console.log(JSON.stringify(Object.entries(false)), JSON.stringify(Object.getOwnPropertyNames(5)));
console.log(JSON.stringify(Object.keys({ a: 1, b: 2 })), JSON.stringify(Object.values({ a: 1 })));
console.log(JSON.stringify(Object.keys([7, 8])), JSON.stringify(Object.entries([7])));
