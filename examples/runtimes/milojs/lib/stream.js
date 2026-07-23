// node:stream — Readable/Writable/Transform built on EventEmitter.
//
// No backpressure and no real flow control: a Readable buffers what it is given
// and emits it on the next tick once something is listening. That is enough for
// body-parser reading a request and for res.pipe(...) style plumbing, which is
// all the target does with streams.

var EventEmitter = require('events').EventEmitter;

function inherit(Child, Parent) {
  Child.prototype = Object.create(Parent.prototype);
  Child.prototype.constructor = Child;
}

function Readable(options) {
  EventEmitter.call(this);
  this._chunks = [];
  this._ended = false;
  this._flowing = false;
  this.readable = true;
  if (options && typeof options.read === 'function') this._read = options.read;
}
inherit(Readable, EventEmitter);

Readable.prototype.push = function (chunk) {
  if (chunk === null) {
    this._ended = true;
    if (this._flowing) this._drain();
    return false;
  }
  this._chunks.push(chunk);
  if (this._flowing) this._drain();
  return true;
};

Readable.prototype._drain = function () {
  var self = this;
  // deliver on a later tick so a listener attached after push() still sees data
  setTimeout(function () {
    while (self._chunks.length > 0) {
      self.emit('data', self._chunks.shift());
    }
    if (self._ended && !self._doneEmitted) {
      self._doneEmitted = true;
      self.emit('end');
      self.emit('close');
    }
  }, 0);
};

Readable.prototype.on = function (event, handler) {
  EventEmitter.prototype.on.call(this, event, handler);
  if (event === 'data' || event === 'end') {
    this._flowing = true;
    this._drain();
  }
  return this;
};

Readable.prototype.resume = function () { this._flowing = true; this._drain(); return this; };
Readable.prototype.pause = function () { this._flowing = false; return this; };
Readable.prototype.setEncoding = function (enc) { this._encoding = enc; return this; };
Readable.prototype.pipe = function (dest) {
  this.on('data', function (chunk) { dest.write(chunk); });
  this.on('end', function () { if (dest.end) dest.end(); });
  return dest;
};
Readable.prototype.read = function () {
  if (this._chunks.length === 0) return null;
  return this._chunks.shift();
};

// Readable.from(iterable): build a stream that emits each item then ends.
// Handles arrays, sync iterables, and async iterables (async generators).
Readable.from = function (iterable, options) {
  var r = new Readable(options);
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
    var it = iterable[Symbol.asyncIterator]();
    var pump = function () {
      it.next().then(function (res) {
        if (res.done) { r.push(null); }
        else { r.push(res.value); pump(); }
      }, function (err) { r.emit('error', err); });
    };
    pump();
    return r;
  }
  var items = Array.isArray(iterable) ? iterable.slice()
    : (iterable && typeof iterable[Symbol.iterator] === 'function') ? Array.from(iterable) : [];
  for (var i = 0; i < items.length; i++) r.push(items[i]);
  r.push(null);
  return r;
};

function Writable(options) {
  EventEmitter.call(this);
  this.writable = true;
  this._written = [];
  if (options && typeof options.write === 'function') this._writeImpl = options.write;
}
inherit(Writable, EventEmitter);

Writable.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
  if (this._writeImpl) {
    this._writeImpl(chunk, encoding, cb || function () {});
  } else {
    this._written.push(chunk);
    if (cb) cb();
  }
  return true;
};

Writable.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
  if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
  this.writable = false;
  this.emit('finish');
  this.emit('close');
  if (cb) cb();
  return this;
};

Writable.prototype.setDefaultEncoding = function () { return this; };

function Transform(options) {
  Readable.call(this, options);
  this.writable = true;
  if (options && typeof options.transform === 'function') this._transform = options.transform;
}
inherit(Transform, Readable);

Transform.prototype.write = function (chunk) {
  var self = this;
  if (this._transform) {
    this._transform(chunk, null, function (err, out) {
      if (out !== undefined && out !== null) self.push(out);
    });
  } else {
    this.push(chunk);
  }
  return true;
};
Transform.prototype.end = function (chunk) {
  if (chunk !== undefined && chunk !== null) this.write(chunk);
  this.push(null);
  return this;
};

function PassThrough(options) { Transform.call(this, options); }
inherit(PassThrough, Transform);

function pipeline() {
  var args = Array.prototype.slice.call(arguments, 0);
  var cb = typeof args[args.length - 1] === 'function' ? args.pop() : function () {};
  for (var i = 0; i + 1 < args.length; i++) args[i].pipe(args[i + 1]);
  if (args.length > 0) {
    var last = args[args.length - 1];
    if (last.on) last.on('finish', function () { cb(null); });
  }
  return args[args.length - 1];
}

// node's require('stream') is the legacy Stream constructor itself, carrying
// Readable/Writable/etc as properties. send does Stream.call(this) and inherits
// from it, so the export has to be callable.
function Stream() { EventEmitter.call(this); }
Stream.prototype = Object.create(EventEmitter.prototype);
Stream.prototype.constructor = Stream;
Stream.prototype.pipe = Readable.prototype.pipe;

Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Transform;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.Stream = Stream;
Stream.pipeline = pipeline;
Stream.finished = function (stream, cb) {
  if (stream && stream.on) stream.on('end', function () { cb(null); });
};

module.exports = Stream;
exports = module.exports;
exports.Readable = Readable;
exports.Writable = Writable;
exports.Duplex = Transform;
exports.Transform = Transform;
exports.PassThrough = PassThrough;
exports.pipeline = pipeline;
exports.finished = function (stream, cb) {
  if (stream && stream.on) stream.on('end', function () { cb(null); });
};
