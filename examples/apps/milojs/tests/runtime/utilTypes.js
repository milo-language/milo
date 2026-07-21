// util.types predicates backed by instanceof (Date/Map/Set/RegExp/Promise/Error/
// ArrayBuffer) + the typed-array tag. isProxy/isAsyncFunction are undetectable
// here and report false (not tested against node).
const t = require("util").types;
console.log(t.isDate(new Date()), t.isDate(5), t.isDate({}));
console.log(t.isRegExp(/x/), t.isMap(new Map()), t.isSet(new Set()));
console.log(t.isPromise(Promise.resolve()), t.isNativeError(new Error()), t.isNativeError(new TypeError()));
console.log(t.isArrayBuffer(new ArrayBuffer(4)), t.isTypedArray(new Uint8Array(2)), t.isTypedArray([]));
console.log(t.isMap([]), t.isSet(new Map()), t.isRegExp("x"));
