// A callable stored as a property must be callable via obj.method(), not only
// via a saved reference + .call — zod stores its schema methods this way, and
// the whole tRPC app failed to build without it.
const o = {};
Object.defineProperty(o, 'm', { get: function () { return (function () { return "got"; }).bind(null); } });
console.log(typeof o.m, o.m());
const holder = { fn: [].slice };
console.log(typeof holder.fn, JSON.stringify(holder.fn.call([1, 2, 3], 1)));
