// Builtin methods used as values, not just in call position.
const slice = [].slice;
console.log(typeof slice);
function f() { return slice.call(arguments, 1); }
console.log(JSON.stringify(f(1,2,3)));
const has = Object.prototype.hasOwnProperty;
console.log(has.call({a:1}, 'a'), has.call({a:1}, 'b'));
console.log(({x:1}).hasOwnProperty('x'), ({x:1}).hasOwnProperty('y'));
const join = [].join;
console.log(join.call([1,2,3], "-"));
const idx = [].indexOf;
console.log(idx.call([9,8,7], 8));
console.log(JSON.stringify([].slice.apply([1,2,3,4], [1,3])));
