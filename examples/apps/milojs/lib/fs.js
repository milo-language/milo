// node:fs — the synchronous read surface, over the runtime's file natives.
"use strict";

function readFileSync(p, opts) {
  var s = __readFileSync(p);
  if (s === undefined || s === null) {
    // node attaches .code so callers can branch on ENOENT rather than parse the
    // message — a very common pattern (fs.readFileSync in a try/catch).
    var e = new Error("ENOENT: no such file or directory, open '" + p + "'");
    e.code = "ENOENT"; e.errno = -2; e.syscall = "open"; e.path = p;
    throw e;
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
  // real S_IFDIR check — the old "readFile returns null ⇒ directory" heuristic
  // was wrong on macOS, where reading a directory yields "" (so every dir
  // reported isDirectory() === false, breaking recursive walks).
  var isDir = __isDir(p);
  var content = isDir ? null : __readFileSync(p);
  // NOT content.length: that counts code points, so any file whose bytes decode
  // as multi-byte UTF-8 (every font, image, archive) reports short and the
  // Content-Length built from it truncates the response.
  var size = content ? __byteLength(content) : 0;
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

// --- directory + file management (over the runtime's fs natives) -------------
exports.readdirSync = function (p, opts) {
  var names = __readdirSync(String(p));
  if (names === null || names === undefined) {
    var e = new Error("ENOENT: no such file or directory, scandir '" + p + "'");
    e.code = "ENOENT"; e.path = p;
    throw e;
  }
  return names;
};
exports.readdir = function (p, optsOrCb, maybeCb) {
  var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  try { var r = exports.readdirSync(p); if (cb) cb(null, r); }
  catch (e) { if (cb) cb(e); }
};

exports.mkdirSync = function (p, opts) {
  p = String(p);
  if (opts && opts.recursive) {
    // create every missing ancestor, like `mkdir -p`
    var parts = p.split('/');
    var cur = p[0] === '/' ? '' : '.';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      cur = cur + '/' + parts[i];
      if (!__fileExists(cur)) __mkdirSync(cur);
    }
    return undefined;
  }
  if (!__mkdirSync(p)) {
    var e = new Error("EEXIST/ENOENT: cannot mkdir '" + p + "'");
    e.code = __fileExists(p) ? "EEXIST" : "ENOENT"; e.path = p;
    throw e;
  }
};
exports.mkdir = function (p, optsOrCb, maybeCb) {
  var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  var opts = typeof optsOrCb === 'object' ? optsOrCb : undefined;
  try { exports.mkdirSync(p, opts); if (cb) cb(null); }
  catch (e) { if (cb) cb(e); }
};

exports.unlinkSync = function (p) {
  if (!__unlinkSync(String(p))) {
    var e = new Error("ENOENT: no such file or directory, unlink '" + p + "'");
    e.code = "ENOENT"; e.path = p;
    throw e;
  }
};
exports.unlink = function (p, cb) {
  try { exports.unlinkSync(p); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
};

exports.rmdirSync = function (p) {
  if (!__rmdirSync(String(p))) {
    var e = new Error("ENOENT: cannot rmdir '" + p + "'");
    e.code = "ENOENT"; e.path = p;
    throw e;
  }
};
// fs.rmSync(path, {recursive, force}): recursively delete a tree, or a file.
exports.rmSync = function (p, opts) {
  p = String(p);
  var recursive = opts && opts.recursive;
  var force = opts && opts.force;
  if (!__fileExists(p)) { if (force) return; var e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }
  // a path that can't be read as a file is a directory (matches statSync)
  if (!statSync(p).isDirectory()) {
    __unlinkSync(p);
    return;
  }
  var names = __readdirSync(p) || [];
  if (!recursive && names.length > 0) throw new Error("ENOTEMPTY: directory not empty '" + p + "'");
  for (var i = 0; i < names.length; i++) exports.rmSync(p + '/' + names[i], opts);
  __rmdirSync(p);
};
exports.rm = function (p, optsOrCb, maybeCb) {
  var cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
  var opts = typeof optsOrCb === 'object' ? optsOrCb : undefined;
  try { exports.rmSync(p, opts); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
};

exports.renameSync = function (from, to) {
  if (!__renameSync(String(from), String(to))) {
    var e = new Error("ENOENT: cannot rename '" + from + "' -> '" + to + "'");
    e.code = "ENOENT"; throw e;
  }
};
exports.rename = function (from, to, cb) {
  try { exports.renameSync(from, to); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
};

exports.copyFileSync = function (from, to) {
  var data = __readFileSync(String(from));
  if (data === undefined || data === null) { var e = new Error("ENOENT: " + from); e.code = "ENOENT"; throw e; }
  if (!__writeFileSync(String(to), data, false)) throw new Error("ENOENT: cannot write '" + to + "'");
};
exports.copyFile = function (from, to, flagsOrCb, maybeCb) {
  var cb = typeof flagsOrCb === 'function' ? flagsOrCb : maybeCb;
  try { exports.copyFileSync(from, to); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
};

exports.promises.readdir = function (p) { return new Promise(function (res, rej) { try { res(exports.readdirSync(p)); } catch (e) { rej(e); } }); };
exports.promises.mkdir = function (p, opts) { return new Promise(function (res, rej) { try { exports.mkdirSync(p, opts); res(); } catch (e) { rej(e); } }); };
exports.promises.unlink = function (p) { return new Promise(function (res, rej) { try { exports.unlinkSync(p); res(); } catch (e) { rej(e); } }); };
exports.promises.rm = function (p, opts) { return new Promise(function (res, rej) { try { exports.rmSync(p, opts); res(); } catch (e) { rej(e); } }); };
exports.promises.rename = function (a, b) { return new Promise(function (res, rej) { try { exports.renameSync(a, b); res(); } catch (e) { rej(e); } }); };
exports.promises.copyFile = function (a, b) { return new Promise(function (res, rej) { try { exports.copyFileSync(a, b); res(); } catch (e) { rej(e); } }); };

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
