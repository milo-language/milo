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
