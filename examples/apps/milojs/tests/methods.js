// string properties + methods
var s = "Hello, World";
console.log(s.length);
console.log(s.toUpperCase());
console.log(s.toLowerCase());
console.log(s.charAt(1), s[1], s[100]);
console.log(s.indexOf("World"), s.indexOf("xyz"));
console.log(s.slice(0, 5), s.slice(7), s.slice(-5));
console.log(s.includes("World"), s.startsWith("Hello"), s.endsWith("World"));
console.log("  trim me  ".trim());
console.log("ab".repeat(3));
console.log(s.replace("World", "Milo"));

// split / join round-trip
var csv = "a,b,c,d";
var parts = csv.split(",");
console.log(parts);
console.log(parts.join("-"));
console.log("x".split("").length, "abc".split(""));

// array methods with callbacks
var nums = [1, 2, 3, 4, 5];
console.log(nums.map(function (n) { return n * n; }));
console.log(nums.filter(function (n) { return n % 2 === 0; }));
var sum = nums.reduce(function (a, b) { return a + b; }, 0);
console.log(sum);
var acc = [];
nums.forEach(function (n) { acc.push(n * 10); });
console.log(acc);

// array query + slice + reverse + concat + indexOf + includes
console.log(nums.indexOf(3), nums.indexOf(99));
console.log(nums.includes(4), nums.includes(0));
console.log(nums.slice(1, 3));
console.log([1, 2, 3].reverse());
console.log([1, 2].concat([3, 4], 5));

// chaining, the idiomatic payoff
var words = "the quick brown fox";
console.log(words.split(" ").map(function (w) { return w.toUpperCase(); }).join("_"));
console.log([1, 2, 3, 4, 5, 6].filter(function (n) { return n > 2; }).map(function (n) { return n + 1; }));

// the map callback's index argument
console.log(["a", "b", "c"].map(function (ch, i) { return i + ":" + ch; }));
