// getOwnPropertyDescriptors + defineProperty/defineProperties/Object.create
// honoring enumerable/configurable/writable for both data and accessor props
console.log(JSON.stringify(Object.getOwnPropertyDescriptors({a:1,b:2})));
const o = {};
Object.defineProperty(o,"g",{get(){return 5;},enumerable:false,configurable:true});
Object.defineProperty(o,"d",{value:9,enumerable:false});
Object.defineProperty(o,"e",{value:1,enumerable:true});
console.log(Object.keys(o), Object.getOwnPropertyDescriptor(o,"g").enumerable, Object.getOwnPropertyDescriptor(o,"d").writable);
const o2 = {};
Object.defineProperties(o2, { a:{value:1,enumerable:false}, b:{value:2,enumerable:true} });
console.log(Object.keys(o2), Object.getOwnPropertyDescriptor(o2,"a").writable);
const c = Object.create({}, { x:{value:5,enumerable:false}, y:{get(){return 9;},enumerable:true} });
console.log(Object.keys(c), c.x, c.y, Object.getOwnPropertyDescriptor(c,"x").configurable);
const clone = Object.create(Object.getPrototypeOf({}), Object.getOwnPropertyDescriptors({p:1,q:2}));
console.log(clone.p, clone.q, Object.keys(clone));
