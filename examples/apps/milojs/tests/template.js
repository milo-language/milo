// basic interpolation
var name = "world";
console.log(`hello ${name}`);
console.log(`1 + 2 = ${1 + 2}`);
console.log(`${name} has ${name.length} letters`);

// multiple holes, expressions, nesting of member/call
var user = { first: "Ada", last: "Lovelace" };
console.log(`${user.first} ${user.last}`);
console.log(`upper: ${name.toUpperCase()}, sliced: ${name.slice(0, 3)}`);

// no leading/trailing text, and literal braces via object in a hole
console.log(`${42}`);
console.log(`count=${[1, 2, 3].length}`);

// template with an object interpolated (String coercion)
console.log(`obj: ${{ a: 1 }}`);

// escapes and a backtick
console.log(`tab\there`);
console.log(`a\`b`);

// ternary inside a hole
var n = 7;
console.log(`n is ${n % 2 === 0 ? "even" : "odd"}`);

// nested template literal in a hole
console.log(`outer ${`inner ${name}`} end`);

// templates used with array methods
console.log([1, 2, 3].map(x => `#${x}`).join(", "));

// ── spread ──
function sum3(a, b, c) { return a + b + c; }
var nums = [10, 20, 30];
console.log(sum3(...nums));

// spread in array literal
var more = [0, ...nums, 40];
console.log(more);
console.log([...nums, ...nums]);

// spread mixed with regular args
console.log(sum3(1, ...[2, 3]));

// spread of a mapped array
var doubled = [...nums.map(x => x * 2)];
console.log(doubled);

// Math.max with spread
console.log(Math.max(...[3, 1, 4, 1, 5, 9, 2, 6]));

// template + spread together
var parts = ["a", "b", "c"];
console.log(`joined: ${[...parts, "d"].join("-")}`);
