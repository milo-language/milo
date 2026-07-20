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
    // one integer part is enough for code that reassembles the number from parts
    this.formatToParts = function (n) {
      return [{ type: 'integer', value: this.format(n) }];
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
    this.formatToParts = function (d) {
      return [{ type: 'literal', value: this.format(d) }];
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

// --- Date.UTC ---------------------------------------------------------------
// Milliseconds since the epoch for a UTC calendar date. Uses Howard Hinnant's
// days-from-civil algorithm so there is no dependence on a native UTC primitive.
Date.UTC = function (y, m, d, h, mi, s, ms) {
  var month = (m || 0) + 1; // JS months are 0-based; the algorithm wants 1-based
  var day = d === undefined ? 1 : d;
  var yy = y - (month <= 2 ? 1 : 0);
  var era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  var yoe = yy - era * 400;
  var doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  var days = era * 146097 + doe - 719468;
  return ((days * 24 + (h || 0)) * 60 + (mi || 0)) * 60 * 1000 + (s || 0) * 1000 + (ms || 0);
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

// --- BigInt -----------------------------------------------------------------
// Not arbitrary precision: values are ordinary doubles, so anything above
// 2^53 loses precision. whatwg-url uses BigInt for IPv6 arithmetic, which stays
// well inside that range; genuine big-integer maths would be wrong here.
function BigInt(v) {
  if (typeof v === 'string') {
    var t = v.trim();
    if (t.slice(-1) === 'n') t = t.slice(0, -1);
    return Number(t);
  }
  return Number(v);
}
BigInt.asUintN = function (bits, v) { return Number(v); };
BigInt.asIntN = function (bits, v) { return Number(v); };

// --- typed arrays ------------------------------------------------------------
// Backed by real JS arrays so element indexing just works — a constructor may
// return an object, and the engine honours it. Not spec typed arrays: no shared
// ArrayBuffer views, no byte packing. Enough for postal-mime and friends, which
// use them as byte vectors.
function ArrayBuffer(len) {
  if (!(this instanceof ArrayBuffer)) return new ArrayBuffer(len);
  this.byteLength = len || 0;
  this._bytes = [];
  for (var i = 0; i < (len || 0); i++) this._bytes.push(0);
}
ArrayBuffer.isView = function (v) { return !!(v && v._isTypedArray); };

function Uint8Array(arg) {
  var out;
  if (typeof arg === 'number') {
    out = [];
    for (var i = 0; i < arg; i++) out.push(0);
  } else if (arg instanceof ArrayBuffer) {
    out = arg._bytes;
  } else if (Array.isArray(arg)) {
    out = arg.slice();
  } else if (arg && arg.bytes) {
    // a Buffer
    out = arg.bytes.slice();
  } else if (arg && typeof arg.length === 'number') {
    out = [];
    for (var j = 0; j < arg.length; j++) out.push(arg[j] & 0xff);
  } else {
    out = [];
  }
  out._isTypedArray = true;
  out.byteLength = out.length;
  out.byteOffset = 0;
  out.buffer = arg instanceof ArrayBuffer ? arg : null;
  out.set = function (src, offset) {
    var o = offset || 0;
    for (var k = 0; k < src.length; k++) out[o + k] = src[k] & 0xff;
  };
  out.subarray = function (a, b) { return Uint8Array(out.slice(a, b)); };
  return out;
}
var Uint8ClampedArray = Uint8Array;
var Uint16Array = Uint8Array;
var Uint32Array = Uint8Array;
var Int8Array = Uint8Array;
var Int32Array = Uint8Array;
var Float64Array = Uint8Array;

function DataView(buf) {
  if (!(this instanceof DataView)) return new DataView(buf);
  this._b = buf && buf._bytes ? buf._bytes : (Array.isArray(buf) ? buf : []);
  this.byteLength = this._b.length;
}
DataView.prototype.getUint8 = function (o) { return this._b[o] & 0xff; };
DataView.prototype.getUint16 = function (o, le) {
  var b = this._b;
  return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]);
};
DataView.prototype.getUint32 = function (o, le) {
  var b = this._b;
  return le ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216)
            : (b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
};
DataView.prototype.setUint8 = function (o, v) { this._b[o] = v & 0xff; };

// milojs strings are UTF-8 byte buffers, so encode/decode are byte copies.
function TextEncoder() { if (!(this instanceof TextEncoder)) return new TextEncoder(); }
TextEncoder.prototype.encode = function (s) {
  var str = String(s == null ? '' : s);
  var out = [];
  for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
  return Uint8Array(out);
};
function TextDecoder(label) { if (!(this instanceof TextDecoder)) return new TextDecoder(label); this.encoding = label || 'utf-8'; }
TextDecoder.prototype.decode = function (bytes) {
  if (bytes == null) return '';
  var b = bytes._bytes ? bytes._bytes : bytes;
  var out = '';
  for (var i = 0; i < b.length; i++) out += String.fromCharCode(b[i] & 0xff);
  return out;
};

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

// --- global fetch (Node 18+ / undici surface) ------------------------------
// Backed by the __httpFetch native (synchronous connect+TLS+request/response in
// Milo). node-fetch re-exports these. Enough of the surface for the app's data
// layer: fetch(url, {method,headers,body}) -> Response with ok/status/json/text.
function Headers(init) {
  this._h = {};
  if (init) {
    if (typeof init.forEach === 'function' && !Array.isArray(init)) {
      var self = this;
      init.forEach(function (v, k) { self._h[String(k).toLowerCase()] = v; });
    } else if (Array.isArray(init)) {
      for (var i = 0; i < init.length; i++) this._h[String(init[i][0]).toLowerCase()] = init[i][1];
    } else {
      var keys = Object.keys(init);
      for (var j = 0; j < keys.length; j++) this._h[keys[j].toLowerCase()] = init[keys[j]];
    }
  }
}
Headers.prototype.get = function (k) { var v = this._h[String(k).toLowerCase()]; return v === undefined ? null : v; };
Headers.prototype.set = function (k, v) { this._h[String(k).toLowerCase()] = v; return this; };
Headers.prototype.has = function (k) { return this._h[String(k).toLowerCase()] !== undefined; };
Headers.prototype.delete = function (k) { delete this._h[String(k).toLowerCase()]; };
Headers.prototype.forEach = function (cb) {
  var keys = Object.keys(this._h);
  for (var i = 0; i < keys.length; i++) cb(this._h[keys[i]], keys[i], this);
};
Headers.prototype.entries = function () {
  var out = [], keys = Object.keys(this._h);
  for (var i = 0; i < keys.length; i++) out.push([keys[i], this._h[keys[i]]]);
  return out;
};

function Request(url, options) { this.url = url; this.options = options || {}; }

function Response(body, init) {
  init = init || {};
  this._body = body == null ? '' : String(body);
  this.status = init.status === undefined ? 200 : init.status;
  this.statusText = init.statusText || '';
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
  this.url = init.url || '';
  this.bodyUsed = false;
}
Response.prototype.text = function () { this.bodyUsed = true; return Promise.resolve(this._body); };
Response.prototype.json = function () {
  var b = this._body;
  return new Promise(function (resolve, reject) {
    try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
  });
};
Response.prototype.clone = function () {
  return new Response(this._body, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
};

// AbortController/AbortSignal — accepted and ignored (fetch is synchronous here,
// so a request can't actually be aborted mid-flight; the surface just has to exist)
function AbortController() {
  this.signal = { aborted: false, addEventListener: function () {}, removeEventListener: function () {}, onabort: null };
}
AbortController.prototype.abort = function () { this.signal.aborted = true; };
var AbortSignal = {
  timeout: function () { return { aborted: false, addEventListener: function () {}, removeEventListener: function () {} }; },
  abort: function () { return { aborted: true, addEventListener: function () {}, removeEventListener: function () {} }; }
};

function __fetchDechunk(body) {
  var out = '', pos = 0;
  while (pos < body.length) {
    var nl = body.indexOf('\r\n', pos);
    if (nl < 0) break;
    var size = parseInt(body.slice(pos, nl).split(';')[0].trim(), 16);
    if (isNaN(size) || size === 0) break;
    var start = nl + 2;
    out += body.slice(start, start + size);
    pos = start + size + 2;
  }
  return out;
}

function __fetchParse(raw, url) {
  var sep = raw.indexOf('\r\n\r\n');
  var headPart = sep < 0 ? raw : raw.slice(0, sep);
  var body = sep < 0 ? '' : raw.slice(sep + 4);
  var lines = headPart.split('\r\n');
  var sp = (lines[0] || 'HTTP/1.1 200 OK').split(' ');
  var status = parseInt(sp[1], 10) || 200;
  var headers = new Headers();
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var c = line.indexOf(':');
    if (c < 0) continue;
    headers.set(line.slice(0, c).trim(), line.slice(c + 1).trim());
  }
  if (String(headers.get('transfer-encoding') || '').toLowerCase().indexOf('chunked') >= 0) body = __fetchDechunk(body);
  return new Response(body, { status: status, statusText: sp.slice(2).join(' '), headers: headers, url: url });
}

function fetch(url, options) {
  options = options || {};
  var method = (options.method || 'GET').toUpperCase();
  var u = typeof url === 'string' ? url : (url && url.url) || String(url);
  var hdrs = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      var es = options.headers.entries();
      for (var i = 0; i < es.length; i++) hdrs[es[i][0]] = es[i][1];
    } else {
      var ks = Object.keys(options.headers);
      for (var j = 0; j < ks.length; j++) hdrs[ks[j].toLowerCase()] = options.headers[ks[j]];
    }
  }
  if (hdrs['accept'] === undefined) hdrs['accept'] = '*/*';
  hdrs['accept-encoding'] = 'identity';
  if (hdrs['user-agent'] === undefined) hdrs['user-agent'] = 'milojs-fetch/1.0';
  var body = '';
  if (options.body != null) {
    body = typeof options.body === 'string' ? options.body : (options.body && options.body.bytes ? options.body.toString() : JSON.stringify(options.body));
    if (hdrs['content-type'] === undefined && typeof options.body !== 'string') hdrs['content-type'] = 'application/json';
  }
  var headerRaw = '', hk = Object.keys(hdrs);
  for (var k = 0; k < hk.length; k++) headerRaw += hk[k] + ': ' + hdrs[hk[k]] + '\r\n';
  // The request runs on a worker OS thread (TLS included) and the event loop
  // settles this promise when the response lands, so timers keep firing and
  // concurrent requests overlap.
  return __httpFetchAsync(method, u, headerRaw, body).then(function (res) {
    if (res.length > 0 && res.charAt(0) === 'E') {
      throw new Error('fetch failed: ' + res.slice(1) + ' (' + u + ')');
    }
    return __fetchParse(res.length > 0 ? res.slice(1) : '', u);
  });
}

// make Headers for-of iterable ([[k,v],...]) — the node-http adapter does
// `for (const [k,v] of response.headers)`
Headers.prototype[Symbol.iterator] = function () { return this.entries()[Symbol.iterator](); };
Headers.prototype.keys = function () { return Object.keys(this._h)[Symbol.iterator](); };

// --- URLSearchParams / URL (WHATWG) ----------------------------------------
function URLSearchParams(init) {
  this._p = [];
  if (typeof init === 'string') {
    var s = init.charAt(0) === '?' ? init.slice(1) : init;
    if (s.length > 0) {
      var parts = s.split('&');
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        var k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
        var v = eq < 0 ? '' : parts[i].slice(eq + 1);
        this._p.push([decodeURIComponent(k.split('+').join(' ')), decodeURIComponent(v.split('+').join(' '))]);
      }
    }
  } else if (init && typeof init === 'object') {
    var ks = Object.keys(init);
    for (var j = 0; j < ks.length; j++) this._p.push([ks[j], String(init[ks[j]])]);
  }
}
URLSearchParams.prototype.get = function (k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1]; return null; };
URLSearchParams.prototype.getAll = function (k) { var o = []; for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) o.push(this._p[i][1]); return o; };
URLSearchParams.prototype.has = function (k) { return this.get(k) !== null; };
URLSearchParams.prototype.set = function (k, v) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) { this._p[i][1] = String(v); return; } this._p.push([k, String(v)]); };
URLSearchParams.prototype.append = function (k, v) { this._p.push([k, String(v)]); };
URLSearchParams.prototype.forEach = function (cb) { for (var i = 0; i < this._p.length; i++) cb(this._p[i][1], this._p[i][0], this); };
URLSearchParams.prototype.entries = function () { return this._p.slice(); };
URLSearchParams.prototype.toString = function () {
  var o = [];
  for (var i = 0; i < this._p.length; i++) o.push(encodeURIComponent(this._p[i][0]) + '=' + encodeURIComponent(this._p[i][1]));
  return o.join('&');
};
URLSearchParams.prototype[Symbol.iterator] = function () { return this._p.slice()[Symbol.iterator](); };

function URL(url, base) {
  var href = String(url);
  if (base && href.indexOf('://') < 0) {
    var b = String(base);
    href = b.replace(/\/+$/, '') + (href.charAt(0) === '/' ? '' : '/') + href;
  }
  var m = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) throw new TypeError('Invalid URL: ' + href);
  this.protocol = m[1];
  var authority = m[2];
  var at = authority.indexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  var colon = authority.indexOf(':');
  this.hostname = colon < 0 ? authority : authority.slice(0, colon);
  this.port = colon < 0 ? '' : authority.slice(colon + 1);
  this.host = authority;
  this.pathname = m[3] || '/';
  this.search = m[4] || '';
  this.hash = m[5] || '';
  this.searchParams = new URLSearchParams(this.search);
  this.origin = this.protocol + '//' + this.host;
  this.href = href;
}
URL.prototype.toString = function () { return this.href; };

// --- ReadableStream ---------------------------------------------------------
// Enough for the trpc node-http adapter: a pull/push queue with getReader().
// A read() before data arrives returns a pending promise that enqueue()/close()
// settle — which the in-place event-loop drain on await resolves.
function ReadableStream(source) {
  var self = this;
  this._chunks = [];
  this._closed = false;
  this._err = null;
  this._waiters = [];
  var controller = {
    enqueue: function (chunk) {
      if (self._waiters.length > 0) self._waiters.shift().resolve({ value: chunk, done: false });
      else self._chunks.push(chunk);
    },
    close: function () {
      self._closed = true;
      while (self._waiters.length > 0) self._waiters.shift().resolve({ value: undefined, done: true });
    },
    error: function (e) {
      self._err = e;
      while (self._waiters.length > 0) self._waiters.shift().reject(e);
    },
    get desiredSize() { return 1; }
  };
  this._controller = controller;
  if (source && typeof source.start === 'function') {
    try { source.start(controller); } catch (e) { controller.error(e); }
  }
}
ReadableStream.prototype.getReader = function () {
  var self = this;
  return {
    read: function () {
      return new Promise(function (resolve, reject) {
        if (self._err) { reject(self._err); return; }
        if (self._chunks.length > 0) { resolve({ value: self._chunks.shift(), done: false }); return; }
        if (self._closed) { resolve({ value: undefined, done: true }); return; }
        self._waiters.push({ resolve: resolve, reject: reject });
      });
    },
    releaseLock: function () {},
    cancel: function () { self._closed = true; return Promise.resolve(); }
  };
};
ReadableStream.prototype.cancel = function () { this._closed = true; return Promise.resolve(); };
// collect the whole stream into one string — used by Request/Response body accessors
function __streamToString(stream) {
  var reader = stream.getReader();
  var acc = '';
  function step() {
    return reader.read().then(function (r) {
      if (r.done) return acc;
      acc += (r.value && r.value.bytes && typeof r.value.toString === 'function') ? r.value.toString() : String(r.value);
      return step();
    });
  }
  return step();
}

// --- upgrade Request/Response to the streaming WHATWG surface ---------------
function Request(input, init) {
  init = init || {};
  this.url = (input && input.href) ? input.href : String(input);
  this.method = (init.method || (input && input.method) || 'GET').toUpperCase();
  this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || (input && input.headers) || {});
  this._bodyInit = init.body !== undefined ? init.body : (input && input._bodyInit);
  this.signal = init.signal || { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  this.bodyUsed = false;
}
Object.defineProperty(Request.prototype, 'body', {
  get: function () {
    var b = this._bodyInit;
    if (b == null) return null;
    if (b instanceof ReadableStream) return b;
    return new ReadableStream({ start: function (c) { c.enqueue(String(b)); c.close(); } });
  }
});
Request.prototype.text = function () {
  var b = this._bodyInit;
  this.bodyUsed = true;
  if (b instanceof ReadableStream) return __streamToString(b);
  return Promise.resolve(b == null ? '' : String(b));
};
Request.prototype.json = function () { return this.text().then(function (t) { return JSON.parse(t); }); };
Request.prototype.clone = function () { var r = new Request(this.url, { method: this.method, headers: this.headers, body: this._bodyInit }); return r; };

// Response gains a streaming body (the adapter reads response.body.getReader())
Response.prototype.json = function () {
  var self = this;
  return this.text().then(function (t) { return JSON.parse(t); });
};
Response.prototype.text = function () {
  this.bodyUsed = true;
  if (this._body instanceof ReadableStream) return __streamToString(this._body);
  return Promise.resolve(this._body == null ? '' : String(this._body));
};
Object.defineProperty(Response.prototype, 'body', {
  get: function () {
    if (this._body == null) return null;
    if (this._body instanceof ReadableStream) return this._body;
    var b = this._body;
    return new ReadableStream({ start: function (c) { c.enqueue(String(b)); c.close(); } });
  }
});
Response.json = function (data, init) {
  init = init || {};
  var h = new Headers(init.headers || {});
  if (!h.has('content-type')) h.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { status: init.status || 200, statusText: init.statusText, headers: h });
};

// atob/btoa: web globals node also exposes. prisma's runtime decodes its
// embedded schema with them.
function atob(data) {
  return require("buffer").Buffer.from(String(data), "base64").toString("binary");
}

function btoa(data) {
  return require("buffer").Buffer.from(String(data), "binary").toString("base64");
}

// process.dlopen(module, path, flags): how node loads a .node addon. prisma's
// query-engine loader calls it directly rather than going through require.
process.dlopen = function (mod, filename, _flags) {
  mod.exports = __napiLoad(filename);
  return mod.exports;
};

// Not shared memory — milojs is single-threaded — but the global has to exist:
// `x instanceof SharedArrayBuffer` is a common way to test for a binary buffer
// (prisma does it next to the ArrayBuffer check), and an undefined identifier
// there is a ReferenceError that aborts the whole call.
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
