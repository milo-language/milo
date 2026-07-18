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
