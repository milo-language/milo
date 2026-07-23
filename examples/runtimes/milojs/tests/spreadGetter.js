// object spread and Object.assign copy the VALUE of an accessor (invoke the
// getter), not the unused value slot.
console.log(JSON.stringify({ ...{ get x() { return 5; }, y: 2 } }));
console.log(JSON.stringify({ ...{ a: 1, get b() { return this.a + 10; } } }));
let calls = 0;
const c = { ...{ get v() { calls++; return 9; } } };
console.log(c.v, calls);
console.log(JSON.stringify(Object.assign({}, { get z() { return 7; } })));
console.log(JSON.stringify(Object.assign({ p: 1 }, { get q() { return 2; } }, { r: 3 })));
