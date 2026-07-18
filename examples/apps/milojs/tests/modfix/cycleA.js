exports.name = "A";
const B = require('./cycleB');
exports.fromB = B.name;
