async function ret() { return 42; }
async function thr() { throw new Error("boom"); }
async function awaitsRejection() {
  try { await thr(); return "no throw"; }
  catch (e) { return "caught " + e.message; }
}
async function main() {
  console.log("return settles:", await ret());
  await thr().then(() => console.log("BAD resolved"), (e) => console.log("throw rejects:", e.message));
  console.log("await of rejection:", await awaitsRejection());
  const r = await Promise.allSettled([ret(), thr()]);
  console.log("allSettled:", r.map(x => x.status).join(","));
}
main();
