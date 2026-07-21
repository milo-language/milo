// A rejected promise that is awaited (and caught) is NOT an unhandled rejection:
// the await delivers the rejection to the activation. Only truly unheld
// rejections report. Regression for a Promise.any-shaped false positive.
const main = async () => {
  try { await Promise.reject(new Error("caught here")); } catch (e) { console.log("ok1", e.message); }
  try { await Promise.any([Promise.reject(1), Promise.reject(2)]); } catch (e) { console.log("ok2", e.name, e.errors.length); }
  console.log("done");
};
main();
