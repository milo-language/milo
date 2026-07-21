// R2 + R3: two activations await one still-pending barrier; both genuinely
// suspend. An OUTSIDE timer settles the barrier (deliberately not a participant,
// so neither hits the already-settled await-doesn't-yield path — that is R1a,
// a separate deferred item). Settle must wake both, in registration order.
let resolveBarrier;
const barrier = new Promise((r) => { resolveBarrier = r; });
async function participant(name) {
  await barrier; // pending -> parks; registered in call order
  console.log("released", name);
}
async function main() {
  const a = participant("a");
  const b = participant("b");
  setTimeout(() => resolveBarrier(), 5); // both are parked before this fires
  await Promise.all([a, b]);
  console.log("both done");
}
main();
