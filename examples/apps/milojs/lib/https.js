// node:https — TLS termination is not implemented. Exposed so requires resolve;
// createServer throws rather than silently serving plaintext on an https port.
var http = require('http');
exports.STATUS_CODES = http.STATUS_CODES;
exports.Agent = function Agent() {};
exports.globalAgent = {};
exports.createServer = function () {
  throw new Error('https.createServer is not implemented under milojs (no TLS)');
};
exports.request = function () {
  throw new Error('https.request is not implemented under milojs (no TLS)');
};
exports.get = exports.request;
