// node:path — POSIX only. Written in the ES5 subset milojs supports.
"use strict";

function normalizeParts(parts, allowAboveRoot) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === "" || p === ".") {
      continue;
    }
    if (p === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (allowAboveRoot) {
        out.push("..");
      }
      continue;
    }
    out.push(p);
  }
  return out;
}

function normalize(p) {
  var isAbs = p.charAt(0) === "/";
  var trailing = p.length > 1 && p.charAt(p.length - 1) === "/";
  var parts = normalizeParts(p.split("/"), !isAbs);
  var joined = parts.join("/");
  if (joined === "" && !isAbs) {
    joined = ".";
  }
  if (joined !== "" && trailing) {
    joined = joined + "/";
  }
  return (isAbs ? "/" : "") + joined;
}

function join() {
  var segs = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (typeof a === "string" && a !== "") {
      segs.push(a);
    }
  }
  if (segs.length === 0) {
    return ".";
  }
  return normalize(segs.join("/"));
}

function resolve() {
  var resolved = "";
  var isAbs = false;
  for (var i = arguments.length - 1; i >= 0; i--) {
    var p = arguments[i];
    if (typeof p !== "string" || p === "") {
      continue;
    }
    resolved = resolved === "" ? p : p + "/" + resolved;
    if (p.charAt(0) === "/") {
      isAbs = true;
      i = -1;
    }
  }
  var parts = normalizeParts(resolved.split("/"), !isAbs);
  var joined = parts.join("/");
  if (isAbs) {
    return "/" + joined;
  }
  return joined === "" ? "." : joined;
}

function dirname(p) {
  if (p.length === 0) {
    return ".";
  }
  var idx = -1;
  for (var i = 0; i < p.length; i++) {
    if (p.charAt(i) === "/") {
      idx = i;
    }
  }
  if (idx < 0) {
    return ".";
  }
  if (idx === 0) {
    return "/";
  }
  return p.slice(0, idx);
}

function basename(p, ext) {
  var idx = -1;
  for (var i = 0; i < p.length; i++) {
    if (p.charAt(i) === "/") {
      idx = i;
    }
  }
  var base = idx < 0 ? p : p.slice(idx + 1);
  if (ext && base.length >= ext.length && base.slice(base.length - ext.length) === ext) {
    base = base.slice(0, base.length - ext.length);
  }
  return base;
}

function extname(p) {
  var base = basename(p);
  var dot = -1;
  for (var i = 0; i < base.length; i++) {
    if (base.charAt(i) === ".") {
      dot = i;
    }
  }
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot);
}

function isAbsolute(p) {
  return p.charAt(0) === "/";
}

function relative(a, b) {
  var from = resolve(a).split("/");
  var to = resolve(b).split("/");
  var i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) {
    i = i + 1;
  }
  var up = [];
  for (var j = i; j < from.length; j++) {
    if (from[j] !== "") {
      up.push("..");
    }
  }
  for (var k = i; k < to.length; k++) {
    if (to[k] !== "") {
      up.push(to[k]);
    }
  }
  return up.join("/");
}

exports.sep = "/";
exports.delimiter = ":";
exports.normalize = normalize;
exports.join = join;
exports.resolve = resolve;
exports.dirname = dirname;
exports.basename = basename;
exports.extname = extname;
exports.isAbsolute = isAbsolute;
exports.relative = relative;
exports.posix = exports;
