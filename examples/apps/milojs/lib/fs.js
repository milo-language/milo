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

function makeStats(p) {
  var content = __readFileSync(p);
  var isDir = content === null || content === undefined ? true : false;
  var size = content ? content.length : 0;
  var now = Date.now();
  return {
    size: size,
    mtimeMs: now, ctimeMs: now, atimeMs: now, birthtimeMs: now,
    mtime: new Date(now), ctime: new Date(now), atime: new Date(now), birthtime: new Date(now),
    mode: 33188, ino: 0, dev: 0, nlink: 1, uid: 0, gid: 0, blksize: 4096, blocks: 0,
    isFile: function () { return !isDir; },
    isDirectory: function () { return isDir; },
    isSymbolicLink: function () { return false; },
    isBlockDevice: function () { return false; },
    isCharacterDevice: function () { return false; },
    isFIFO: function () { return false; },
    isSocket: function () { return false; }
  };
}

function statSync(p, opts) {
  if (!__fileExists(p)) {
    var e = new Error("ENOENT: no such file or directory, stat '" + p + "'");
    e.code = "ENOENT";
    e.errno = -2;
    e.path = p;
    throw e;
  }
  return makeStats(p);
}

function stat(p, optsOrCb, maybeCb) {
  var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  try { var st = statSync(p); if (cb) cb(null, st); }
  catch (e) { if (cb) cb(e); }
}

exports.statSync = statSync;
exports.lstatSync = statSync;
exports.stat = stat;
exports.lstat = stat;
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
