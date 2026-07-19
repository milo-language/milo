// Minimal async_hooks: prisma's runtime constructs an AsyncLocalStorage for
// tracing spans. The engine has no async-context propagation, so the store is
// kept in a plain variable — correct for synchronous run() bodies and for the
// single-request-at-a-time paths prisma uses it on, and never worse than the
// undefined store getStore() is allowed to return.
class AsyncLocalStorage {
  constructor() {
    this._store = undefined;
  }
  run(store, callback, ...args) {
    const prev = this._store;
    this._store = store;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }
  enterWith(store) {
    this._store = store;
  }
  exit(callback, ...args) {
    const prev = this._store;
    this._store = undefined;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }
  getStore() {
    return this._store;
  }
  disable() {
    this._store = undefined;
  }
}

class AsyncResource {
  constructor(type) {
    this.type = type;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
  bind(fn) {
    return fn;
  }
}

function createHook() {
  return { enable() { return this; }, disable() { return this; } };
}

function executionAsyncId() { return 0; }
function triggerAsyncId() { return 0; }

module.exports = {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  triggerAsyncId,
};
