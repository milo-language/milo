// for-in and Object.keys over a Proxy go through the ownKeys and
// getOwnPropertyDescriptor traps (enumerable filtering included).
const p = new Proxy({}, {
  getOwnPropertyDescriptor() { return { configurable: true, enumerable: true, value: 42 }; },
  ownKeys() { return ["x", "y"]; },
});
const a = []; for (const k in p) a.push(k);
console.log(JSON.stringify(a), JSON.stringify(Object.keys(p)));
const q = new Proxy({ a: 1, b: 2 }, {});
const b = []; for (const k in q) b.push(k);
console.log(JSON.stringify(b), JSON.stringify(Object.keys(q)));
const r = new Proxy({ a: 1, b: 2 }, { ownKeys() { return ["a"]; } });
console.log(JSON.stringify(Object.keys(r)));
const t = new Proxy({ a: 1 }, {
  ownKeys() { return ["a", "hidden"]; },
  getOwnPropertyDescriptor(tg, k) {
    return k === "a" ? { configurable: true, enumerable: true, value: 1 }
                     : { configurable: true, enumerable: false, value: 2 };
  },
});
console.log(JSON.stringify(Object.keys(t)));
