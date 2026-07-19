// ECMAScript builtins that are easier to express in JS than to build as natives.
// Engine-level, so this is NOT the node runtime's prelude (lib/prelude.js) — only
// things the language spec itself defines belong here.

// --- destructuring support ---------------------------------------------------
// Target of the `{ a, ...rest }` desugar: every own enumerable key except the
// ones the pattern already bound.
function __objRest(src, keys) {
  var out = {};
  if (src === null || src === undefined) return out;
  for (var k in src) {
    if (keys.indexOf(k) < 0) out[k] = src[k];
  }
  return out;
}

// --- Number statics ----------------------------------------------------------
// Natives accept property assignment, so these are cheaper here than as natives.
Number.EPSILON = 2.220446049250313e-16;
Number.MAX_SAFE_INTEGER = 9007199254740991;
Number.MIN_SAFE_INTEGER = -9007199254740991;
Number.MAX_VALUE = 1.7976931348623157e308;
Number.MIN_VALUE = 5e-324;
Number.POSITIVE_INFINITY = Infinity;
Number.NEGATIVE_INFINITY = -Infinity;
Number.NaN = NaN;
Number.isNaN = function (v) {
  return typeof v === "number" && v !== v;
};
Number.isFinite = function (v) {
  return typeof v === "number" && v === v && v !== Infinity && v !== -Infinity;
};
Number.isInteger = function (v) {
  return Number.isFinite(v) && Math.floor(v) === v;
};
Number.isSafeInteger = function (v) {
  return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
};
Number.parseFloat = parseFloat;
Number.parseInt = parseInt;

// --- Object / Array statics --------------------------------------------------
Object.fromEntries = function (entries) {
  var out = {};
  for (var pair of entries) out[pair[0]] = pair[1];
  return out;
};
Array.of = function () {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(arguments[i]);
  return out;
};

// --- Symbol registry ---------------------------------------------------------
// Symbols are interned strings ("@@sym:<desc>:<n>") in this engine, so a registry
// keyed by description gives Symbol.for its required identity guarantee:
// Symbol.for(k) === Symbol.for(k).
(function () {
  var registry = {};
  Symbol.for = function (key) {
    var k = String(key);
    if (!(k in registry)) registry[k] = Symbol(k);
    return registry[k];
  };
  Symbol.keyFor = function (sym) {
    for (var k in registry) if (registry[k] === sym) return k;
    return undefined;
  };
})();

// --- Error.captureStackTrace -------------------------------------------------
// V8-specific but relied on widely. There are no real frames to walk here, so it
// only installs the property the callers expect to find.
Error.captureStackTrace = function (obj, _ctor) {
  if (obj && typeof obj === "object") obj.stack = "";
};

// --- escape / unescape (Annex B) ---------------------------------------------
var ESCAPE_SAFE = "@*_+-./";
function escape(s) {
  var str = String(s);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    var n = str.charCodeAt(i);
    var alnum =
      (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
    if (alnum || ESCAPE_SAFE.indexOf(c) >= 0) {
      out += c;
    } else if (n < 256) {
      out += "%" + (n < 16 ? "0" : "") + n.toString(16).toUpperCase();
    } else {
      var h = n.toString(16).toUpperCase();
      while (h.length < 4) h = "0" + h;
      out += "%u" + h;
    }
  }
  return out;
}
function unescape(s) {
  var str = String(s);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    if (str.charAt(i) === "%" && str.charAt(i + 1) === "u") {
      out += String.fromCharCode(parseInt(str.substring(i + 2, i + 6), 16));
      i += 5;
    } else if (str.charAt(i) === "%") {
      out += String.fromCharCode(parseInt(str.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += str.charAt(i);
    }
  }
  return out;
}

// --- WeakRef / FinalizationRegistry ------------------------------------------
// Both hold their targets STRONGLY: the mark-sweep collector has no weak-reference
// support, so deref() never returns undefined and registered callbacks never fire.
// Enough for code that merely constructs and derefs them; a test asserting that a
// target was actually collected will (correctly) fail.
class WeakRef {
  constructor(target) {
    this._target = target;
  }
  deref() {
    return this._target;
  }
}
class FinalizationRegistry {
  constructor(callback) {
    this._callback = callback;
  }
  register(_target, _held, _token) {}
  unregister(_token) {
    return false;
  }
}

// --- DOMException ------------------------------------------------------------
var DOM_ERROR_CODES = {
  IndexSizeError: 1,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};
class DOMException extends Error {
  constructor(message, name) {
    super(message === undefined ? "" : String(message));
    this.name = name === undefined ? "Error" : String(name);
    this.code = DOM_ERROR_CODES[this.name] || 0;
  }
}

// The legacy DOMException.*_ERR constants live on both the constructor and every
// instance, and are named differently from the error names above.
var DOM_LEGACY_CODES = {
  INDEX_SIZE_ERR: 1,
  DOMSTRING_SIZE_ERR: 2,
  HIERARCHY_REQUEST_ERR: 3,
  WRONG_DOCUMENT_ERR: 4,
  INVALID_CHARACTER_ERR: 5,
  NO_DATA_ALLOWED_ERR: 6,
  NO_MODIFICATION_ALLOWED_ERR: 7,
  NOT_FOUND_ERR: 8,
  NOT_SUPPORTED_ERR: 9,
  INUSE_ATTRIBUTE_ERR: 10,
  INVALID_STATE_ERR: 11,
  SYNTAX_ERR: 12,
  INVALID_MODIFICATION_ERR: 13,
  NAMESPACE_ERR: 14,
  INVALID_ACCESS_ERR: 15,
  VALIDATION_ERR: 16,
  TYPE_MISMATCH_ERR: 17,
  SECURITY_ERR: 18,
  NETWORK_ERR: 19,
  ABORT_ERR: 20,
  URL_MISMATCH_ERR: 21,
  QUOTA_EXCEEDED_ERR: 22,
  TIMEOUT_ERR: 23,
  INVALID_NODE_TYPE_ERR: 24,
  DATA_CLONE_ERR: 25,
};
for (var __k in DOM_LEGACY_CODES) {
  DOMException[__k] = DOM_LEGACY_CODES[__k];
  DOMException.prototype[__k] = DOM_LEGACY_CODES[__k];
}

// --- Array.fromAsync ---------------------------------------------------------
Array.fromAsync = async function (items, mapFn, thisArg) {
  var out = [];
  var i = 0;
  for (var item of items) {
    var v = await item;
    out.push(mapFn ? await mapFn.call(thisArg, v, i) : v);
    i++;
  }
  return out;
};
