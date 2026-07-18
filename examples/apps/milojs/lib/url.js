// node:url — the legacy parse/format/resolve API. Enough for express (req.url)
// and for packages that only need the pathname/query split.
var querystring = require('querystring');

function parse(urlStr, parseQueryString) {
  var url = String(urlStr == null ? '' : urlStr);
  var out = {
    protocol: null, slashes: null, auth: null, host: null, port: null,
    hostname: null, hash: null, search: null, query: null, pathname: null,
    path: null, href: url
  };

  var rest = url;

  var hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) { out.hash = rest.slice(hashIdx); rest = rest.slice(0, hashIdx); }

  var protoMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?/.exec(rest);
  if (protoMatch) {
    out.protocol = protoMatch[1];
    if (protoMatch[2]) {
      out.slashes = true;
      rest = rest.slice(protoMatch[0].length);
    } else {
      rest = rest.slice(protoMatch[1].length);
    }

    if (out.slashes) {
      var slashIdx = rest.indexOf('/');
      var authority = slashIdx < 0 ? rest : rest.slice(0, slashIdx);
      rest = slashIdx < 0 ? '' : rest.slice(slashIdx);
      var atIdx = authority.indexOf('@');
      if (atIdx >= 0) {
        out.auth = authority.slice(0, atIdx);
        authority = authority.slice(atIdx + 1);
      }
      out.host = authority;
      var colonIdx = authority.lastIndexOf(':');
      if (colonIdx >= 0) {
        out.hostname = authority.slice(0, colonIdx);
        out.port = authority.slice(colonIdx + 1);
      } else {
        out.hostname = authority;
      }
    }
  }

  var qIdx = rest.indexOf('?');
  if (qIdx >= 0) { out.search = rest.slice(qIdx); rest = rest.slice(0, qIdx); }

  out.pathname = rest === '' ? (out.slashes ? '/' : null) : rest;
  if (out.search) {
    out.query = parseQueryString ? querystring.parse(out.search.slice(1)) : out.search.slice(1);
  } else if (parseQueryString) {
    out.query = {};
  }
  out.path = (out.pathname || '') + (out.search || '');
  return out;
}

function format(obj) {
  if (typeof obj === 'string') return obj;
  var s = '';
  if (obj.protocol) s += obj.protocol;
  if (obj.slashes || (obj.protocol && obj.host)) s += '//';
  if (obj.auth) s += obj.auth + '@';
  if (obj.host) {
    s += obj.host;
  } else if (obj.hostname) {
    s += obj.hostname;
    if (obj.port) s += ':' + obj.port;
  }
  if (obj.pathname) s += obj.pathname;
  if (obj.search) {
    s += obj.search;
  } else if (obj.query && typeof obj.query === 'object') {
    var q = querystring.stringify(obj.query);
    if (q) s += '?' + q;
  }
  if (obj.hash) s += obj.hash;
  return s;
}

function resolve(from, to) {
  if (!to) return from;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to)) return to;
  var base = parse(from);
  if (to.charAt(0) === '/') {
    return format({ protocol: base.protocol, slashes: base.slashes, host: base.host, pathname: to });
  }
  var dir = base.pathname || '/';
  var cut = dir.lastIndexOf('/');
  dir = cut >= 0 ? dir.slice(0, cut + 1) : '/';
  return format({ protocol: base.protocol, slashes: base.slashes, host: base.host, pathname: dir + to });
}

exports.parse = parse;
exports.format = format;
exports.resolve = resolve;
exports.Url = function Url() {};
