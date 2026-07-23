var o = { f: function(x){ return 'called '+x; } };
console.log(o.f?.(5));
console.log(({}).g?.() ?? 'no-g');
var cb = null; console.log(cb?.());
function run(fn){ return fn?.('hi'); }
console.log(run(function(x){ return 'ran '+x; }), run(undefined));
var obj = { m: { n: function(){ return 42; } } };
console.log(obj.m?.n?.(), obj.x?.n?.() ?? 'safe');
var api = { onError: function(e){ return 'handled:'+e; } };
console.log(api.onError?.('boom'));
var api2 = {};
console.log(api2.onError?.('boom') ?? 'no-handler');
