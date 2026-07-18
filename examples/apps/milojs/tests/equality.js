console.log(null === undefined, null == undefined);
console.log("1" === 1, "1" == 1);
console.log(0 === false, 0 == false);
console.log(NaN === NaN, NaN == NaN);
const a = {}, b = {};
console.log(a === a, a === b, a !== b);
console.log(undefined !== null, "x" !== "x");
function f(x) { switch (x) { case 0: return "zero"; case "": return "empty"; case false: return "false"; default: return "other"; } }
console.log(f(0), f(""), f(false), f(1));
console.log(NaN === NaN, isNaN(NaN), isFinite(Infinity));
console.log(Array.isArray([1,2]), Array.isArray({}));
