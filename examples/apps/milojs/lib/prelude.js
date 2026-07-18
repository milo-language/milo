// Globals that are simpler to express in JS than to build out of natives.
// Evaluated in global scope before the entry module, so everything declared here
// with `var`/`function` becomes a global binding.

// --- Intl ------------------------------------------------------------------
// A deliberately minimal, locale-ignoring stub. Packages reach for Intl to
// pretty-print numbers and dates; nothing in the target depends on real
// locale data, so formatting falls back to the plain conversions.
var Intl = {
  NumberFormat: function NumberFormat(locale, options) {
    if (!(this instanceof NumberFormat)) return new NumberFormat(locale, options);
    this.locale = locale;
    this.options = options || {};
    this.format = function (n) {
      var num = Number(n);
      var opts = this.options;
      if (opts && typeof opts.minimumFractionDigits === 'number') {
        return num.toFixed(opts.minimumFractionDigits);
      }
      return String(num);
    };
    this.resolvedOptions = function () { return { locale: this.locale || 'en-US' }; };
  },
  DateTimeFormat: function DateTimeFormat(locale, options) {
    if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locale, options);
    this.locale = locale;
    this.options = options || {};
    this.format = function (d) {
      var date = (d instanceof Date) ? d : new Date(d);
      return date.toISOString();
    };
    this.resolvedOptions = function () {
      return { locale: this.locale || 'en-US', timeZone: 'UTC' };
    };
  },
  Collator: function Collator() {
    if (!(this instanceof Collator)) return new Collator();
    this.compare = function (a, b) {
      var x = String(a), y = String(b);
      if (x < y) return -1;
      if (x > y) return 1;
      return 0;
    };
  }
};

// --- Promise combinators ---------------------------------------------------
// Written in JS on top of .then now that reactions are real. The native
// versions read promiseState at call time, so a pending element resolved as
// undefined; these wait properly.
Promise.all = function (items) {
  return new Promise(function (resolve, reject) {
    var list = [];
    for (var i = 0; i < items.length; i++) list.push(items[i]);
    var out = [];
    var remaining = list.length;
    if (remaining === 0) { resolve(out); return; }
    for (var j = 0; j < list.length; j++) {
      (function (idx) {
        Promise.resolve(list[idx]).then(function (v) {
          out[idx] = v;
          remaining -= 1;
          if (remaining === 0) resolve(out);
        }, reject);
      })(j);
    }
  });
};

Promise.allSettled = function (items) {
  return new Promise(function (resolve) {
    var list = [];
    for (var i = 0; i < items.length; i++) list.push(items[i]);
    var out = [];
    var remaining = list.length;
    if (remaining === 0) { resolve(out); return; }
    for (var j = 0; j < list.length; j++) {
      (function (idx) {
        Promise.resolve(list[idx]).then(function (v) {
          out[idx] = { status: 'fulfilled', value: v };
          remaining -= 1;
          if (remaining === 0) resolve(out);
        }, function (e) {
          out[idx] = { status: 'rejected', reason: e };
          remaining -= 1;
          if (remaining === 0) resolve(out);
        });
      })(j);
    }
  });
};

Promise.race = function (items) {
  return new Promise(function (resolve, reject) {
    for (var i = 0; i < items.length; i++) {
      Promise.resolve(items[i]).then(resolve, reject);
    }
  });
};

Promise.any = function (items) {
  return new Promise(function (resolve, reject) {
    var remaining = items.length;
    if (remaining === 0) { reject(new Error('All promises were rejected')); return; }
    for (var i = 0; i < items.length; i++) {
      Promise.resolve(items[i]).then(resolve, function (e) {
        remaining -= 1;
        if (remaining === 0) reject(e);
      });
    }
  });
};

// --- Error.captureStackTrace ------------------------------------------------
// A V8 extension that express, depd and debug all call. There are no stack
// frames to capture here, so record an empty trace rather than failing.
Error.captureStackTrace = function (target, ctor) {
  if (target && typeof target === 'object') target.stack = '';
  return undefined;
};
Error.prepareStackTrace = undefined;
Error.stackTraceLimit = 10;

// --- Buffer -----------------------------------------------------------------
// Node exposes Buffer as a global, not only via require('buffer'). express and
// body-parser both reach for it directly.
var Buffer = require('buffer').Buffer;

// --- globalThis ------------------------------------------------------------
// Not a real global object (there is no property bag behind the scope chain),
// but code that only reads well-known globals off it works.
var globalThis = {
  process: typeof process !== 'undefined' ? process : undefined,
  console: typeof console !== 'undefined' ? console : undefined,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Array: Array,
  Object: Object,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Promise: Promise,
  Map: Map,
  Set: Set,
  Error: Error,
  TypeError: TypeError,
  RangeError: RangeError,
  isNaN: isNaN,
  isFinite: isFinite,
  parseInt: parseInt,
  parseFloat: parseFloat,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent
};
var global = globalThis;

// --- structuredClone -------------------------------------------------------
function structuredClone(v) {
  return JSON.parse(JSON.stringify(v));
}
