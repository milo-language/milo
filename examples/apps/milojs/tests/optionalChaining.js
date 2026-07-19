var h = { present: "en-US,en;q=0.9", nested: { a: { b: 7 } } };
console.log(h["accept-language"]?.split(",")[0] || null);
console.log(h["present"]?.split(",")[0] || null);
console.log(h.missing?.foo.bar ?? "safe");
console.log(h?.nested?.a?.b);
console.log(h?.nested?.x?.b);
console.log(h.missing?.call());
console.log(h.present?.toUpperCase());
console.log((undefined)?.[0]?.[1] ?? "d");
var arr = [{n:1},{n:2}];
console.log(arr?.[1]?.n);
console.log(arr?.[5]?.n ?? "none");
function f(){ return { g: function(){ return 42; } }; }
console.log(f()?.g());
console.log(h.missing?.g().h().i() ?? "chain-safe");
