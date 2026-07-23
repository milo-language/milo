// s[i] indexes UTF-16 code units (charAt semantics), not raw UTF-8 bytes — so a
// non-ASCII char reads whole, not as its first encoding byte.
const s = "café";
console.log(s[0], s[3], s.charAt(3), s[3] === s.charAt(3));
console.log("über"[0], "20°C"[2], "señor"[3]);
console.log(s[4], s[10]);
console.log([s[0], s[1], s[2], s[3]].join(""));
