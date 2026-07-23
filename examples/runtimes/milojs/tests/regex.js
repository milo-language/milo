// test(): basic matching, anchors, classes, quantifiers
console.log(new RegExp("\\d+").test("abc123"), new RegExp("\\d+").test("abc"));
console.log(new RegExp("^\\d+$").test("123"), new RegExp("^\\d+$").test("12a"));
console.log(new RegExp("[a-z]+").test("Hello"), new RegExp("^[A-Z][a-z]+$").test("Hello"));
console.log(new RegExp("colou?r").test("color"), new RegExp("colou?r").test("colour"));
console.log(new RegExp("a{2,4}").test("aaa"), new RegExp("^a{2,4}$").test("aaaaa"));

// alternation + groups
console.log(new RegExp("cat|dog").test("I have a dog"));
console.log(new RegExp("(ab)+").test("ababab"));

// case-insensitive flag
console.log(new RegExp("hello", "i").test("HELLO WORLD"));
console.log(new RegExp("^[a-z]+$", "i").test("MixedCase"));

// word boundary
console.log(new RegExp("\\bcat\\b").test("the cat sat"), new RegExp("\\bcat\\b").test("category"));

// exec returns match + groups
var m = new RegExp("(\\d+)-(\\d+)").exec("range 10-20 here");
console.log(m[0], m[1], m[2]);
console.log(new RegExp("xyz").exec("abc"));

// replace with a literal and with $1
console.log("hello world".replace(new RegExp("o"), "0"));
console.log("hello world".replace(new RegExp("o", "g"), "0"));
console.log("2024-01-15".replace(new RegExp("(\\d+)-(\\d+)-(\\d+)"), "$3/$2/$1"));

// match: non-global returns first + groups; global returns all
console.log("a1b2c3".match(new RegExp("\\d", "g")));
console.log("phone: 555-1234".match(new RegExp("(\\d+)-(\\d+)"))[0]);
console.log("nope".match(new RegExp("\\d+")));

// real-world: extract words, strip whitespace runs
console.log("  hello    world  ".replace(new RegExp("\\s+", "g"), " "));
console.log("one,two,,three".split(",").filter(function (x) { return new RegExp("\\w").test(x); }));

// digits sum via match + reduce
var digits = "a1b22c333".match(new RegExp("\\d+", "g"));
console.log(digits);
console.log(digits.map(function (d) { return d.length; }));
