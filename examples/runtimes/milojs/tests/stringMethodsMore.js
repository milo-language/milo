console.log(String.fromCodePoint(72, 105), String.fromCodePoint(0x1D7D8), String.fromCodePoint(233));
console.log("hello world".search(/world/), "abc".search(/x/), "a1b2".search(/\d/));
let err = ""; try { "x".repeat(-1); } catch (e) { err = e.constructor.name; } console.log(err);
console.log("ab".repeat(3), "x".repeat(0));
