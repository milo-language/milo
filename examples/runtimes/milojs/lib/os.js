// node:os — constants and stubs. Packages read these to decide on colours,
// temp paths and concurrency; nothing here needs real system introspection.
exports.EOL = '\n';
exports.platform = function () { return process.platform; };
exports.type = function () { return process.platform === 'darwin' ? 'Darwin' : 'Linux'; };
exports.arch = function () { return 'arm64'; };
exports.release = function () { return '0.0.0'; };
exports.hostname = function () { return 'localhost'; };
exports.tmpdir = function () { return '/tmp'; };
exports.homedir = function () { return process.env.HOME || '/'; };
exports.cpus = function () { return [{ model: 'unknown', speed: 0, times: {} }]; };
exports.totalmem = function () { return 0; };
exports.freemem = function () { return 0; };
exports.uptime = function () { return 0; };
exports.endianness = function () { return 'LE'; };
exports.userInfo = function () { return { username: 'milojs', homedir: exports.homedir() }; };
exports.networkInterfaces = function () { return {}; };
exports.constants = { signals: {}, errno: {} };

// only the dlopen flags matter here: prisma ORs them together before calling
// process.dlopen, and our loader ignores the result
exports.constants = {
  dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 8, RTLD_LOCAL: 4, RTLD_DEEPBIND: 8 },
};
