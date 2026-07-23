// String iteration (for-of, spread, Array.from) yields Unicode CODE POINTS, not
// UTF-8 bytes — so accented/multibyte text (é, °, 😀) stays whole instead of
// splitting into U+FFFD garbage. High-value: any non-ASCII data iterated.
console.log(JSON.stringify([..."café"]));
console.log(JSON.stringify(Array.from("20°C")));
console.log((() => { let r = []; for (const c of "naïve") r.push(c); return r.join("|"); })());
console.log(JSON.stringify([..."a😀b"]));
console.log("café".length, [..."café"].length, Array.from("😀").length);
console.log([..."plain ASCII"].join(""));
console.log("Ünïcödé".split("").length);
