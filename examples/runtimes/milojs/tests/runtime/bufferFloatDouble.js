// Buffer IEEE-754 float/double read+write (LE/BE), incl. -0, Infinity, NaN and
// float32 precision loss — done by hand since milojs typed arrays don't expose a
// shared .buffer to borrow the native conversion from.
const b = Buffer.alloc(8);
b.writeDoubleLE(1.5, 0); console.log(b.toString("hex"), b.readDoubleLE(0));
b.writeDoubleBE(3.14159, 0); console.log(b.readDoubleBE(0));
const f = Buffer.alloc(4);
f.writeFloatLE(1.5, 0); console.log(f.toString("hex"), f.readFloatLE(0));
f.writeFloatBE(-2.5, 0); console.log(f.readFloatBE(0));
const g = Buffer.alloc(8); g.writeDoubleLE(-0.0, 0); console.log(Object.is(g.readDoubleLE(0), -0));
const h = Buffer.alloc(8); h.writeDoubleBE(Infinity, 0); console.log(h.readDoubleBE(0));
const n = Buffer.alloc(8); n.writeDoubleLE(NaN, 0); console.log(Number.isNaN(n.readDoubleLE(0)));
const big = Buffer.alloc(8); big.writeDoubleLE(123456789.123456, 0); console.log(big.readDoubleLE(0));
const flt = Buffer.alloc(4); flt.writeFloatLE(0.1, 0); console.log(flt.readFloatLE(0));
