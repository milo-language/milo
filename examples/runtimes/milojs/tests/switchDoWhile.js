function f(x) {
  switch (x) {
    case 1: return "one";
    case 2:
    case 3: return "two-or-three";
    default: return "other";
  }
}
console.log(f(1), f(2), f(3), f(9));
let out = [];
switch (2) { case 1: out.push("a"); case 2: out.push("b"); case 3: out.push("c"); break; case 4: out.push("d"); }
console.log(out.join(","));
let i = 0, acc = [];
do { acc.push(i); i++; } while (i < 3);
console.log(acc.join(","));
let j = 10; do { j++; } while (false); console.log(j);
