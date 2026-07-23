// String.prototype / Date.prototype methods as values — qs (express's query
// parser) does `var replace = String.prototype.replace` and
// `Date.prototype.toISOString`, so the whole app failed to start without them.
console.log(String.prototype.split.call("a,b,c", ","));
console.log(String.prototype.slice.call("hello", 1, 3));
console.log(typeof String.prototype.replace, typeof Date.prototype.toISOString);
console.log(Date.prototype.toISOString.call(new Date(0)));
console.log(Date.prototype.getTime.call(new Date(1000)));
console.log(Object.prototype.toString.call(new Date()) === '[object Date]');
