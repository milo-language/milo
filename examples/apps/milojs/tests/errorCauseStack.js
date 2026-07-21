// error .cause (ES2022) + .stack is a string headed "Name: message" (milojs has
// no backtrace, so only typeof/prefix are asserted, not the trace lines).
const e = new Error("boom", { cause: "root" });
console.log(e.cause, e.message, typeof e.stack, e.stack.startsWith("Error: boom"));
console.log(new Error("x").cause, new TypeError("t").cause);
console.log(new Error("wrap", { cause: new Error("inner") }).cause.message);
let s; try { null.x; } catch (err) { s = typeof err.stack; } console.log(s);
console.log(typeof new RangeError("r").stack, new RangeError("r").stack.startsWith("RangeError: r"));
