// node:util — the commonly-used surface, in the ES5 subset milojs supports.
"use strict";

function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  var proto = {};
  for (var k in superCtor.prototype) {
    proto[k] = superCtor.prototype[k];
  }
  proto.constructor = ctor;
  ctor.prototype = proto;
}

function isArray(x) {
  return x !== null && typeof x === "object" && typeof x.length === "number" && typeof x.push === "undefined" ? false : Array.isArray ? Array.isArray(x) : false;
}

function inspect(v) {
  if (v === null) {
    return "null";
  }
  if (v === undefined) {
    return "undefined";
  }
  var t = typeof v;
  if (t === "string") {
    return "'" + v + "'";
  }
  if (t === "number" || t === "boolean") {
    return "" + v;
  }
  if (t === "function") {
    return "[Function]";
  }
  return JSON.stringify(v);
}

// util.format with %s %d %i %j %% — the subset real code uses.
function format(fmt) {
  var rest = [];
  for (var i = 1; i < arguments.length; i++) {
    rest.push(arguments[i]);
  }
  if (typeof fmt !== "string") {
    var parts = [inspect(fmt)];
    for (var k = 0; k < rest.length; k++) {
      parts.push(inspect(rest[k]));
    }
    return parts.join(" ");
  }
  var out = "";
  var ri = 0;
  var idx = 0;
  while (idx < fmt.length) {
    var c = fmt.charAt(idx);
    if (c === "%" && idx + 1 < fmt.length) {
      var n = fmt.charAt(idx + 1);
      if (n === "%") {
        out = out + "%";
        idx = idx + 2;
        continue;
      }
      if (n === "s" || n === "d" || n === "i" || n === "j") {
        if (ri < rest.length) {
          var a = rest[ri];
          ri = ri + 1;
          if (n === "s") {
            out = out + (typeof a === "string" ? a : inspect(a));
          } else if (n === "j") {
            out = out + JSON.stringify(a);
          } else {
            out = out + Math.trunc(Number(a));
          }
        } else {
          out = out + "%" + n;
        }
        idx = idx + 2;
        continue;
      }
    }
    out = out + c;
    idx = idx + 1;
  }
  for (var r = ri; r < rest.length; r++) {
    out = out + " " + inspect(rest[r]);
  }
  return out;
}

function deprecate(fn, msg) {
  return fn;
}

// Node's callback->Promise adapter. Honors util.promisify.custom, which is how
// child_process.exec advertises its {stdout,stderr} shape instead of the plain
// single-value callback contract.
function promisify(original) {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type function');
  }
  var custom = original[promisify.custom];
  if (custom) {
    if (typeof custom !== 'function') {
      throw new TypeError('The "promisify.custom" property must be of type function');
    }
    return custom;
  }
  function fn() {
    var args = Array.prototype.slice.call(arguments);
    var self = this;
    return new Promise(function (resolve, reject) {
      args.push(function (err, value) {
        if (err) { reject(err); } else { resolve(value); }
      });
      original.apply(self, args);
    });
  }
  return fn;
}
promisify.custom = '__util_promisify_custom__';

exports.promisify = promisify;
exports.inherits = inherits;
exports.inspect = inspect;
exports.format = format;
exports.deprecate = deprecate;
exports.isArray = isArray;
exports.types = {};
