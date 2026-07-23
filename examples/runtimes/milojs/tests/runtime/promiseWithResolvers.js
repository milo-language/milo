const { promise, resolve } = Promise.withResolvers();
resolve(42);
promise.then((v) => console.log("resolved:", v));
const r = Promise.withResolvers();
r.reject(new Error("boom"));
r.promise.catch((e) => console.log("rejected:", e.message));
