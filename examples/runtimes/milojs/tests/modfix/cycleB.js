exports.name = "B";
const A = require('./cycleA');
// A is partially initialised here — that is the defined CommonJS cycle behaviour
exports.sawA = A.name;
exports.sawFromB = A.fromB;
