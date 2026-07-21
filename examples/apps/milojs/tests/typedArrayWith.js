const a = new Uint8Array([1, 2, 3, 4]);
console.log(JSON.stringify([...a.with(1, 9)]));
console.log(JSON.stringify([...a.with(-1, 7)]));
console.log(JSON.stringify([...a]));   // original unchanged
console.log(JSON.stringify([...new Int32Array([10, 20, 30]).with(0, 99)]));
