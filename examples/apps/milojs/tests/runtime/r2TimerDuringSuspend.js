// R2: timers keep firing while an activation is suspended on a promise. The
// waiter parks on `gate`; a self-rescheduling timer chain must keep running and
// eventually release it. If await drained in place instead of suspending, the
// timer chain could not advance and this would deadlock.
let n = 0;
let release;
const gate = new Promise((r) => { release = r; });
function tick() {
  n++;
  console.log("tick", n);
  if (n < 3) setTimeout(tick, 1);
  else release();
}
setTimeout(tick, 1);
async function waiter() {
  await gate;
  console.log("released after", n, "ticks");
}
waiter();
