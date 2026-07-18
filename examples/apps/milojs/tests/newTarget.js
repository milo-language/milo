function F() { console.log(typeof new.target, new.target === F); }
new F();
F();
class E extends Error { constructor(m) { super(m); const p = new.target.prototype; console.log("proto ok", typeof p); } }
new E("x");
