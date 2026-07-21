// ECMAScript builtins that are easier to express in JS than to build as natives.
// Engine-level, so this is NOT the node runtime's prelude (lib/prelude.js) — only
// things the language spec itself defines belong here.

// print: the QuickJS/test262 shell global — write the space-joined arguments and
// a newline, like console.log.
var print = function () {
  console.log.apply(console, arguments);
};

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
// Array.from must accept an iterator, which the native cannot: driving next()
// means calling back into user code, and natives have no access to the program.
// Built-ins (array/string/Set/Map) fall through to the native, which handles the
// array-like case (`{length: 2}`) that has no iterator at all.
var __nativeArrayFrom = Array.from;
Array.from = function (src, mapFn, thisArg) {
  var out;
  if (src && typeof src.next === "function") {
    out = [];
    while (true) {
      var step = src.next();
      if (step.done) break;
      out.push(step.value);
    }
  } else {
    out = __nativeArrayFrom(src);
  }
  if (typeof mapFn !== "function") return out;
  var mapped = [];
  for (var i = 0; i < out.length; i++) mapped.push(mapFn.call(thisArg, out[i], i));
  return mapped;
};
Array.of = function () {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(arguments[i]);
  return out;
};

// --- Iterator helpers --------------------------------------------------------
// Installed on the shared iterator prototype the engine exposes as
// __iteratorProto, so they work on ANY iterator the engine builds — array
// iterators from arr.values() included — via the normal proto chain, rather
// than being copied onto each instance.
//
// Every helper is LAZY: take(1) on an endless source pulls exactly one element.
// `this` is the upstream iterator; each helper returns a fresh iterator that
// also inherits from __iteratorProto, so chains compose.
function __mkIter(nextFn, upstream) {
  var o = {
    next: nextFn,
    // closing forwards to the stage above exactly once, then no-ops
    return: function (v) {
      if (!o.__closed) {
        o.__closed = true;
        if (upstream && typeof upstream.return === "function") {
          return upstream.return(v);
        }
      }
      return { done: true, value: undefined };
    },
  };
  Object.setPrototypeOf(o, __iteratorProto);
  return o;
}

__iteratorProto[Symbol.iterator] = function () {
  return this;
};
__iteratorProto.map = function (fn) {
  var it = this;
  var i = 0;
  return __mkIter(function () {
    var s = it.next();
    if (s.done) return { done: true };
    return { value: fn(s.value, i++), done: false };
  }, it);
};
__iteratorProto.filter = function (fn) {
  var it = this;
  var i = 0;
  return __mkIter(function () {
    while (true) {
      var s = it.next();
      if (s.done) return { done: true };
      if (fn(s.value, i++)) return { value: s.value, done: false };
    }
  }, it);
};
__iteratorProto.take = function (n) {
  var it = this;
  var left = n;
  return __mkIter(function () {
    if (left <= 0) return { done: true };
    left--;
    return it.next();
  }, it);
};
__iteratorProto.drop = function (n) {
  var it = this;
  var left = n;
  return __mkIter(function () {
    while (left > 0) {
      left--;
      if (it.next().done) return { done: true };
    }
    return it.next();
  }, it);
};
__iteratorProto.flatMap = function (fn) {
  var it = this;
  var inner = null;
  return __mkIter(function () {
    while (true) {
      if (inner) {
        var is = inner.next();
        if (!is.done) return is;
        inner = null;
      }
      var s = it.next();
      if (s.done) return { done: true };
      // a returned array has no [Symbol.iterator] property (built-ins are
      // iterated natively), so route everything through Iterator.from
      var sub = fn(s.value);
      inner = typeof sub.next === "function" ? sub : Iterator.from(sub);
    }
  }, it);
};
__iteratorProto.toArray = function () {
  var out = [];
  while (true) {
    var s = this.next();
    if (s.done) return out;
    out.push(s.value);
  }
};
__iteratorProto.forEach = function (fn) {
  var i = 0;
  while (true) {
    var s = this.next();
    if (s.done) return undefined;
    fn(s.value, i++);
  }
};
__iteratorProto.find = function (fn) {
  var i = 0;
  while (true) {
    var s = this.next();
    if (s.done) return undefined;
    if (fn(s.value, i++)) return s.value;
  }
};
__iteratorProto.some = function (fn) {
  var i = 0;
  while (true) {
    var s = this.next();
    if (s.done) return false;
    if (fn(s.value, i++)) return true;
  }
};
__iteratorProto.every = function (fn) {
  var i = 0;
  while (true) {
    var s = this.next();
    if (s.done) return true;
    if (!fn(s.value, i++)) return false;
  }
};
__iteratorProto.reduce = function (fn, init) {
  var acc = init;
  var first = arguments.length < 2;
  while (true) {
    var s = this.next();
    if (s.done) return acc;
    if (first) {
      acc = s.value;
      first = false;
    } else {
      acc = fn(acc, s.value);
    }
  }
};

// Index-walk an array-like. Built-in arrays/strings/Set/Map are iterated natively
// by for-of and do NOT carry a [Symbol.iterator] property, so they can't be
// unwrapped the same way a user iterable can.
function __indexIter(arr) {
  var i = 0;
  return __mkIter(function () {
    if (i >= arr.length) return { done: true };
    return { value: arr[i++], done: false };
  }, null);
}

// A real constructor, not a bare object: `class X extends Iterator` has to give
// its instances the helpers, which only works if Iterator.prototype IS the shared
// prototype.
function Iterator() {}
Iterator.prototype = __iteratorProto;
Iterator.from = (function () {
  return function (src) {
    if (src && typeof src.next === "function") {
      // already an iterator: give it the helpers if it lacks them
      if (typeof src.map === "function") return src;
      return __mkIter(function () {
        return src.next();
      }, src);
    }
    if (src && typeof src[Symbol.iterator] === "function") {
      return Iterator.from(src[Symbol.iterator]());
    }
    return __indexIter(__nativeArrayFrom(src));
  };
})();

// --- Reflect -----------------------------------------------------------------
// Thin wrappers over operations the evaluator already has. Proxy is NOT here:
// intercepting every property access needs evaluator traps, not a JS shim.
var Reflect = {
  get: function (target, key) {
    return target[key];
  },
  set: function (target, key, value) {
    target[key] = value;
    return true;
  },
  has: function (target, key) {
    return key in target;
  },
  deleteProperty: function (target, key) {
    return delete target[key];
  },
  ownKeys: function (target) {
    return Object.getOwnPropertyNames(target);
  },
  getPrototypeOf: function (target) {
    return Object.getPrototypeOf(target);
  },
  setPrototypeOf: function (target, proto) {
    Object.setPrototypeOf(target, proto);
    return true;
  },
  defineProperty: function (target, key, desc) {
    Object.defineProperty(target, key, desc);
    return true;
  },
  getOwnPropertyDescriptor: function (target, key) {
    return Object.getOwnPropertyDescriptor(target, key);
  },
  apply: function (fn, thisArg, args) {
    return fn.apply(thisArg, args);
  },
  construct: function (target, args) {
    return new target(...args);
  },
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
    var msg = message === undefined ? "" : String(message);
    var nm = name === undefined ? "Error" : String(name);
    // message/name/code are READ-ONLY on a DOMException: they are getter-only
    // accessors, so assigning to them must throw rather than silently stick.
    Object.defineProperty(this, "message", {
      get: function () { return msg; },
      set: function () { throw new TypeError("DOMException.message is read-only"); },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, "name", {
      get: function () { return nm; },
      set: function () { throw new TypeError("DOMException.name is read-only"); },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, "code", {
      get: function () { return DOM_ERROR_CODES[nm] || 0; },
      set: function () { throw new TypeError("DOMException.code is read-only"); },
      enumerable: false,
      configurable: true,
    });
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

// --- WeakMap / WeakSet -------------------------------------------------------
// The engine aliases these to Map/Set natives, which accept ANY key. The spec
// requires a TypeError for primitives (and for registered symbols), which real
// code relies on to catch mistakes — so they are real classes here.
//
// They still hold their keys STRONGLY: the collector has no weak references, so
// entries are never dropped. A test asserting that a key disappeared after its
// last reference died will correctly fail rather than pass vacuously.
function __weakKeyOk(k) {
  var t = typeof k;
  if (t === "object") return k !== null;
  if (t === "function") return true;
  // an unregistered symbol is a valid weak key; Symbol.for() ones are not
  if (t === "symbol") return Symbol.keyFor(k) === undefined;
  return false;
}

class WeakMap {
  constructor(entries) {
    this._m = new Map();
    if (entries) {
      for (var pair of entries) this.set(pair[0], pair[1]);
    }
  }
  set(k, v) {
    if (!__weakKeyOk(k)) throw new TypeError("invalid value used as WeakMap key");
    this._m.set(k, v);
    return this;
  }
  get(k) {
    return this._m.get(k);
  }
  has(k) {
    return this._m.has(k);
  }
  delete(k) {
    return this._m.delete(k);
  }
}

class WeakSet {
  constructor(values) {
    this._s = new Set();
    if (values) {
      for (var v of values) this.add(v);
    }
  }
  add(v) {
    if (!__weakKeyOk(v)) throw new TypeError("invalid value used as WeakSet key");
    this._s.add(v);
    return this;
  }
  has(v) {
    return this._s.has(v);
  }
  delete(v) {
    return this._s.delete(v);
  }
}

// --- Iterator.prototype accessors --------------------------------------------
// The spec defines Iterator.prototype[@@toStringTag] and .constructor as
// get/set ACCESSOR pairs, not data properties, with
// SetterThatIgnoresPrototypeProperties semantics: assigning through an inheriting
// object defines an own property on that object, while assigning directly on
// Iterator.prototype itself throws. Real code reads these descriptors (frameworks
// probe .constructor), so the shape has to be right, not just the value.
Symbol.toStringTag = Symbol("Symbol.toStringTag");

function __protoIgnoringSetter(home, key, label) {
  return function (v) {
    // a primitive receiver has nowhere to define an own property
    if (this === undefined || this === null || typeof this !== "object") {
      throw new TypeError("cannot set " + label + " on a non-object");
    }
    if (this === home) {
      throw new TypeError("cannot set " + label + " on the prototype itself");
    }
    var existing = Object.getOwnPropertyDescriptor(this, key);
    if (existing && existing.writable === false) {
      throw new TypeError(label + " is not writable");
    }
    // CreateDataPropertyOrThrow: adding to a non-extensible receiver throws
    if (!existing && !Object.isExtensible(this)) {
      throw new TypeError("cannot add " + label + " to a non-extensible object");
    }
    Object.defineProperty(this, key, {
      value: v,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return undefined;
  };
}

Object.defineProperty(__iteratorProto, Symbol.toStringTag, {
  get: function () {
    return "Iterator";
  },
  set: __protoIgnoringSetter(__iteratorProto, Symbol.toStringTag, "@@toStringTag"),
  enumerable: false,
  configurable: true,
});

Object.defineProperty(__iteratorProto, "constructor", {
  get: function () {
    return Iterator;
  },
  set: __protoIgnoringSetter(__iteratorProto, "constructor", "constructor"),
  enumerable: false,
  configurable: true,
});

// --- Promise combinators -----------------------------------------------------
// The native versions read each element's settled value SYNCHRONOUSLY at call
// time, so a promise still pending contributed undefined:
//   Promise.all([slowPromise, Promise.resolve(1)])  ->  [null, 1]
// Written here instead, on top of .then, so they actually wait. Doing it in JS
// also means a rejection inside allSettled is genuinely handled, rather than
// surfacing as a bogus "unhandled promise rejection".
Promise.all = function (items) {
  return new Promise(function (resolve, reject) {
    var list = Array.from(items);
    var out = [];
    var remaining = list.length;
    if (remaining === 0) {
      resolve(out);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      (function (idx, item) {
        Promise.resolve(item).then(
          function (v) {
            out[idx] = v;
            remaining--;
            if (remaining === 0) resolve(out);
          },
          function (e) {
            reject(e);
          }
        );
      })(i, list[i]);
    }
  });
};

Promise.allSettled = function (items) {
  return new Promise(function (resolve) {
    var list = Array.from(items);
    var out = [];
    var remaining = list.length;
    if (remaining === 0) {
      resolve(out);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      (function (idx, item) {
        Promise.resolve(item).then(
          function (v) {
            out[idx] = { status: "fulfilled", value: v };
            remaining--;
            if (remaining === 0) resolve(out);
          },
          function (e) {
            out[idx] = { status: "rejected", reason: e };
            remaining--;
            if (remaining === 0) resolve(out);
          }
        );
      })(i, list[i]);
    }
  });
};

Promise.race = function (items) {
  return new Promise(function (resolve, reject) {
    var list = Array.from(items);
    for (var i = 0; i < list.length; i++) {
      Promise.resolve(list[i]).then(resolve, reject);
    }
  });
};

Promise.any = function (items) {
  return new Promise(function (resolve, reject) {
    var list = Array.from(items);
    var remaining = list.length;
    var errors = [];
    if (remaining === 0) {
      reject(new Error("all promises were rejected"));
      return;
    }
    for (var i = 0; i < list.length; i++) {
      (function (idx, item) {
        Promise.resolve(item).then(resolve, function (e) {
          errors[idx] = e;
          remaining--;
          if (remaining === 0) reject(new Error("all promises were rejected"));
        });
      })(i, list[i]);
    }
  });
};

// --- queueMicrotask argument validation --------------------------------------
// The native queues whatever it is handed; the spec requires a TypeError for a
// non-callable, which is what catches the common `queueMicrotask(fn())` typo.
if (typeof queueMicrotask === "function") {
  var __nativeQueueMicrotask = queueMicrotask;
  queueMicrotask = function (cb) {
    if (typeof cb !== "function") {
      throw new TypeError("queueMicrotask requires a function argument");
    }
    return __nativeQueueMicrotask(cb);
  };
}

// --- JSON: toJSON, indent, reviver -------------------------------------------
// The native stringify/parse cannot call back into user code (natives have no
// access to the program), so the parts that need to — a toJSON() hook, a replacer,
// and parse's reviver — live here. String escaping still goes through the native,
// which is the piece that has to be exactly right.
var __nativeStringify = JSON.stringify;
var __nativeParse = JSON.parse;

JSON.stringify = function (value, replacer, space) {
  var unit = "";
  if (typeof space === "number") {
    var n = space > 10 ? 10 : space;
    for (var i = 0; i < n; i++) unit += " ";
  } else if (typeof space === "string") {
    unit = space.length > 10 ? space.slice(0, 10) : space;
  }
  var replFn = typeof replacer === "function" ? replacer : null;
  var allow = null;
  if (replacer && typeof replacer !== "function" && replacer.length !== undefined) {
    allow = [];
    for (var k = 0; k < replacer.length; k++) allow.push(String(replacer[k]));
  }

  function pad(depth) {
    var out = "";
    for (var i = 0; i < depth; i++) out += unit;
    return out;
  }

  function ser(holder, key, v, depth) {
    if (v !== null && v !== undefined && typeof v.toJSON === "function") {
      v = v.toJSON(key);
    }
    if (replFn) v = replFn.call(holder, key, v);
    if (v === null) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return __nativeStringify(v);
    if (t === "function" || t === "undefined" || t === "symbol") return undefined;

    var open = "", close = "", sep = ",", colon = ":";
    if (unit) {
      open = "\n" + pad(depth + 1);
      close = "\n" + pad(depth);
      sep = ",\n" + pad(depth + 1);
      colon = ": ";
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      var parts = [];
      for (var i = 0; i < v.length; i++) {
        var e = ser(v, String(i), v[i], depth + 1);
        // an unserialisable ELEMENT becomes null, unlike a dropped property
        parts.push(e === undefined ? "null" : e);
      }
      return "[" + open + parts.join(sep) + close + "]";
    }
    var out = [];
    for (var pk in v) {
      if (allow && allow.indexOf(pk) < 0) continue;
      var sv = ser(v, pk, v[pk], depth + 1);
      if (sv !== undefined) out.push(__nativeStringify(pk) + colon + sv);
    }
    if (out.length === 0) return "{}";
    return "{" + open + out.join(sep) + close + "}";
  }

  return ser({ "": value }, "", value, 0);
};

JSON.parse = function (text, reviver) {
  var parsed = __nativeParse(text);
  if (typeof reviver !== "function") return parsed;
  // bottom-up walk; returning undefined deletes the entry
  function walk(holder, key) {
    var val = holder[key];
    if (val !== null && typeof val === "object") {
      if (Array.isArray(val)) {
        for (var i = 0; i < val.length; i++) {
          var r = walk(val, String(i));
          if (r === undefined) delete val[i];
          else val[i] = r;
        }
      } else {
        for (var k in val) {
          var r2 = walk(val, k);
          if (r2 === undefined) delete val[k];
          else val[k] = r2;
        }
      }
    }
    return reviver.call(holder, key, val);
  }
  return walk({ "": parsed }, "");
};

// --- Math gap-fillers --------------------------------------------------------
// Expressible on top of the natives that exist. Math.fround rounds to f32
// precision by round-tripping through a Float32Array — exact now that the engine
// stores real IEEE-754 f32 bytes.
Math.fround = function (x) {
  froundBuf[0] = x;
  return froundBuf[0];
};
var froundBuf = new Float32Array(1);
Math.cbrt = function (x) {
  if (x === 0 || !isFinite(x) || x !== x) return x;
  return x < 0 ? -Math.pow(-x, 1 / 3) : Math.pow(x, 1 / 3);
};
Math.log1p = function (x) {
  return Math.log(1 + x);
};
Math.expm1 = function (x) {
  return Math.exp(x) - 1;
};
Math.hypot = function () {
  var sum = 0;
  for (var i = 0; i < arguments.length; i++) {
    var v = Number(arguments[i]);
    if (v !== v) return NaN;
    sum += v * v;
  }
  return Math.sqrt(sum);
};
Math.clz32 = function (x) {
  var v = x >>> 0;
  if (v === 0) return 32;
  var n = 0;
  while ((v & 0x80000000) === 0) {
    v = v << 1;
    n++;
  }
  return n;
};
Math.imul = function (a, b) {
  // 32-bit multiply via 16-bit halves, so the product never leaves the range
  // where doubles are exact
  var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
};
Math.sinh = function (x) { return (Math.exp(x) - Math.exp(-x)) / 2; };
Math.cosh = function (x) { return (Math.exp(x) + Math.exp(-x)) / 2; };
Math.tanh = function (x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return -1;
  var e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
};

// Not shared memory — milojs is single-threaded — but the global has to exist:
// `x instanceof SharedArrayBuffer` is a common way to test for a binary buffer,
// and an undefined identifier there is a ReferenceError that aborts the call.
function SharedArrayBuffer(length) {
  return new ArrayBuffer(length);
}

// Promise.resolve adopts any thenable, not just promises this engine created.
// Every combinator below is written on top of it, so this is the one place
// adoption has to happen — prisma's query builders are plain objects with a
// .then, and without this Promise.all resolved with the builders themselves.
Promise.resolve = function (x) {
  if (x !== null && (typeof x === 'object' || typeof x === 'function') && typeof x.then === 'function') {
    return new Promise(function (res, rej) { x.then(res, rej); });
  }
  return __promiseResolveValue(x);
};
