function f(a){ return this.x + a; }
var obj = { x: 5 };
console.log(f.bind(obj)(10));
console.log(f.bind(obj).bind(obj)(10));
var g = function(a,b){ return this.x + a + b; };
console.log(g.bind(obj,100).bind(obj,200)());
console.log(g.bind(obj,1).bind({x:99},2)());
function C(x){ this.x = x; }
C.prototype.m = async function(a){ return this.x + a; };
var c = new C(7);
var mm = c.m.bind(c).bind(c);
c.m2 = c.m.bind(c);
async function main(){
  console.log(await mm(3));
  console.log(await c.m2.bind(c)(4));
}
main();
