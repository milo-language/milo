// Promise.any rejects with an AggregateError carrying every failure on .errors;
// AggregateError is a real Error subclass. It resolves on the first success.
const p = Promise.any([Promise.reject(1), Promise.reject(2), Promise.reject(3)]);
p.catch(e => console.log(e.constructor.name, e.name, e instanceof Error, e.errors.join(",")));
Promise.any([Promise.reject("a"), Promise.resolve("win"), Promise.reject("b")]).then(v => console.log(v));
const ae = new AggregateError([new Error("x"), new Error("y")], "msg");
console.log(ae.name, ae.message, ae.errors.length, ae instanceof Error);
