// Symbol.toPrimitive drives coercion; Symbol.toStringTag (data prop) drives
// Object.prototype.toString; the well-known symbols are defined values.
const obj = { [Symbol.toPrimitive](hint){ return hint==="number"?42:"str"; } };
console.log(+obj, obj+"", obj*2, obj<50);
const money = { amount: 5, [Symbol.toPrimitive](h){ return h==="number"?this.amount:"$"+this.amount; } };
console.log(money+1, `${money}`, Number(money));
const tagged = { [Symbol.toStringTag]: "Widget" };
console.log(Object.prototype.toString.call(tagged));
const o2 = {}; o2[Symbol.toStringTag] = "Live";
console.log(Object.prototype.toString.call(o2));
console.log(Object.prototype.toString.call([]), Object.prototype.toString.call(new Map()));
console.log(typeof Symbol.toPrimitive, typeof Symbol.toStringTag, typeof Symbol.hasInstance, typeof Symbol.asyncIterator);
