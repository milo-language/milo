// Object.assign onto and from functions: a function's own properties live in
// its statics, and prisma builds its debug module as Object.assign(fn, fn)
function base(x) { return "base:" + x; }
function extra(y) { return "extra:" + y; }
extra.enabled = (n) => n === "on";
extra.names = ["a"];
const merged = Object.assign(base, extra, { tag: "T" });
console.log(typeof merged, merged("q"));
console.log(typeof merged.enabled, merged.enabled("on"), merged.enabled("off"));
console.log(JSON.stringify(merged.names), merged.tag);
console.log(merged === base);
