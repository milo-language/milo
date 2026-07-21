// &&= ||= ??= (ES2021), including short-circuit: rhs runs only when assigning.
let a = null; a ??= 5; console.log(a);
let b = 0; b ||= 9; console.log(b);
let c = 1; c &&= 7; console.log(c);
let d = 5; d ??= 99; console.log(d);
const o = { x: null, y: 2 }; o.x ??= 3; o.y &&= 4; console.log(JSON.stringify(o));
let calls = 0;
function side() { calls++; return 99; }
let e = 5; e ||= side(); console.log(e, calls);
let f = null; f ??= side(); console.log(f, calls);
const arr = [0, 1]; arr[0] ||= 8; console.log(JSON.stringify(arr));
