// node:events — EventEmitter in the ES5 subset milojs supports. Uses spread
// rather than fn.apply, and never stores properties on a function value.
"use strict";

function EventEmitter() {
  this._events = {};
}

EventEmitter.prototype._list = function (name) {
  if (!this._events) {
    this._events = {};
  }
  if (!this._events[name]) {
    this._events[name] = [];
  }
  return this._events[name];
};

EventEmitter.prototype.on = function (name, fn) {
  this._list(name).push(fn);
  return this;
};

EventEmitter.prototype.addListener = function (name, fn) {
  return this.on(name, fn);
};

EventEmitter.prototype.once = function (name, fn) {
  var self = this;
  var fired = false;
  var wrapper = function () {
    if (fired) {
      return undefined;
    }
    fired = true;
    self.removeListener(name, wrapper);
    return fn(...arguments);
  };
  return this.on(name, wrapper);
};

EventEmitter.prototype.removeListener = function (name, fn) {
  var list = this._list(name);
  var kept = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] !== fn) {
      kept.push(list[i]);
    }
  }
  this._events[name] = kept;
  return this;
};

EventEmitter.prototype.off = function (name, fn) {
  return this.removeListener(name, fn);
};

EventEmitter.prototype.removeAllListeners = function (name) {
  if (name === undefined) {
    this._events = {};
  } else {
    this._events[name] = [];
  }
  return this;
};

EventEmitter.prototype.listeners = function (name) {
  var list = this._list(name);
  var copy = [];
  for (var i = 0; i < list.length; i++) {
    copy.push(list[i]);
  }
  return copy;
};

EventEmitter.prototype.listenerCount = function (name) {
  return this._list(name).length;
};

EventEmitter.prototype.emit = function (name) {
  var list = this.listeners(name);
  if (list.length === 0) {
    return false;
  }
  var args = [];
  for (var i = 1; i < arguments.length; i++) {
    args.push(arguments[i]);
  }
  for (var j = 0; j < list.length; j++) {
    list[j](...args);
  }
  return true;
};

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
