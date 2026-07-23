async function main(){
  try { await Promise.reject(new Error("bad")); } catch (e) { console.log("caught", e.message); }
  var p = Promise.reject(new Error("late"));
  try { await p; } catch (e) { console.log("caught2", e.message); }
  console.log("done");
}
main();
