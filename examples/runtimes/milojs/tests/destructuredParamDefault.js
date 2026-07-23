// a default on a whole destructured parameter must be parsed, and must not
// swallow the parameters that follow it
function f({ a: x, b: y, ...rest } = {}, n) {
  console.log(x, y, JSON.stringify(rest), n);
}
f({ a: 1, b: 2, c: 3 }, "CTX");
f(undefined, "CTX2");
function g({ a } = {}, n) { console.log(a, n); }
g({ a: 5 }, "CTX3");
function h({ a, ...r }, n) { console.log(a, JSON.stringify(r), n); }
h({ a: 7, z: 1 }, "CTX4");
const arrow = ({ p } = { p: "dflt" }, q) => console.log(p, q);
arrow(undefined, "CTX5");
