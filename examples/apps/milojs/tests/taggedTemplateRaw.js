// A tag function receives a strings array carrying a `raw` property. Libraries
// use its presence to detect tagged-template usage — prisma's $executeRaw
// refuses to run without it.
function tag(strings, ...vals) {
  console.log(Array.isArray(strings), strings.length, vals.length);
  console.log(Array.isArray(strings.raw), strings.raw.length);
  console.log(JSON.stringify(strings[0]), JSON.stringify(strings.raw[0]));
  return strings.raw.join("|") + "::" + vals.join(",");
}
console.log(tag`SELECT ${1} FROM ${"t"} x`);
console.log(tag`no holes`);
