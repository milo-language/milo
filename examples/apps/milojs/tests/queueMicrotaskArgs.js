// queueMicrotask(cb, ...extra) must call cb() with NO arguments (extra ignored),
// and its callback still runs on the microtask queue after sync code.
let order = [];
queueMicrotask(function () {
  order.push("mt args=" + arguments.length);
}, "ignored1", "ignored2");
order.push("sync");
queueMicrotask(() => {
  console.log(order.join(" | "));
});
