// Date valueOf's to epoch ms under the number hint (arithmetic/relational/unary+)
console.log(new Date(1000) - new Date(0));
console.log(new Date(5000) > new Date(1000));
console.log(+new Date(0), +new Date(2500));
console.log(new Date(2000) - 500);
const a = new Date("2024-01-02"), b = new Date("2024-01-01");
console.log((a - b) / 86400000);
console.log([5] * 2, [3] - 1, { valueOf() { return 10; } } * 3);
console.log("d=" + new Date(0) !== "d=");   // `+` keeps the default (string) hint
