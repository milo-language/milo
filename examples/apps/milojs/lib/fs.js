// node:fs — the synchronous read surface, over the runtime's file natives.
"use strict";

function readFileSync(p, opts) {
  var s = __readFileSync(p);
  if (s === undefined || s === null) {
    throw new Error("ENOENT: no such file or directory, open '" + p + "'");
  }
  return s;
}

function existsSync(p) {
  return __fileExists(p);
}

function readFile(p, opts, cb) {
  var fn = typeof opts === "function" ? opts : cb;
  try {
    var data = readFileSync(p);
    if (fn) { fn(null, data); }
  } catch (e) {
    if (fn) { fn(e, undefined); }
  }
}

exports.readFileSync = readFileSync;
exports.existsSync = existsSync;
exports.readFile = readFile;
exports.promises = {};

exports.writeFileSync = function (path, data) {
  if (!__writeFileSync(String(path), String(data), false)) {
    throw new Error("ENOENT: cannot write '" + path + "'");
  }
};
exports.appendFileSync = function (path, data) {
  if (!__writeFileSync(String(path), String(data), true)) {
    throw new Error("ENOENT: cannot append to '" + path + "'");
  }
};
exports.writeFile = function (path, data, optsOrCb, maybeCb) {
  var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  var ok = __writeFileSync(String(path), String(data), false);
  if (cb) cb(ok ? null : new Error("ENOENT: cannot write '" + path + "'"));
};
