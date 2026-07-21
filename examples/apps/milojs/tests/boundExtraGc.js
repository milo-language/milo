// Function.prototype.bind payload (target/receiver/args/method) moved to the
// JSObjExtra side table; the collector must reach it through the bound object.
// Runs under GC stress so a sweep fires while bound objects are live.
function add(a, b, c) { return this.base + a + b + c; }
const obj = { base: 100 };
const b1 = add.bind(obj, 1);
console.log(b1(2, 3));
const b2 = b1.bind({ base: 999 }, 20);
console.log(b2(30));
const arr = [3, 1, 2];
console.log(JSON.stringify(arr.sort.bind(arr)()));
let last = 0;
for (let i = 0; i < 20000; i++) {
  const f = add.bind({ base: i }, i);
  last = f(1, 1);
}
console.log(last);
