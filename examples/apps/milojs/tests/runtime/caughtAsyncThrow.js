// A caught rejection from an async function that throws must NOT be reported as
// an unhandled rejection (the throwing body wraps its error in a fresh rejected
// promise that spawnActivation adopts; that intermediate must be marked handled).
async function throws() { throw new Error("x"); }
async function main() {
  try { await throws(); } catch (e) { console.log("caught:", e.message); }
  try { await (async () => { throw new Error("y"); })(); } catch (e) { console.log("caught2:", e.message); }
  console.log("after");
}
main().then(() => console.log("done"));
