// R7: an object reachable ONLY from a suspended activation must not be collected
// while it is suspended. Run under MILOJS_GC_THRESHOLD=1 to force collection
// during the park. If the activation's saved state is not walked as a GC root,
// `obj` is swept and this prints a ReferenceError or garbage instead of the tag.
let release;
const gate = new Promise((r) => { release = r; });
async function holder() {
  const obj = { tag: "unique-payload", n: 42 };
  await gate; // obj is reachable only through this suspended activation
  return obj.tag + ":" + obj.n;
}
async function main() {
  const p = holder();
  for (let i = 0; i < 20000; i++) {
    const junk = { a: i, b: i * 2 }; // allocation pressure while holder parks
  }
  release();
  console.log(await p); // unique-payload:42
}
main();
