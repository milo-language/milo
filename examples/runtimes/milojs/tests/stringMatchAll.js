console.log(JSON.stringify([..."a1b2".matchAll(/(\w)(\d)/g)].map(m => m[0])));
console.log(JSON.stringify([..."a1b2".matchAll(/(\w)(\d)/g)].map(m => [m[1], m[2]])));
console.log(JSON.stringify([..."a1b2c3".matchAll(/\d/g)].map(m => m.index)));
let out = [];
for (const m of "x=1;y=2".matchAll(/(\w)=(\d)/g)) out.push(m[1] + ":" + m[2]);
console.log(JSON.stringify(out));
console.log([..."nomatch".matchAll(/z/g)].length);
