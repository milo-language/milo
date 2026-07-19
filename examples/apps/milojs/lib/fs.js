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

// fs.promises — the async surface the React SPA fallback uses (readFile). Backed
// by the same sync natives; each call resolves/rejects on the microtask queue.
exports.promises = {
  readFile: function (p, opts) {
    return new Promise(function (resolve, reject) {
      var s = __readFileSync(String(p));
      if (s === undefined || s === null) {
        var e = new Error("ENOENT: no such file or directory, open '" + p + "'");
        e.code = "ENOENT"; e.path = p;
        reject(e);
      } else {
        resolve(s);
      }
    });
  },
  writeFile: function (p, data) {
    return new Promise(function (resolve, reject) {
      if (__writeFileSync(String(p), String(data), false)) resolve();
      else reject(new Error("ENOENT: cannot write '" + p + "'"));
    });
  },
  stat: function (p) {
    return new Promise(function (resolve, reject) {
      try { resolve(statSync(p)); } catch (e) { reject(e); }
    });
  },
  access: function (p) {
    return new Promise(function (resolve, reject) {
      if (__fileExists(String(p))) resolve();
      else { var e = new Error("ENOENT: " + p); e.code = "ENOENT"; reject(e); }
    });
  }
};
exports.promises.lstat = exports.promises.stat;

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

// express's `send` streams static files with fs.createReadStream(path, {start,end})
// and pipes the result to the response. There is no async file IO here, so read
// the whole file synchronously and hand it over (sliced for range requests) on the
// next tick, which is when send has finished attaching its error/open/pipe wiring.
exports.createReadStream = function (path, options) {
  var Readable = require("stream").Readable;
  var rs = new Readable();
  rs.path = path;
  rs.bytesRead = 0;
  var start = options && typeof options.start === "number" ? options.start : 0;
  var hasEnd = options && typeof options.end === "number";
  var end = hasEnd ? options.end : undefined;
  setTimeout(function () {
    var content = __readFileSync(String(path));
    if (content === undefined || content === null) {
      var e = new Error("ENOENT: no such file or directory, open '" + path + "'");
      e.code = "ENOENT";
      e.path = path;
      rs.emit("error", e);
      return;
    }
    if (start > 0 || hasEnd) {
      // send passes an inclusive end offset for HTTP range requests
      content = content.slice(start, hasEnd ? end + 1 : content.length);
    }
    rs.bytesRead = content.length;
    rs.emit("open", 0);
    rs.push(content);
    rs.push(null);
  }, 0);
  rs.close = function () { return this; };
  rs.destroy = function () { this.emit("close"); return this; };
  return rs;
};

exports.createWriteStream = function (path) {
  var Writable = require("stream").Writable;
  var ws = new Writable();
  var buf = "";
  ws._writeImpl = function (chunk, enc, cb) {
    buf += chunk && chunk.bytes && typeof chunk.toString === "function" ? chunk.toString() : String(chunk);
    if (cb) cb();
  };
  ws.on("finish", function () { __writeFileSync(String(path), buf, false); });
  ws.path = path;
  return ws;
};
