// node-fetch — stubbed. The real module needs whatwg-url, which needs typed
// arrays (ArrayBuffer/Uint8Array), and an outbound HTTP client, which milojs
// does not have yet. A stub lets a bundle that imports fetch load and serve its
// other routes; calling fetch rejects rather than returning something wrong.
function fetch(url, options) {
  return Promise.reject(new Error(
    'fetch is not available under milojs: no outbound HTTP client yet (requested ' + url + ')'
  ));
}

function Headers(init) {
  this._h = {};
  if (init) {
    var keys = Object.keys(init);
    for (var i = 0; i < keys.length; i++) this._h[keys[i].toLowerCase()] = init[keys[i]];
  }
}
Headers.prototype.get = function (k) { return this._h[String(k).toLowerCase()]; };
Headers.prototype.set = function (k, v) { this._h[String(k).toLowerCase()] = v; return this; };
Headers.prototype.has = function (k) { return this._h[String(k).toLowerCase()] !== undefined; };

function Request(url, options) { this.url = url; this.options = options || {}; }
function Response(body, options) {
  this.body = body;
  this.status = (options && options.status) || 200;
  this.ok = this.status >= 200 && this.status < 300;
  this.headers = new Headers((options && options.headers) || {});
}
Response.prototype.json = function () { return Promise.resolve(JSON.parse(this.body)); };
Response.prototype.text = function () { return Promise.resolve(String(this.body)); };

fetch.Headers = Headers;
fetch.Request = Request;
fetch.Response = Response;
fetch.FetchError = Error;
fetch.default = fetch;

module.exports = fetch;
module.exports.Headers = Headers;
module.exports.Request = Request;
module.exports.Response = Response;
module.exports.default = fetch;
