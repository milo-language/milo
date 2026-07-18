// stringify primitives
console.log(JSON.stringify(42));
console.log(JSON.stringify("hi"));
console.log(JSON.stringify(true), JSON.stringify(false), JSON.stringify(null));

// stringify objects + arrays + nesting
console.log(JSON.stringify({ a: 1, b: "two", c: true }));
console.log(JSON.stringify([1, 2, 3]));
console.log(JSON.stringify({ nested: { x: [1, 2], y: "z" }, list: [{ n: 1 }, { n: 2 }] }));

// undefined / function values: omitted in objects, null in arrays
console.log(JSON.stringify({ a: 1, b: undefined, c: function () {} }));
console.log(JSON.stringify([1, undefined, 3]));

// string escaping
console.log(JSON.stringify("quote\"back\\slash\nnewline\ttab"));

// NaN / Infinity → null
console.log(JSON.stringify({ n: 0 / 0, i: 1 / 0 }));

// parse primitives
console.log(JSON.parse("42"), JSON.parse('"str"'), JSON.parse("true"), JSON.parse("null"));

// parse objects + arrays, then read fields
var o = JSON.parse('{"name":"ada","age":36,"tags":["a","b"]}');
console.log(o.name, o.age, o.tags[1], o.tags.length);

var arr = JSON.parse("[10, 20, 30]");
console.log(arr.length, arr[0] + arr[2]);

// nested parse
var deep = JSON.parse('{"a":{"b":{"c":42}},"d":[1,[2,3]]}');
console.log(deep.a.b.c, deep.d[1][0]);

// round-trip: parse(stringify(x)) preserves structure
var original = { id: 7, items: ["x", "y"], meta: { ok: true } };
var round = JSON.parse(JSON.stringify(original));
console.log(round.id, round.items.join("-"), round.meta.ok);

// stringify then operate with array methods (the real-world path)
var data = JSON.parse('[{"v":1},{"v":2},{"v":3}]');
var total = data.map(function (d) { return d.v; }).reduce(function (a, b) { return a + b; }, 0);
console.log(total);
console.log(JSON.stringify(data.filter(function (d) { return d.v > 1; })));
