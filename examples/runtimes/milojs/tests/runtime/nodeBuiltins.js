// node builtins: path.parse/format, URL userinfo, util.inspect (node-style)
const path = require("path");
console.log(JSON.stringify(path.parse("/a/b.txt")));
console.log(JSON.stringify(path.parse("relative/file.tar.gz")));
console.log(path.format({dir:"/a/b", base:"c.txt"}), path.format({root:"/", name:"x", ext:".js"}));
const u = new URL("https://user:pass@host.com:8080/p?q=1#f");
console.log(u.username, u.password, u.hostname, u.port, u.host);
const u2 = new URL("https://plain.com/x");
console.log(JSON.stringify(u2.username), JSON.stringify(u2.password));
const util = require("util");
console.log(util.inspect("hi"), util.inspect({a:1,b:"x"}));
console.log(util.inspect([1,"two",3]), util.inspect({nested:{a:[1,2]}}));
console.log(util.inspect(null), util.inspect(42n), util.inspect(true));
