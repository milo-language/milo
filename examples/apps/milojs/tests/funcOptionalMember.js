function proc(){} proc._def = { type: 'query', name: 'wf' };
var p = proc;
console.log(p?._def.type);
console.log(p?.["_def"].name);
console.log(p?.name);
console.log(p?.missing ?? 'none');
var arr = [proc]; console.log(arr[0]?._def.type);
var nul = null; console.log(nul?._def.type ?? 'safe');
console.log([1,2].find(x=>x>1)?.toString());
