// Date epoch-ms and compiled-regex handle moved to the JSObjExtra side table.
// (napiFn/napiWrap moved too but need a native addon to exercise.) GC stress.
const d = new Date(1700000000000);
console.log(d.getTime(), d.getUTCFullYear());
const d2 = new Date("2020-01-15T00:00:00.000Z");
console.log(d2.getTime());
const re = /(\d+)-(\w+)/g;
const m = "42-foo".match(re);
console.log(m[0]);
const re2 = /a(b+)c/;
const mm = re2.exec("xabbbcx");
console.log(mm[0], mm[1], mm.index);
console.log("a1b2c3".replace(/\d/g, "#"));
let n = 0;
for (let i = 0; i < 10000; i++) { const t = new Date(i * 1000); if (/^\d+$/.test(String(t.getTime()))) n++; }
console.log(n);
