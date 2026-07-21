// Number.toLocaleString() default: thousands-grouped integer, up to 3 fraction
// digits (trailing zeros stripped), en-US default locale.
console.log((1000000).toLocaleString());
console.log((1234.5678).toLocaleString());
console.log((1234.5).toLocaleString());
console.log((999).toLocaleString(), (0).toLocaleString());
console.log((-1234567).toLocaleString());
console.log((1234567890).toLocaleString(), (1000).toLocaleString());
console.log((NaN).toLocaleString(), (Infinity).toLocaleString(), (-Infinity).toLocaleString());
