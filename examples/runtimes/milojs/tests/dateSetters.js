// Date set*/setUTC* family (local==UTC here: 0 timezone offset). Deterministic
// via UTC + toISOString.
const d = new Date(0); d.setUTCFullYear(2020); console.log(d.getUTCFullYear(), d.toISOString());
const e = new Date(0); e.setUTCMonth(5); console.log(e.getUTCMonth(), e.toISOString());
const f = new Date(0); f.setUTCDate(15); console.log(f.getUTCDate());
const g = new Date(0); g.setUTCHours(13, 30, 45); console.log(g.getUTCHours(), g.getUTCMinutes(), g.getUTCSeconds());
const h = new Date("2024-06-15T12:00:00Z"); h.setUTCFullYear(2025, 0, 1); console.log(h.toISOString());
const i = new Date(0); i.setUTCMilliseconds(500); console.log(i.getUTCMilliseconds());
const j = new Date(1000000000000); j.setUTCSeconds(30); console.log(j.getUTCSeconds());
const k = new Date(0); console.log(k.setUTCFullYear(1999), k.getUTCFullYear());
