// Promise combinators must adopt any thenable, not only promises this engine
// created: prisma's query builders are plain objects carrying a .then, and
// Promise.all used to resolve with the builders themselves.
const thenable = { then(res) { setTimeout(() => res("thenable-value"), 5); } };
const failing = { then(_res, rej) { setTimeout(() => rej(new Error("nope")), 5); } };

Promise.all([thenable, Promise.resolve("plain"), 7]).then((v) => console.log("all:", JSON.stringify(v)));
Promise.allSettled([thenable, failing]).then((v) =>
  console.log("settled:", JSON.stringify(v.map((x) => x.status))));
Promise.all([failing]).catch((e) => console.log("rejected via thenable:", e.message));
(async () => {
  console.log("await thenable:", await thenable);
})();
