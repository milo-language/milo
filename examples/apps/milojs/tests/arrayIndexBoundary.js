// A valid array index is a canonical uint32 < 2^32-1, so 4294967294 is the max
// integer key; 4294967295 (2^32-1) and above, "-1", and >10-digit numbers are
// ordinary string keys — they sort after integer keys, in insertion order.
const a = { "-1": 1, "4294967295": 2, "4294967294": 3, "2": 4 };
console.log(JSON.stringify(Object.keys(a)));
const b = { 9999999999: 1, 5: 2, x: 3 };
console.log(JSON.stringify(Object.keys(b)));
const c = { 4294967294: 1, 0: 2, 4294967295: 3 };
console.log(JSON.stringify(Object.keys(c)));
