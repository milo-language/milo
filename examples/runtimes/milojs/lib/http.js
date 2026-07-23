// node:http — a server built on the raw TCP natives (__tcpListen/__tcpAccept/
// __tcpRecv/__tcpSend/__tcpClose).
//
// One connection is handled at a time and accept() blocks, so the event loop
// only reaches it when nothing else is runnable. That means timers do not fire
// while waiting for a connection. It is enough to serve requests; it is not a
// concurrent server.
//
// Keep-alive is not implemented: every response closes the connection.

var EventEmitter = require('events').EventEmitter;

var STATUS_CODES = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable'
};

function parseRequest(raw) {
  var headerEnd = raw.indexOf('\r\n\r\n');
  var sep = 4;
  if (headerEnd < 0) { headerEnd = raw.indexOf('\n\n'); sep = 2; }
  if (headerEnd < 0) { headerEnd = raw.length; sep = 0; }
  var head = raw.slice(0, headerEnd);
  var body = sep > 0 ? raw.slice(headerEnd + sep) : '';
  var lines = head.split('\n');
  var first = (lines[0] || '').split('\r').join('');
  var parts = first.split(' ');
  var headers = {};
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].split('\r').join('');
    if (!line) continue;
    var colon = line.indexOf(':');
    if (colon < 0) continue;
    var name = line.slice(0, colon).trim().toLowerCase();
    headers[name] = line.slice(colon + 1).trim();
  }
  return {
    method: parts[0] || 'GET',
    url: parts[1] || '/',
    httpVersion: (parts[2] || 'HTTP/1.1').split('/')[1] || '1.1',
    headers: headers,
    body: body
  };
}

function IncomingMessage(parsed, connId) {
  EventEmitter.call(this);
  this.method = parsed.method;
  this.url = parsed.url;
  this.headers = parsed.headers;
  this.httpVersion = parsed.httpVersion;
  this.rawBody = parsed.body;
  this.socket = { remoteAddress: '127.0.0.1', encrypted: false, destroy: function () {} };
  this.connection = this.socket;
  this.complete = true;
  this._connId = connId;
}
IncomingMessage.prototype = Object.create(EventEmitter.prototype);
IncomingMessage.prototype.constructor = IncomingMessage;

// body-parser attaches 'data'/'end' listeners; the whole body is already read,
// so hand it over on the next tick and finish.
IncomingMessage.prototype.on = function (event, handler) {
  EventEmitter.prototype.on.call(this, event, handler);
  var self = this;
  if (event === 'end' || event === 'data') {
    if (!self._scheduled) {
      self._scheduled = true;
      setTimeout(function () {
        if (self.rawBody && self.rawBody.length > 0) self.emit('data', self.rawBody);
        self.emit('end');
      }, 0);
    }
  }
  return this;
};
IncomingMessage.prototype.setEncoding = function () { return this; };
IncomingMessage.prototype.pause = function () { return this; };
IncomingMessage.prototype.resume = function () { return this; };
IncomingMessage.prototype.destroy = function () { return this; };

function ServerResponse(connId) {
  EventEmitter.call(this);
  this._connId = connId;
  this._headers = {};
  this._sent = false;
  this.statusCode = 200;
  this.statusMessage = null;
  this.headersSent = false;
  this.finished = false;
  // trpc's node-http adapter streams the body with `while(...){ if(!res.writable)
  // break; res.write(chunk) }` — without this flag res.writable is undefined, the
  // loop breaks before the first write, and every response goes out with an empty
  // body (200 but 0 bytes → every client widget stuck on its loading skeleton).
  this.writable = true;
  this.socket = { destroy: function () {} };
}
ServerResponse.prototype = Object.create(EventEmitter.prototype);
ServerResponse.prototype.constructor = ServerResponse;

ServerResponse.prototype.setHeader = function (name, value) {
  this._headers[String(name).toLowerCase()] = value;
  return this;
};
ServerResponse.prototype.getHeader = function (name) {
  return this._headers[String(name).toLowerCase()];
};
ServerResponse.prototype.removeHeader = function (name) {
  delete this._headers[String(name).toLowerCase()];
  return this;
};
ServerResponse.prototype.getHeaders = function () { return this._headers; };
ServerResponse.prototype.hasHeader = function (name) {
  return this._headers[String(name).toLowerCase()] !== undefined;
};
ServerResponse.prototype.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
  this.statusCode = status;
  var headers = maybeHeaders;
  if (reasonOrHeaders && typeof reasonOrHeaders === 'object') headers = reasonOrHeaders;
  else if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
  if (headers) {
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) this.setHeader(keys[i], headers[keys[i]]);
  }
  return this;
};
// Node internal that compression and other middleware call to force the status
// line + headers out before streaming a body. There is no header/body split
// here (end() writes the whole response at once), so it only needs to exist.
ServerResponse.prototype._implicitHeader = function () {
  this.headersSent = true;
};
ServerResponse.prototype.flushHeaders = function () { this.headersSent = true; };
ServerResponse.prototype.writeContinue = function () {};
function chunkToString(chunk) {
  if (chunk == null) return '';
  // express passes a Buffer to res.end; String(buffer) would give [object Object]
  if (chunk.bytes && typeof chunk.toString === 'function') return chunk.toString();
  return String(chunk);
}
ServerResponse.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; }
  this._pending = (this._pending || '') + chunkToString(chunk);
  if (typeof cb === 'function') cb();
  return true;
};
ServerResponse.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
  if (this._sent) { if (cb) cb(); return this; }
  var body = (this._pending || '') + chunkToString(chunk);
  if (this.getHeader('content-length') === undefined) {
    // byte count, not code-point count — see fs.makeStats. A short Content-Length
    // makes the client stop reading mid-body, which is what turned served fonts
    // into "incorrect file size in WOFF header".
    this.setHeader('Content-Length', __byteLength(body));
  }
  var reason = this.statusMessage || STATUS_CODES[this.statusCode] || 'OK';
  var out = 'HTTP/1.1 ' + this.statusCode + ' ' + reason + '\r\n';
  var names = Object.keys(this._headers);
  for (var i = 0; i < names.length; i++) {
    var v = this._headers[names[i]];
    if (Array.isArray(v)) {
      for (var j = 0; j < v.length; j++) out += names[i] + ': ' + v[j] + '\r\n';
    } else {
      out += names[i] + ': ' + v + '\r\n';
    }
  }
  out += 'Connection: close\r\n\r\n' + body;
  __tcpSend(this._connId, out);
  __tcpClose(this._connId);
  this._sent = true;
  this.headersSent = true;
  this.finished = true;
  this.writable = false;
  this.emit('finish');
  this.emit('close');
  if (cb) cb();
  return this;
};

function Server(handler) {
  EventEmitter.call(this);
  this._handler = handler;
  this._listenerId = -1;
  this.listening = false;
}
Server.prototype = Object.create(EventEmitter.prototype);
Server.prototype.constructor = Server;

Server.prototype.listen = function (port, hostOrCb, maybeCb) {
  var cb = typeof hostOrCb === 'function' ? hostOrCb : maybeCb;
  var p = typeof port === 'object' && port !== null ? port.port : port;
  this._listenerId = __tcpListen(Number(p) || 0);
  if (this._listenerId < 0) {
    var err = new Error('EADDRINUSE: failed to bind port ' + p);
    err.code = 'EADDRINUSE';
    // node exits on an unhandled 'error' event. Swallowing it left the process
    // running, never firing the listen callback, while an OLDER process on the
    // port answered requests — the failure looked like a hang in unrelated code.
    if (this.listenerCount && this.listenerCount('error') > 0) {
      this.emit('error', err);
      return this;
    }
    throw err;
  }
  this.listening = true;
  // registered natively so the event loop can find and service it
  __httpRegister(this);
  if (cb) setTimeout(cb, 0);
  this.emit('listening');
  return this;
};

Server.prototype.address = function () {
  return { address: '0.0.0.0', family: 'IPv4', port: this._port || 0 };
};

Server.prototype.close = function (cb) {
  this.listening = false;
  __httpUnregister(this);
  if (cb) setTimeout(cb, 0);
  this.emit('close');
  return this;
};

// Accept one connection and run the handler. Called by the event loop, which
// passes mayBlock=true only when it is idle enough to park on the listener —
// a blocking accept stalls timers/microtasks/fetch servicing until the next
// connection, so it must never happen while other work is pending.
Server.prototype._serveOnce = function (mayBlock) {
  var connId = __tcpAccept(this._listenerId, mayBlock);
  if (connId < 0) return false;
  var raw = __tcpRecv(connId);
  if (!raw || raw.length === 0) { __tcpClose(connId); return true; }
  var parsed = parseRequest(raw);
  var req = new IncomingMessage(parsed, connId);
  var res = new ServerResponse(connId);
  this.emit('request', req, res);
  if (this._handler) this._handler(req, res);
  return true;
};

function createServer(optionsOrHandler, maybeHandler) {
  var handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
  return new Server(handler);
}

exports.createServer = createServer;
exports.Server = Server;
exports.IncomingMessage = IncomingMessage;
exports.ServerResponse = ServerResponse;
exports.STATUS_CODES = STATUS_CODES;
exports.METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
exports.globalAgent = {};
exports.Agent = function Agent() {};

// Client side is not implemented: node-fetch and friends need it, but it wants
// its own connect/read path and is a separate piece of work.
exports.request = function () {
  throw new Error('http.request is not implemented under milojs');
};
exports.get = function () {
  throw new Error('http.get is not implemented under milojs');
};
