// JS NamedEvaluation: an anonymous function/arrow assigned to a binding or object
// property inherits that name. Frameworks introspect fn.name.
const bar = (x) => x;
let baz = function (a, b) {};
var qux = async () => {};
const named = function realName() {};
console.log(bar.name, baz.name, qux.name, named.name);
const obj = { handler: () => {}, fn: function () {}, m(a) {} };
console.log(obj.handler.name, obj.fn.name, obj.m.name);
function decl() {}
console.log(decl.name);
console.log((() => {}).name);
