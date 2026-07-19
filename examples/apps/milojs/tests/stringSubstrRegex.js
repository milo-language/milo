// substr(start, length) and stateful global-regex exec (lastIndex + match.index)
// — the express content-type parser (used on every response) needs both.
console.log("application/json".substr(0, 5), "hello".substr(1, 3), "hello".substr(-2));
const re = /(\w+)=(\w+)/g;
const s = "a=1 b=2 c=3";
const out = [];
let m;
while ((m = re.exec(s)) !== null) { out.push(m[1] + ":" + m[2] + "@" + m.index); }
console.log(out.join(","));
