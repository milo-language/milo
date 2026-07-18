// node:querystring — enough of the API for express/body-parser.
function decode(s) {
  return decodeComponent(String(s).replace(/\+/g, ' '));
}

function decodeComponent(s) {
  var out = '';
  var i = 0;
  while (i < s.length) {
    var c = s[i];
    if (c === '%' && i + 2 < s.length + 1) {
      var hex = s.substr(i + 1, 2);
      var code = parseInt(hex, 16);
      if (!isNaN(code)) { out += String.fromCharCode(code); i += 3; continue; }
    }
    out += c;
    i += 1;
  }
  return out;
}

function encodeComponent(s) {
  var str = String(s);
  var safe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*\'()';
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str[i];
    if (safe.indexOf(c) >= 0) { out += c; }
    else {
      var code = str.charCodeAt(i);
      var hex = code.toString(16).toUpperCase();
      if (hex.length < 2) hex = '0' + hex;
      out += '%' + hex;
    }
  }
  return out;
}

exports.parse = function (str, sep, eq) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};
  if (!str) return obj;
  var parts = String(str).split(sep);
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var idx = parts[i].indexOf(eq);
    var k, v;
    if (idx < 0) { k = decode(parts[i]); v = ''; }
    else { k = decode(parts[i].slice(0, idx)); v = decode(parts[i].slice(idx + 1)); }
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      if (Array.isArray(obj[k])) obj[k].push(v); else obj[k] = [obj[k], v];
    } else { obj[k] = v; }
  }
  return obj;
};

exports.stringify = function (obj, sep, eq) {
  sep = sep || '&';
  eq = eq || '=';
  if (!obj || typeof obj !== 'object') return '';
  var pairs = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    if (Array.isArray(v)) {
      for (var j = 0; j < v.length; j++) pairs.push(encodeComponent(k) + eq + encodeComponent(v[j]));
    } else {
      pairs.push(encodeComponent(k) + eq + encodeComponent(v));
    }
  }
  return pairs.join(sep);
};

exports.escape = encodeComponent;
exports.unescape = decodeComponent;
exports.decode = exports.parse;
exports.encode = exports.stringify;
