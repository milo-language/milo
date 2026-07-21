// Date.parse(str) → epoch ms (or NaN), the static that was missing alongside
// Date.now/Date.UTC.
console.log(typeof Date.parse("2020-01-01"));
console.log(Date.parse("2020-01-01T00:00:00.000Z"));
console.log(Date.parse("1970-01-01T00:00:00.000Z"));
console.log(isNaN(Date.parse("not a date")));
console.log(new Date(Date.parse("2023-11-14T22:13:20.000Z")).getUTCFullYear());
