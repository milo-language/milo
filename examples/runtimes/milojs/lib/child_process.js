// node:child_process — milojs cannot spawn processes. Exposed so requires
// resolve; anything that would actually run a process throws rather than
// silently doing nothing.
function notSupported(name) {
  return function () {
    throw new Error('child_process.' + name + ' is not supported under milojs');
  };
}
exports.spawn = notSupported('spawn');
exports.spawnSync = notSupported('spawnSync');
exports.exec = notSupported('exec');
exports.execSync = notSupported('execSync');
exports.execFile = notSupported('execFile');
exports.fork = notSupported('fork');
