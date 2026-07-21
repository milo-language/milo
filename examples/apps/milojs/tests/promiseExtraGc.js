// Promise value+reactions moved to the JSObjExtra side table; the collector must
// reach a pending promise's value and reactions through it. GC stress.
async function main() {
  const a = await Promise.resolve(41);
  console.log(a + 1);
  const vals = await Promise.all([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]);
  console.log(vals.join(","));
  try { await Promise.reject(new Error("boom")); } catch (e) { console.log("caught", e.message); }
  const chain = await Promise.resolve(10).then(x => x * 2).then(x => x + 5);
  console.log(chain);
  let sum = 0;
  for (let i = 0; i < 8000; i++) { sum += await Promise.resolve(i % 3); }
  console.log(sum);
}
main().then(() => console.log("done"));
