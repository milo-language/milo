// fn.length (arity before defaults/rest) and fn.name — express uses length===4
// to detect error-handler middleware, so wrong arity misroutes every request.
console.log((function (a, b) {}).length, ((a, b, c) => {}).length, (function () {}).length);
console.log((function (err, req, res, next) {}).length);
function named(x, y) {}
console.log(named.name, named.length);
function withRest(a, b, ...r) {}
console.log(withRest.length);
