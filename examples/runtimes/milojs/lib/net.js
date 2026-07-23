// node:net — only what express/http touch. Real socket objects come from the
// http module; this exists so `require('net')` resolves and isIP works.
exports.isIP = function (s) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(String(s))) return 4;
  if (String(s).indexOf(':') >= 0) return 6;
  return 0;
};
exports.isIPv4 = function (s) { return exports.isIP(s) === 4; };
exports.isIPv6 = function (s) { return exports.isIP(s) === 6; };
exports.Socket = function Socket() {};
exports.createServer = function () {
  throw new Error('net.createServer is not implemented under milojs; use http');
};
