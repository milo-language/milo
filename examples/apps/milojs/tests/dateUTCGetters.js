// getUTC* decompose in UTC (offset-invariant, so deterministic across timezones)
const d = new Date("2024-03-15T08:30:45.123Z");
console.log(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
console.log(d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), d.getUTCDay());
const e = new Date(0);
console.log(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(), e.getUTCHours());
