// R2: two activations await one still-pending barrier; both genuinely suspend.
// An OUTSIDE timer settles it (not a participant, so neither hits the
// already-settled await path — that is R1a). Settle must wake BOTH, and
// Promise.all must resolve. Resume ORDER (R3) is best-effort on the green
// scheduler (see docs/milojs-async-suspension.md), so this collects the releases
// and prints them sorted rather than asserting a strict a-before-b order.
let resolveBarrier;
const barrier = new Promise((r) => { resolveBarrier = r; });
const released = [];
async function participant(name) {
  await barrier; // pending -> parks; both must resume and record
  released.push(name);
}
async function main() {
  const a = participant("a");
  const b = participant("b");
  setTimeout(() => resolveBarrier(), 5); // both are parked before this fires
  await Promise.all([a, b]);
  console.log(released.slice().sort().join(","));
  console.log("both done");
}
main();
