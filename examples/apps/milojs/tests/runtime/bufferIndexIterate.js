// A Buffer behaves like a Uint8Array for index + iteration: buf[i] reads/writes a
// byte, and [...buf]/for-of/Array.from(buf)/keys/values/entries walk the bytes.
const b = Buffer.from([10, 20, 30, 255]);
console.log(b[0], b[1], b[3], b[99]);
b[1] = 99; b[2] = 300; console.log(b[1], b[2], b.toString("hex"));
let sum = 0; for (let i = 0; i < b.length; i++) sum += b[i]; console.log("indexed", sum);
let s2 = 0; for (const x of b) s2 += x; console.log("forof", s2);
console.log(JSON.stringify([...b]), Array.from(b).join(","));
console.log([...b.keys()].join(","), [...b.entries()].map(e => e.join(":")).join(","));
console.log(Array.from(b, x => x + 1).join(","));
// a user object shaped like a Buffer is NOT treated as one
const o = { bytes: [1, 2, 3], length: 3, x: 5 };
console.log(o.x, o[0]);
