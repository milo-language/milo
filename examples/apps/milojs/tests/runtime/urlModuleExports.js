// require('url') re-exports the WHATWG URL and URLSearchParams (not just parse).
const { URL, URLSearchParams } = require("url");
const u = new URL("https://example.com/a/b?x=1&y=2");
console.log(u.host, u.pathname, u.searchParams.get("x"));
const sp = new URLSearchParams("a=1&b=2");
console.log(sp.get("a"), sp.get("b"));
console.log(typeof require("url").parse, typeof require("url").URL);
