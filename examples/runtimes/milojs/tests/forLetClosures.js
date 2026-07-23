var a=[]; for (let x of ['a','b','c']) a.push(()=>x);
console.log(a.map(f=>f()).join(","));
var b=[]; for (let k in {p:1,q:2,r:3}) b.push(()=>k);
console.log(b.map(f=>f()).join(","));
var c=[]; for (let i=0;i<3;i++) c.push(()=>i);
console.log(c.map(f=>f()).join(","));
var d=[]; for (var v=0;v<3;v++) d.push(()=>v);
console.log(d.map(f=>f()).join(","));
// the isbot-style getter idiom: per-iteration key capture
var getters = {}; var src = { one:function(){return 1;}, two:function(){return 2;} };
for (let key of Object.getOwnPropertyNames(src)) {
  Object.defineProperty(getters, key, { get: function(){ return src[key]; }, enumerable: true });
}
console.log(getters.one(), getters.two());
