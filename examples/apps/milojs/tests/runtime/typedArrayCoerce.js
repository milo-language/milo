// Runtime typed arrays (a per-element-type polyfill): construction coerces per
// type (Uint8Array masks to bytes, Int8/Int16/Int32 sign-extend, ClampedArray
// clamps, Float64 keeps the value), BYTES_PER_ELEMENT/byteLength are right, and
// set() coerces. (Element WRITES and wide-type ArrayBuffer views are the known
// limits — see prelude.js.)
console.log(new Uint8Array([300, 256, 1, -1]).join(","));
console.log(new Int8Array([200, -1, 127]).join(","));
console.log(new Uint8ClampedArray([300, -5, 128.7]).join(","));
console.log(new Uint16Array([70000, 65535]).join(","));
console.log(new Int32Array([4294967296, -1]).join(","));
console.log(new Float64Array([1.5, 2.5, 3.14159]).join(","));
console.log(new Uint8Array(1).BYTES_PER_ELEMENT, new Uint16Array(1).BYTES_PER_ELEMENT, new Int32Array(1).BYTES_PER_ELEMENT, new Float64Array(1).BYTES_PER_ELEMENT);
console.log(new Uint16Array(3).byteLength, new Float64Array(2).byteLength);
const a = new Uint8Array(3); a.set([300, 1], 0); console.log(a.join(","));
console.log(new Uint8Array(Buffer.from([1, 2, 255])).join(","));
