// String literal escapes: \u{...} code points, \xHH, \uXXXX incl. surrogate
// pairs, and control escapes, in both quote styles and templates.
console.log("\u{1F600}", "\u{1F600}".length);
console.log("\uD83D\uDE00" === "\u{1F600}");
console.log("\u0041\u00e9\u4e2d");
console.log("\x41\x7A");
console.log(`\u{48}i \x21`);
console.log("\b\f\v".charCodeAt(0), "\b\f\v".charCodeAt(1), "\b\f\v".charCodeAt(2));
console.log("\q\0".length);
