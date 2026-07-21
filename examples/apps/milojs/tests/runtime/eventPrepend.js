// EventEmitter.prependListener / prependOnceListener register at the front, so
// they run before already-registered listeners; the once form fires exactly once.
const EE = require("events");
const ee = new EE();
const order = [];
ee.on("x", () => order.push("on"));
ee.prependListener("x", () => order.push("prepend"));
ee.emit("x");
console.log(order.join(","));
let n = 0;
ee.prependOnceListener("y", () => n++);
ee.emit("y"); ee.emit("y");
console.log(n, typeof ee.prependListener, typeof ee.prependOnceListener);
