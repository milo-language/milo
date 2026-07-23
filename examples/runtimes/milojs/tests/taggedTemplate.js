function tag(strings, ...vals) { return strings.join("|") + "::" + vals.join(","); }
console.log(tag`a${1}b${2}c`);
const o = { m(s, ...v) { return s.length + ":" + v.length; } };
console.log(o.m`x${9}y`);
