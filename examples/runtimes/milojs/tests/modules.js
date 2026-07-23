const cfg = require('./modfix/data.json');
console.log(cfg.name, cfg.nums[1], cfg.nested.deep, cfg.esc);
console.log(JSON.stringify(cfg.nums));

const leaf = require('./modfix/leaf');
console.log(leaf.leaf, leaf.twice(21));

// require caching: same object identity on a second require
const leaf2 = require('./modfix/leaf');
console.log(leaf === leaf2);

const A = require('./modfix/cycleA');
console.log(A.name, A.fromB);
const B = require('./modfix/cycleB');
console.log(B.name, B.sawA, B.sawFromB);
