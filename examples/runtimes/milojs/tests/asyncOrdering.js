console.log("1 sync start");
setTimeout(() => console.log("6 timeout 0"), 0);
Promise.resolve().then(() => console.log("4 microtask"));
queueMicrotask(() => console.log("5 queueMicrotask"));
console.log("2 sync end");
(async () => { console.log("3 async body runs sync"); })();
