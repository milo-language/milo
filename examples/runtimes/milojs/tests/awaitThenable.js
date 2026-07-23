// await must adopt any thenable, not just an internal promise
const thenable = { then(res) { res(42); } };
const rejecting = { then(_res, rej) { rej(new Error("nope")); } };
(async () => {
  console.log(await thenable);
  try { await rejecting; } catch (e) { console.log("caught:", e.message); }
  // a thenable that resolves with another thenable
  console.log(await { then(res) { res({ then: (r) => r("nested") }); } });
})();
