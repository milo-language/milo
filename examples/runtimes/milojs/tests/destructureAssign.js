// destructuring ASSIGNMENT to existing targets (distinct from `let [a,b] = ...`)
let a = 1, b = 2; [a, b] = [b, a]; console.log(a, b);
let x, y, z; [x, y, z] = [10, 20, 30]; console.log(x, y, z);
let p, q; ({ p, q } = { p: 5, q: 6 }); console.log(p, q);
let m, n; ({ a: m, b: n } = { a: 7, b: 8 }); console.log(m, n);
let first, rest; [first, ...rest] = [1, 2, 3, 4]; console.log(first, JSON.stringify(rest));
let d1, d2; [d1 = 100, d2 = 200] = [1]; console.log(d1, d2);
const o = {}; [o.x, o.y] = [9, 8]; console.log(o.x, o.y);
const arr = [0, 0]; [arr[0], arr[1]] = [3, 4]; console.log(JSON.stringify(arr));
let g, h; [[g], [h]] = [[1], [2]]; console.log(g, h);
let s1, s2; [s1, s2] = [, 5]; console.log(s1, s2);
let e, f; ({ e = 1, f = 2 } = { e: 9 }); console.log(e, f);
