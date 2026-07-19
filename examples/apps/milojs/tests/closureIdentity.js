function makeRouter(tag) {
  function router(x) { return 'via ' + router._id; }
  router._id = tag;
  return router;
}
var a = makeRouter('A'), b = makeRouter('B');
console.log(a(), b());
console.log(a._id, b._id, a === b, a === a);
// each call's nested fn is a distinct object with its own props
function counter(){ function c(){ return c.n; } c.n = 0; return c; }
var c1 = counter(), c2 = counter();
c1.n = 10; c2.n = 20;
console.log(c1(), c2(), c1 === c2);
