// node:assert CommonJS subset
const assert = require("assert");
assert(true); assert.ok(1); assert.equal(1,"1"); assert.strictEqual(2,2);
assert.notEqual(1,2); assert.notStrictEqual(1,"1");
assert.deepEqual({a:1,b:[2,3]},{a:1,b:[2,3]});
assert.deepStrictEqual([1,{x:2}],[1,{x:2}]);
assert.notDeepEqual({a:1},{a:2});
let caught = [];
try { assert.equal(1,2); } catch(e){ caught.push(e.name); }
try { assert.strictEqual(1,"1"); } catch(e){ caught.push(e.code); }
try { assert.deepStrictEqual({a:1},{a:"1"}); } catch(e){ caught.push("deep"); }
try { assert.ok(false, "custom"); } catch(e){ caught.push(e.message); }
console.log(caught.join(","));
assert.throws(()=>{ throw new TypeError("boom"); }, TypeError);
assert.throws(()=>{ throw new Error("xyz"); }, /xy/);
assert.doesNotThrow(()=>{ let x=1; });
assert.ifError(null); assert.ifError(undefined);
console.log("all assertions ok");
console.log(typeof assert.strict, assert.strict === assert);
