// A blocked await must not sleep through a far-future timer. It is waiting on
// work that can land at any moment (a worker thread, a native addon), so it may
// only run timers that are ALREADY due — otherwise the await takes as long as
// the next scheduled timer, whatever it was for.
const farFuture = setTimeout(() => console.log("should not run first"), 30000);
const start = Date.now();
(async () => {
  const v = await new Promise((resolve) => setTimeout(() => resolve("soon"), 20));
  const waited = Date.now() - start;
  clearTimeout(farFuture);
  console.log(v, waited < 5000);
})();
