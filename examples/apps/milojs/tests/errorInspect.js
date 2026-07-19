// console printing of Error objects (name: message) and Date (ISO), not the tag
console.log(new Error("boom"));
console.log(new TypeError("bad"));
class MyErr extends Error { constructor(m){ super(m); this.name = "MyErr"; } }
console.log(new MyErr("custom"));
console.log(new Date(0));
