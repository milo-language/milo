// The global must exist: `x instanceof SharedArrayBuffer` is a common binary
// buffer test (prisma pairs it with the ArrayBuffer check), and an undefined
// identifier there is a ReferenceError that aborts the call.
//
// NOTE: `new ArrayBuffer(8) instanceof ArrayBuffer` is true under milojs.milo
// but false under milojs-engine — a separate, pre-existing gap in the engine
// build's native-constructor instanceof, so it is not asserted here.
console.log(typeof SharedArrayBuffer);
const sab = new SharedArrayBuffer(4);
console.log(sab.byteLength);
console.log(new ArrayBuffer(8) instanceof SharedArrayBuffer);
