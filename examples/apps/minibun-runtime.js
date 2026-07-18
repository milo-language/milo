(function(){
  var cache = {};
  function dirname(p){ var i = p.lastIndexOf('/'); if(i<0) return '.'; if(i===0) return '/'; return p.slice(0,i); }
  function normalize(p){ var abs = p.charAt(0)==='/'; var parts = p.split('/'); var out=[]; for(var k=0;k<parts.length;k++){ var s=parts[k]; if(s===''||s==='.') continue; if(s==='..'){ out.pop(); continue; } out.push(s); } return (abs?'/':'')+out.join('/'); }
  function join(a,b){ return normalize(a+'/'+b); }
  // Pick a target from a package.json exports/imports "conditions" value. Prefer CommonJS
  // (require/node/default) over import(ESM), since our loader runs scripts, not ES modules —
  // dual packages then load their .cjs build and skip the transform entirely.
  function pickCond(v){
    if(v==null) return null;
    if(typeof v==='string') return v;
    if(Array.isArray(v)){ for(var i=0;i<v.length;i++){ var r=pickCond(v[i]); if(r) return r; } return null; }
    var order=['require','node','default','browser','import'];
    for(var i=0;i<order.length;i++){ if(v[order[i]]!==undefined){ var r=pickCond(v[order[i]]); if(r) return r; } }
    return null;
  }
  function tryFileExact(f){
    if(__fileExists(f)) return f;
    if(__fileExists(f+'.js')) return f+'.js';
    if(__fileExists(f+'.cjs')) return f+'.cjs';
    if(__fileExists(f+'.json')) return f+'.json';
    if(__fileExists(f+'/index.js')) return f+'/index.js';
    if(__fileExists(f+'/index.cjs')) return f+'/index.cjs';
    return null;
  }
  function pkgEntry(pkgDir){
    var pj=pkgDir+'/package.json';
    if(!__fileExists(pj)) return null;
    var j; try{ j=JSON.parse(__readFileSync(pj)); }catch(e){ return null; }
    if(j.exports!==undefined){
      var ex=j.exports, dotv;
      if(typeof ex==='string') dotv=ex;
      else if(ex['.']!==undefined) dotv=ex['.'];
      else if(ex.require!==undefined||ex.import!==undefined||ex.default!==undefined||ex.node!==undefined) dotv=ex;
      if(dotv!==undefined){ var f=pickCond(dotv); if(f) return join(pkgDir, f); }
    }
    if(j.main) return join(pkgDir, j.main);
    return null;
  }
  function tryFile(base){
    if(__fileExists(base)) return base;
    if(__fileExists(base+'.js')) return base+'.js';
    if(__fileExists(base+'.cjs')) return base+'.cjs';
    if(__fileExists(base+'.json')) return base+'.json';
    if(__fileExists(base+'/package.json')){ var e=pkgEntry(base); if(e){ var r=tryFileExact(e); if(r) return r; } }
    if(__fileExists(base+'/index.js')) return base+'/index.js';
    if(__fileExists(base+'/index.cjs')) return base+'/index.cjs';
    return null;
  }
  // Resolve a package.json "imports" (#-prefixed) specifier by walking up to the owning package.
  function resolveImports(fromDir, req){
    var dir=fromDir;
    while(true){
      var pj=join(dir,'package.json');
      if(__fileExists(pj)){ try{ var j=JSON.parse(__readFileSync(pj)); if(j.imports&&j.imports[req]!==undefined){ var f=pickCond(j.imports[req]); if(f){ var rr=tryFileExact(join(dir,f)); if(rr) return rr; } } if(j.name){ break; } }catch(e){} }
      var par=dirname(dir); if(par===dir) break; dir=par;
    }
    return null;
  }
  function resolve(fromDir, req){
    var base;
    if(req.charAt(0)==='#'){ var im=resolveImports(fromDir, req); if(im) return im; throw new Error('Cannot find module ' + req); }
    if(req.charAt(0)==='/'){ base=normalize(req); }
    else if(req.slice(0,2)==='./' || req.slice(0,3)==='../' || req==='.' || req==='..'){ base=join(fromDir,req); }
    else { var dir=fromDir; while(true){ var c=tryFile(join(dir,'node_modules/'+req)); if(c) return c; var par=dirname(dir); if(par===dir) break; dir=par; } throw new Error('Cannot find module ' + req); }
    var f=tryFile(base); if(f) return f;
    throw new Error('Cannot find module ' + req);
  }
  // ESM detection + a lightweight import/export -> CommonJS transform. JSC (via new Function)
  // only runs scripts, not ES modules, so packages shipping `import`/`export` won't load as-is.
  // Regex-level rewrite covers the common static forms (~most of the ecosystem); dynamic
  // import() and exotic syntax are out of scope.
  function __looksESM(fn, src){
    if(fn.slice(-4)==='.mjs') return true;
    if(fn.slice(-4)==='.cjs') return false;
    return /(^|[\n;])\s*(import\s+[\w{*'"]|import\s*\{|export\s+(default|const|let|var|function|async|class|\{|\*))/.test(src);
  }
  function __esmToCjs(src){
    var uid=0, post='';
    var out=src;
    // import 'mod';  (side-effect only)
    out=out.replace(/(^|[\n;])\s*import\s*['"]([^'"]+)['"]\s*;?/g, '$1 require("$2");');
    // import [default][, { named }] from 'mod'  (and * as ns)
    out=out.replace(/(^|[\n;])\s*import\s+([^;'"]+?)\s+from\s*['"]([^'"]+)['"]\s*;?/g, function(m,p,clause,mod){
      clause=clause.trim();
      var ns=clause.match(/^\*\s+as\s+([A-Za-z0-9_$]+)$/);
      if(ns) return p+' var '+ns[1]+'=require("'+mod+'");';
      var v='__imp'+(uid++);
      var s=p+' var '+v+'=require("'+mod+'");';
      var brace=clause.match(/\{([^}]*)\}/);
      var def=brace ? clause.slice(0,clause.indexOf('{')).replace(/,\s*$/,'').trim() : clause;
      if(def) s+=' var '+def+'=('+v+'&&'+v+'.__esModule)?'+v+'.default:'+v+';';
      if(brace) brace[1].split(',').forEach(function(n){ n=n.trim(); if(!n)return; var pp=n.split(/\s+as\s+/); s+=' var '+(pp[1]||pp[0]).trim()+'='+v+'.'+pp[0].trim()+';'; });
      return s;
    });
    // export * from 'mod'
    out=out.replace(/(^|[\n;])\s*export\s*\*\s*from\s*['"]([^'"]+)['"]\s*;?/g, '$1 Object.assign(module.exports, require("$2"));');
    // export { a, b as c } from 'mod'
    out=out.replace(/(^|[\n;])\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g, function(m,p,body,mod){
      var v='__rex'+(uid++); var s=p+' var '+v+'=require("'+mod+'");';
      body.split(',').forEach(function(n){ n=n.trim(); if(!n)return; var pp=n.split(/\s+as\s+/); s+=' module.exports.'+(pp[1]||pp[0]).trim()+'='+v+'.'+pp[0].trim()+';'; });
      return s;
    });
    // export { a, b as c }  (live bindings via getters)
    out=out.replace(/(^|[\n;])\s*export\s*\{([^}]*)\}\s*;?/g, function(m,p,body){
      var s=p;
      body.split(',').forEach(function(n){ n=n.trim(); if(!n)return; var pp=n.split(/\s+as\s+/); var to=(pp[1]||pp[0]).trim(), from=pp[0].trim(); s+=' Object.defineProperty(module.exports,"'+to+'",{enumerable:true,configurable:true,get:function(){return '+from+';}});'; });
      return s;
    });
    // export default <expr>
    out=out.replace(/(^|[\n;])\s*export\s+default\s+/g, '$1 module.exports.__esModule=true; module.exports.default=');
    // export const/let/var/function/class NAME  -> declare, then export as a live getter
    out=out.replace(/(^|[\n;])(\s*)export\s+(async\s+function|function\*?|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g, function(m,p,ws,kw,name){
      post+=' Object.defineProperty(module.exports,"'+name+'",{enumerable:true,configurable:true,get:function(){return '+name+';}});';
      return p+ws+kw+' '+name;
    });
    return out+'\n;module.exports.__esModule=true;'+post;
  }
  function loadModule(filename){
    if(cache[filename]) return cache[filename].exports;
    var module={exports:{},filename:filename,loaded:false};
    cache[filename]=module;
    var src=__readFileSync(filename);
    if(src===undefined) throw new Error('Cannot read module ' + filename);
    if(filename.slice(-5)==='.json'){ module.exports=JSON.parse(src); module.loaded=true; return module.exports; }
    var dir=dirname(filename);
    var req=function(r){ var nr = r.slice(0,5)==='node:' ? r.slice(5) : r; if(builtins.hasOwnProperty(nr)) return builtins[nr]; return loadModule(resolve(dir,r)); };
    req.resolve=function(r){ return resolve(dir,r); }; req.cache=cache; req.main=undefined; module.require=req;
    if(__looksESM(filename, src)) src=__esmToCjs(src);
    var fn=new Function('exports','require','module','__filename','__dirname', src + '\n//# sourceURL=' + filename);
    fn.call(module.exports, module.exports, req, module, filename, dir);
    module.loaded=true;
    return module.exports;
  }
  function EventEmitter(){ this._ev={}; }
  EventEmitter.prototype.on=function(t,f){ if(!this._ev)this._ev={}; (this._ev[t]||(this._ev[t]=[])).push(f); return this; };
  EventEmitter.prototype.addListener=EventEmitter.prototype.on;
  EventEmitter.prototype.prependListener=function(t,f){ if(!this._ev)this._ev={}; (this._ev[t]||(this._ev[t]=[])).unshift(f); return this; };
  EventEmitter.prototype.once=function(t,f){ var s=this; function g(){ s.removeListener(t,g); return f.apply(this,arguments); } g.listener=f; return s.on(t,g); };
  EventEmitter.prototype.removeListener=function(t,f){ if(!this._ev)return this; var a=this._ev[t]; if(a){ var i=a.indexOf(f); if(i>=0) a.splice(i,1); } return this; };
  EventEmitter.prototype.off=EventEmitter.prototype.removeListener;
  EventEmitter.prototype.removeAllListeners=function(t){ if(!this._ev)this._ev={}; if(t) delete this._ev[t]; else this._ev={}; return this; };
  EventEmitter.prototype.emit=function(t){ if(!this._ev)this._ev={}; var a=this._ev[t]; var args=Array.prototype.slice.call(arguments,1); if(!a||!a.length){ if(t==='error') throw (args[0]||new Error('Unhandled error event')); return false; } var cp=a.slice(); for(var i=0;i<cp.length;i++) cp[i].apply(this,args); return true; };
  EventEmitter.prototype.listeners=function(t){ return ((this._ev&&this._ev[t])||[]).slice(); };
  EventEmitter.prototype.listenerCount=function(t){ return ((this._ev&&this._ev[t])||[]).length; };
  EventEmitter.prototype.setMaxListeners=function(){ return this; };
  EventEmitter.prototype.getMaxListeners=function(){ return 10; };
  EventEmitter.EventEmitter=EventEmitter; EventEmitter.defaultMaxListeners=10;
  var pathMod={ sep:'/', delimiter:':', dirname:dirname, normalize:normalize, join:function(){ return normalize(Array.prototype.slice.call(arguments).join('/')); }, basename:function(p,ext){ var b=p.slice(p.lastIndexOf('/')+1); if(ext&&b.length>=ext.length&&b.slice(-ext.length)===ext) b=b.slice(0,b.length-ext.length); return b; }, extname:function(p){ var b=p.slice(p.lastIndexOf('/')+1); var i=b.lastIndexOf('.'); return i>0?b.slice(i):''; }, isAbsolute:function(p){ return p.charAt(0)==='/'; }, resolve:function(){ var r=''; for(var i=0;i<arguments.length;i++){ var a=arguments[i]; if(!a) continue; r=(a.charAt(0)==='/')?a:(r?r+'/'+a:a); } if(r.charAt(0)!=='/') r='/'+r; return normalize(r); }, parse:function(p){ var d=dirname(p); var b=p.slice(p.lastIndexOf('/')+1); var i=b.lastIndexOf('.'); return { root:'/', dir:d, base:b, ext:i>0?b.slice(i):'', name:i>0?b.slice(0,i):b }; }, relative:function(from,to){ from=normalize(from||''); to=normalize(to||''); var fp=from.split('/').filter(Boolean); var tp=to.split('/').filter(Boolean); var i=0; while(i<fp.length&&i<tp.length&&fp[i]===tp[i]) i++; var up=[]; for(var j=i;j<fp.length;j++) up.push('..'); return up.concat(tp.slice(i)).join('/'); }, toNamespacedPath:function(p){ return p; }, format:function(o){ o=o||{}; var dir=o.dir||o.root||''; var base=o.base||((o.name||'')+(o.ext||'')); return dir?(dir+'/'+base):base; } };
  pathMod.posix=pathMod; pathMod.win32=pathMod;
  function inherits(c,s){ var proto=(s&&(typeof s==='function'||typeof s==='object')&&s.prototype)?s.prototype:Object.prototype; if(!s||!s.prototype) console.log('[minibun] inherits: super has no prototype (typeof '+typeof s+'), using Object.prototype'); c.super_=s; c.prototype=Object.create(proto); c.prototype.constructor=c; }
  var utilMod={ inherits:inherits, debuglog:function(){ return function(){}; }, debug:function(){ return function(){}; }, inspect:function(o){ try{ return typeof o==='string'?o:JSON.stringify(o); }catch(e){ return String(o); } }, format:function(){ var a=Array.prototype.slice.call(arguments); if(typeof a[0]!=='string') return a.map(function(x){ return typeof x==='string'?x:JSON.stringify(x); }).join(' '); var f=a.shift(); var i=0; var s=f.replace(/%[sdj%]/g,function(m){ if(m==='%%')return '%'; if(i>=a.length)return m; var x=a[i++]; if(m==='%d')return Number(x); if(m==='%j')return JSON.stringify(x); return String(x); }); for(;i<a.length;i++) s+=' '+(typeof a[i]==='string'?a[i]:JSON.stringify(a[i])); return s; }, isArray:Array.isArray, isBuffer:function(){ return false; }, promisify:function(fn){ return function(){ var args=Array.prototype.slice.call(arguments); var self=this; return new Promise(function(res,rej){ args.push(function(err,v){ if(err) rej(err); else res(v); }); fn.apply(self,args); }); }; }, deprecate:function(fn){ return fn; }, types:{ isDate:function(x){ return x instanceof Date; } } };
  function assertFn(v,m){ if(!v) throw new Error(m||'AssertionError'); }
  assertFn.ok=assertFn; assertFn.equal=function(a,b,m){ if(a!=b) throw new Error(m||(a+' != '+b)); }; assertFn.notEqual=function(a,b,m){ if(a==b) throw new Error(m||'notEqual'); }; assertFn.strictEqual=function(a,b,m){ if(a!==b) throw new Error(m||(a+' !== '+b)); }; assertFn.deepEqual=function(){}; assertFn.deepStrictEqual=function(){}; assertFn.fail=function(m){ throw new Error(m||'fail'); };
  function __parseCallSites(){ var raw=new Error().stack||''; var lines=raw.split('\n'); var out=[]; for(var i=0;i<lines.length;i++){ var ln=lines[i]; var at=ln.lastIndexOf('@'); var loc=at>=0?ln.slice(at+1):ln; var fn=at>=0?ln.slice(0,at):''; var m=loc.match(/^(.*):(\d+):(\d+)$/); var file=m?m[1]:loc; var no=m?Number(m[2]):0; var col=m?Number(m[3]):0; (function(file,no,col,fn){ out.push({ getFileName:function(){ return file||null; }, getLineNumber:function(){ return no; }, getColumnNumber:function(){ return col; }, getFunctionName:function(){ return fn||null; }, getMethodName:function(){ return null; }, getTypeName:function(){ return null; }, getThis:function(){ return undefined; }, isNative:function(){ return false; }, isEval:function(){ return false; }, isConstructor:function(){ return false; }, isToplevel:function(){ return true; }, toString:function(){ return (fn?fn+' ':'')+'('+file+':'+no+':'+col+')'; } }); })(file,no,col,fn); } return out.slice(1); }
  function __depd(ns){ function deprecate(msg){} deprecate.function=function(fn){ return fn; }; deprecate.property=function(){}; deprecate._namespace=ns; return deprecate; }
  function __statOf(p){ var isd=__isDir(p); var isf=__fileExists(p); if(!isd&&!isf) return null; var sz=isd?0:__fileSize(p); if(sz<0) sz=0; var mt=new Date(0); return { isFile:function(){ return isf&&!isd; }, isDirectory:function(){ return isd; }, isSymbolicLink:function(){ return false; }, isBlockDevice:function(){ return false; }, isCharacterDevice:function(){ return false; }, isFIFO:function(){ return false; }, isSocket:function(){ return false; }, size:sz, mtime:mt, mtimeMs:0, ctime:mt, ctimeMs:0, atime:mt, atimeMs:0, birthtime:mt, birthtimeMs:0, ino:1, dev:1, nlink:1, uid:0, gid:0, rdev:0, blksize:4096, blocks:0, mode:isd?16877:33188 }; }
  function __mkReadStream(p,opts){ opts=opts||{}; var s=new Readable(); s.path=p; s.bytesRead=0; s.pending=true; s.destroyed=false; var start=opts.start||0; var end=(opts.end!=null&&opts.end!==Infinity)?(opts.end+1):undefined; var started=false; s.destroy=function(e){ this.destroyed=true; if(e){ var self=this; Promise.resolve().then(function(){ self.emit('error',e); }); } return this; }; s.close=function(){ return this; }; s.setEncoding=function(){ return this; }; function run(dest){ Promise.resolve().then(function(){ if(s.destroyed) return; var c=__readFileSync(p); if(c===undefined){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; s.emit('error',e); return; } var body=(start||end!=null)?c.slice(start,end):c; s.bytesRead=body.length; s.pending=false; if(dest){ dest.write(body); } else { s.emit('data',body); } s.emit('end'); s.emit('close'); if(dest&&dest.end) dest.end(); }); } s.pipe=function(dest){ if(!started){ started=true; run(dest); } return dest; }; var _on=Readable.prototype.on; s.on=function(ev,cb){ _on.call(this,ev,cb); if(ev==='data'&&!started){ started=true; run(null); } return this; }; s.addListener=s.on; s.resume=function(){ if(!started){ started=true; run(null); } return this; }; return s; }
  var fsMod={ readFileSync:function(p,enc){ var s=__readFileSync(p); if(s===undefined){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; throw e; } return s; }, existsSync:function(p){ return __fileExists(p)||__isDir(p); }, readdirSync:function(){ return []; }, statSync:function(p){ var st=__statOf(p); if(!st){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; throw e; } return st; }, lstatSync:function(p){ return fsMod.statSync(p); }, writeFileSync:function(){}, appendFileSync:function(){}, mkdirSync:function(){}, realpathSync:function(p){ return p; }, createReadStream:function(p,o){ return __mkReadStream(p,o); }, createWriteStream:function(){ var w=new Writable(); w.write=function(){ return true; }; w.end=function(cb){ if(typeof cb==='function') cb(); this.emit('finish'); this.emit('close'); return this; }; return w; }, readFile:function(p,enc,cb){ if(typeof enc==='function') cb=enc; var s=__readFileSync(p); Promise.resolve().then(function(){ if(s===undefined){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; cb(e); } else cb(null,s); }); }, stat:function(p,cb){ if(typeof cb!=='function') return; var st=__statOf(p); Promise.resolve().then(function(){ if(!st){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; cb(e); } else cb(null, st); }); }, lstat:function(p,cb){ return fsMod.stat(p,cb); }, access:function(p,m,cb){ if(typeof m==='function') cb=m; var ok=__fileExists(p)||__isDir(p); Promise.resolve().then(function(){ if(ok) cb(null); else { var e=new Error('ENOENT: '+p); e.code='ENOENT'; cb(e); } }); }, constants:{ F_OK:0, R_OK:4, W_OK:2, X_OK:1 }, promises:{ readFile:function(p,enc){ var s=__readFileSync(p); if(s===undefined){ var e=new Error('ENOENT: '+p); e.code='ENOENT'; return Promise.reject(e); } return Promise.resolve(s); }, stat:function(p){ var st=__statOf(p); return st?Promise.resolve(st):Promise.reject(new Error('ENOENT: '+p)); }, access:function(p){ return (__fileExists(p)||__isDir(p))?Promise.resolve():Promise.reject(new Error('ENOENT: '+p)); }, writeFile:function(){ return Promise.resolve(); }, mkdir:function(){ return Promise.resolve(); } } };
  var osMod={ platform:function(){ return 'darwin'; }, arch:function(){ return 'arm64'; }, type:function(){ return 'Darwin'; }, release:function(){ return '0'; }, hostname:function(){ return 'minibun'; }, cpus:function(){ return [{}]; }, totalmem:function(){ return 0; }, freemem:function(){ return 0; }, homedir:function(){ return '/'; }, tmpdir:function(){ return '/tmp'; }, EOL:'\n', endianness:function(){ return 'LE'; }, networkInterfaces:function(){ return {}; } };
  var ttyMod={ isatty:function(){ return false; }, ReadStream:function(){}, WriteStream:function(){} };
  function __qsParse(s){ var o={}; if(!s) return o; s=String(s); if(s.charAt(0)==='?') s=s.slice(1); var ps=s.split('&'); for(var i=0;i<ps.length;i++){ if(!ps[i]) continue; var kv=ps[i].split('='); var k=decodeURIComponent(kv[0]); var v=kv.length>1?decodeURIComponent(kv[1]):''; if(o[k]===undefined) o[k]=v; else if(Array.isArray(o[k])) o[k].push(v); else o[k]=[o[k],v]; } return o; }
  function __qsStringify(o){ if(!o) return ''; var out=[]; for(var k in o){ if(!o.hasOwnProperty(k)) continue; var v=o[k]; if(Array.isArray(v)){ for(var i=0;i<v.length;i++) out.push(encodeURIComponent(k)+'='+encodeURIComponent(v[i])); } else out.push(encodeURIComponent(k)+'='+encodeURIComponent(v)); } return out.join('&'); }
  var qsMod={ parse:__qsParse, stringify:__qsStringify, escape:encodeURIComponent, unescape:decodeURIComponent };
  // WHATWG Headers. JSC core's native Headers (when present) is NOT for-of iterable, and
  // server code does `for (const [k,v] of response.headers)` — so we install our own, which
  // implements entries()/[Symbol.iterator]. Overrides native intentionally.
  (function () {
    function Headers(init) {
      this._l = []; // [lowerName, value]
      if (init == null) return;
      if (init instanceof Headers) { init._l.forEach(function (e) { this._l.push([e[0], e[1]]); }, this); }
      else if (typeof init.forEach === 'function' && !Array.isArray(init)) { init.forEach(function (v, k) { this.append(k, v); }, this); }
      else if (Array.isArray(init)) { init.forEach(function (p) { this.append(p[0], p[1]); }, this); }
      else { for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) this.append(k, init[k]); }
    }
    var H = Headers.prototype;
    H.append = function (k, v) { this._l.push([String(k).toLowerCase(), String(v)]); };
    H.set = function (k, v) { k = String(k).toLowerCase(); v = String(v); var done = false; this._l = this._l.filter(function (e) { if (e[0] === k) { if (!done) { e[1] = v; done = true; return true; } return false; } return true; }); if (!done) this._l.push([k, v]); };
    H.get = function (k) { k = String(k).toLowerCase(); var vs = this._l.filter(function (e) { return e[0] === k; }).map(function (e) { return e[1]; }); return vs.length ? vs.join(', ') : null; };
    H.getSetCookie = function () { return this._l.filter(function (e) { return e[0] === 'set-cookie'; }).map(function (e) { return e[1]; }); };
    H.has = function (k) { k = String(k).toLowerCase(); return this._l.some(function (e) { return e[0] === k; }); };
    H['delete'] = function (k) { k = String(k).toLowerCase(); this._l = this._l.filter(function (e) { return e[0] !== k; }); };
    H.forEach = function (cb, thisArg) { this.entries().forEach(function (e) { cb.call(thisArg, e[1], e[0], this); }, this); };
    // WHATWG sorts + combines same-name values; good enough: unique sorted names, values joined.
    H.entries = function () { var names = []; var seen = {}; this._l.forEach(function (e) { if (!seen[e[0]]) { seen[e[0]] = true; names.push(e[0]); } }); names.sort(); var self = this; return names.map(function (n) { return [n, self.get(n)]; }); };
    H.keys = function () { return this.entries().map(function (e) { return e[0]; }); };
    H.values = function () { return this.entries().map(function (e) { return e[1]; }); };
    function arrIter(arr) { var i = 0; var it = { next: function () { return i < arr.length ? { value: arr[i++], done: false } : { value: undefined, done: true }; } }; it[Symbol.iterator] = function () { return this; }; return it; }
    H[Symbol.iterator] = function () { return arrIter(this.entries()); };
    // entries/keys/values should be iterable too when consumed by for-of; return arrays (already iterable).
    globalThis.Headers = Headers;
  })();

  // WHATWG URL/URLSearchParams/Request/Response — JavaScriptCore core (unlike a browser JSC)
  // ships none of these. tRPC/undici-style server code needs them (new URL(...), new Request()).
  if (!globalThis.URLSearchParams) {
    function URLSearchParams(init) {
      this._list = [];
      if (init == null || init === '') return;
      if (typeof init === 'string') {
        var s = init.charAt(0) === '?' ? init.slice(1) : init;
        if (s) s.split('&').forEach(function (pair) {
          if (!pair) return;
          var i = pair.indexOf('=');
          var k = i < 0 ? pair : pair.slice(0, i);
          var v = i < 0 ? '' : pair.slice(i + 1);
          this._list.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
        }, this);
      } else if (typeof init.forEach === 'function' && !Array.isArray(init)) {
        init.forEach(function (v, k) { this._list.push([String(k), String(v)]); }, this);
      } else if (Array.isArray(init)) {
        init.forEach(function (p) { this._list.push([String(p[0]), String(p[1])]); }, this);
      } else {
        for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) this._list.push([k, String(init[k])]);
      }
    }
    var SP = URLSearchParams.prototype;
    SP.append = function (k, v) { this._list.push([String(k), String(v)]); };
    SP.set = function (k, v) { k = String(k); v = String(v); var done = false; this._list = this._list.filter(function (e) { if (e[0] === k) { if (!done) { e[1] = v; done = true; return true; } return false; } return true; }); if (!done) this._list.push([k, v]); };
    SP.get = function (k) { k = String(k); for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === k) return this._list[i][1]; return null; };
    SP.getAll = function (k) { k = String(k); return this._list.filter(function (e) { return e[0] === k; }).map(function (e) { return e[1]; }); };
    SP.has = function (k) { k = String(k); return this._list.some(function (e) { return e[0] === k; }); };
    SP['delete'] = function (k) { k = String(k); this._list = this._list.filter(function (e) { return e[0] !== k; }); };
    SP.forEach = function (cb, thisArg) { this._list.slice().forEach(function (e) { cb.call(thisArg, e[1], e[0], this); }, this); };
    SP.keys = function () { return this._list.map(function (e) { return e[0]; }); };
    SP.values = function () { return this._list.map(function (e) { return e[1]; }); };
    SP.entries = function () { return this._list.map(function (e) { return e.slice(); }); };
    SP.sort = function () { this._list.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); };
    SP.toString = function () { return this._list.map(function (e) { return encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1]); }).join('&'); };
    globalThis.URLSearchParams = URLSearchParams;
  }
  if (!globalThis.URL) {
    var __ABS = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
    function __parseURL(input) {
      var m = input.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/)?([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
      if (!m) return null;
      var protocol = m[1].toLowerCase(), slashes = !!m[2], authority = m[3] || '', pathname = m[4] || '', search = m[5] || '', hash = m[6] || '';
      var username = '', password = '', host = authority, hostname = authority, port = '';
      if (slashes) {
        var at = authority.lastIndexOf('@');
        if (at >= 0) { var ui = authority.slice(0, at); authority = authority.slice(at + 1); var ci = ui.indexOf(':'); if (ci >= 0) { username = ui.slice(0, ci); password = ui.slice(ci + 1); } else username = ui; }
        host = authority;
        var pi = authority.indexOf(':');
        if (pi >= 0) { hostname = authority.slice(0, pi); port = authority.slice(pi + 1); } else hostname = authority;
        pathname = pathname ? (pathname.charAt(0) === '/' ? pathname : '/' + pathname) : '/';
      }
      return { protocol: protocol, slashes: slashes, username: username, password: password, host: host, hostname: hostname, port: port, pathname: pathname, search: search, hash: hash };
    }
    function URL(url, base) {
      url = String(url);
      var parsed;
      if (__ABS.test(url)) parsed = __parseURL(url);
      else {
        if (base === undefined || base === null) throw new TypeError('Invalid URL: ' + url);
        var b = (base instanceof URL) ? base : new URL(String(base));
        var auth = b._p.username ? (b._p.username + (b._p.password ? ':' + b._p.password : '') + '@') : '';
        var prefix = b._p.protocol + '//' + auth + b._p.host;
        if (url.charAt(0) === '/') parsed = __parseURL(prefix + url);
        else if (url.charAt(0) === '#') parsed = __parseURL(prefix + b._p.pathname + b._p.search + url);
        else if (url.charAt(0) === '?') parsed = __parseURL(prefix + b._p.pathname + url);
        else { var basePath = b._p.pathname.slice(0, b._p.pathname.lastIndexOf('/') + 1); parsed = __parseURL(prefix + basePath + url); }
      }
      if (!parsed) throw new TypeError('Invalid URL: ' + url);
      this._p = parsed;
      this.searchParams = new globalThis.URLSearchParams(parsed.search);
    }
    Object.defineProperties(URL.prototype, {
      protocol: { get: function () { return this._p.protocol; }, enumerable: true },
      username: { get: function () { return this._p.username; }, enumerable: true },
      password: { get: function () { return this._p.password; }, enumerable: true },
      host: { get: function () { return this._p.host; }, enumerable: true },
      hostname: { get: function () { return this._p.hostname; }, enumerable: true },
      port: { get: function () { return this._p.port; }, enumerable: true },
      pathname: { get: function () { return this._p.pathname; }, enumerable: true },
      hash: { get: function () { return this._p.hash; }, enumerable: true },
      search: { get: function () { var s = this.searchParams.toString(); return s ? '?' + s : ''; }, enumerable: true },
      origin: { get: function () { return this._p.protocol + '//' + this._p.host; }, enumerable: true },
      href: { get: function () { return this.toString(); }, set: function (v) { var p = __parseURL(String(v)); if (p) { this._p = p; this.searchParams = new globalThis.URLSearchParams(p.search); } }, enumerable: true }
    });
    URL.prototype.toString = function () {
      var p = this._p;
      var auth = p.username ? (p.username + (p.password ? ':' + p.password : '') + '@') : '';
      return p.protocol + (p.slashes ? '//' : '') + auth + p.host + p.pathname + this.search + p.hash;
    };
    URL.prototype.toJSON = function () { return this.toString(); };
    globalThis.URL = URL;
  }
  if (!globalThis.Request) {
    function Request(input, init) {
      init = init || {};
      if (input instanceof Request) {
        this.url = input.url; this.method = (init.method || input.method).toUpperCase();
        this.headers = new globalThis.Headers(init.headers || input.headers);
        this._bodyInit = init.body !== undefined ? init.body : input._bodyInit; this.signal = init.signal || input.signal || null;
      } else {
        this.url = String(input); this.method = (init.method || 'GET').toUpperCase();
        this.headers = new globalThis.Headers(init.headers); this._bodyInit = init.body; this.signal = init.signal || null;
      }
      this.credentials = init.credentials || 'same-origin'; this.mode = init.mode || 'cors'; this.redirect = init.redirect || 'follow'; this.bodyUsed = false;
    }
    Request.prototype.text = function () { this.bodyUsed = true; var b = this._bodyInit; return Promise.resolve(b == null ? '' : (typeof b === 'string' ? b : String(b))); };
    Request.prototype.json = function () { return this.text().then(function (t) { return t ? JSON.parse(t) : null; }); };
    Request.prototype.arrayBuffer = function () { return this.text(); };
    Request.prototype.clone = function () { return new Request(this); };
    globalThis.Request = Request;
  }
  // Minimal web ReadableStream yielding a body once — enough for consumers that do
  // `response.body.getReader()` then read()/cancel() (e.g. tRPC's node adapter).
  if (!globalThis.ReadableStream) {
    function ReadableStream(src) { this._src = src; this.locked = false; }
    ReadableStream.prototype.getReader = function () {
      var stream = this; stream.locked = true;
      var chunks = (stream._chunks || []).slice(); var i = 0; var cancelled = false;
      return {
        read: function () { if (cancelled || i >= chunks.length) return Promise.resolve({ done: true, value: undefined }); return Promise.resolve({ done: false, value: chunks[i++] }); },
        cancel: function () { cancelled = true; return Promise.resolve(); },
        releaseLock: function () { stream.locked = false; },
        closed: Promise.resolve(undefined)
      };
    };
    ReadableStream.prototype.cancel = function () { return Promise.resolve(); };
    ReadableStream.__fromBody = function (text) { var s = new ReadableStream(); s._chunks = (text == null || text === '') ? [] : [text]; return s; };
    globalThis.ReadableStream = ReadableStream;
  }
  if (!globalThis.Response) {
    function Response(body, init) {
      init = init || {};
      this._bodyInit = (body == null) ? null : body;
      this.status = init.status !== undefined ? init.status : 200;
      this.statusText = init.statusText || '';
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new globalThis.Headers(init.headers);
      this.url = init.url || ''; this.redirected = false; this.type = 'default'; this.bodyUsed = false;
      // tRPC's node adapter consumes response.body via getReader(); model it as a 1-chunk stream.
      this.body = (this._bodyInit == null) ? null : globalThis.ReadableStream.__fromBody(typeof this._bodyInit === 'string' ? this._bodyInit : String(this._bodyInit));
    }
    Response.prototype.text = function () { this.bodyUsed = true; var b = this._bodyInit; return Promise.resolve(b == null ? '' : (typeof b === 'string' ? b : String(b))); };
    Response.prototype.json = function () { return this.text().then(function (t) { return JSON.parse(t); }); };
    Response.prototype.arrayBuffer = function () { return this.text(); };
    Response.prototype.blob = function () { return this.text(); };
    Response.prototype.clone = function () { return new Response(this._bodyInit, { status: this.status, statusText: this.statusText, headers: this.headers }); };
    Response.json = function (data, init) { init = init || {}; var h = new globalThis.Headers(init.headers); if (!h.has('content-type')) h.set('content-type', 'application/json'); return new Response(JSON.stringify(data), { status: init.status || 200, statusText: init.statusText, headers: h }); };
    Response.error = function () { var r = new Response(null, { status: 0 }); r.type = 'error'; return r; };
    Response.redirect = function (url, status) { return new Response(null, { status: status || 302, headers: { location: String(url) } }); };
    globalThis.Response = Response;
  }
  var urlMod={ parse:function(u){ try{ var x=new URL(u,'http://localhost'); return { href:x.href, protocol:x.protocol, host:x.host, hostname:x.hostname, port:x.port, pathname:x.pathname, search:x.search, query:x.search?x.search.slice(1):'', hash:x.hash, path:x.pathname+x.search }; }catch(e){ return { pathname:u, path:u, query:'', search:'' }; } }, format:function(o){ if(typeof o==='string') return o; return (o.protocol||'')+'//'+(o.host||o.hostname||'')+(o.pathname||'')+(o.search||''); }, resolve:function(a,b){ try{ return new URL(b,a).href; }catch(e){ return b; } }, URL:globalThis.URL, URLSearchParams:globalThis.URLSearchParams };
  function StringDecoder(enc){ this.enc=enc; } StringDecoder.prototype.write=function(b){ return b&&b.toString?b.toString():String(b); }; StringDecoder.prototype.end=function(){ return ''; };
  var sdMod={ StringDecoder:StringDecoder };
  var cryptoMod={ randomBytes:function(n){ var a=[]; for(var i=0;i<n;i++) a.push(Math.floor(Math.random()*256)); return (globalThis.Buffer&&globalThis.Buffer.from)?globalThis.Buffer.from(a):a; }, randomUUID:function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){ var r=Math.random()*16|0; var v=c==='x'?r:(r&0x3|0x8); return v.toString(16); }); }, createHash:function(){ var d=''; return { update:function(x){ d+=String(x); return this; }, digest:function(){ return d; } }; }, createHmac:function(){ var d=''; return { update:function(x){ d+=String(x); return this; }, digest:function(){ return d; } }; }, pbkdf2Sync:function(){ return ''; }, timingSafeEqual:function(a,b){ return String(a)===String(b); } };
  var zlibMod={ createGzip:function(){ return new PassThrough(); }, createDeflate:function(){ return new PassThrough(); }, createGunzip:function(){ return new PassThrough(); }, createInflate:function(){ return new PassThrough(); }, createBrotliCompress:function(){ return new PassThrough(); }, createBrotliDecompress:function(){ return new PassThrough(); }, gzipSync:function(x){ return x; }, gunzipSync:function(x){ return x; }, deflateSync:function(x){ return x; }, inflateSync:function(x){ return x; }, constants:{ Z_NO_FLUSH:0, Z_PARTIAL_FLUSH:1, Z_SYNC_FLUSH:2, Z_FULL_FLUSH:3, Z_FINISH:4, Z_BLOCK:5, Z_OK:0, Z_STREAM_END:1, Z_DEFAULT_COMPRESSION:-1, Z_DEFAULT_STRATEGY:0, BROTLI_OPERATION_PROCESS:0, BROTLI_OPERATION_FLUSH:1, BROTLI_OPERATION_FINISH:2 } };
  function __statusText(c){ var m={200:'OK',201:'Created',202:'Accepted',204:'No Content',301:'Moved Permanently',302:'Found',303:'See Other',304:'Not Modified',307:'Temporary Redirect',308:'Permanent Redirect',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',409:'Conflict',422:'Unprocessable Entity',429:'Too Many Requests',500:'Internal Server Error',502:'Bad Gateway',503:'Service Unavailable'}; return m[c]||'OK'; }
  function __byteLen(s){ try{ return unescape(encodeURIComponent(s)).length; }catch(e){ return String(s).length; } }
  function Stream(){ EventEmitter.call(this); } inherits(Stream, EventEmitter); Stream.prototype.pipe=function(d){ return d; };
  function Readable(){ Stream.call(this); } inherits(Readable, Stream); Readable.prototype.pipe=function(d){ return d; }; Readable.prototype.read=function(){ return null; }; Readable.prototype.setEncoding=function(){ return this; }; Readable.prototype.resume=function(){ return this; }; Readable.prototype.pause=function(){ return this; }; Readable.prototype.unpipe=function(){ return this; };
  function Writable(){ Stream.call(this); } inherits(Writable, Stream); Writable.prototype.write=function(){ return true; }; Writable.prototype.end=function(){ return this; };
  function Duplex(){ Readable.call(this); } inherits(Duplex, Readable); Duplex.prototype.write=function(){ return true; }; Duplex.prototype.end=function(){ return this; };
  function Transform(){ Duplex.call(this); } inherits(Transform, Duplex);
  // Real buffering PassThrough: node-fetch does `res.pipe(new PassThrough())` then reads it via
  // .on('data'). A stub that drops writes makes node-fetch hang. This buffers writes until a
  // 'data'/'readable' listener attaches (flowing mode), then flushes — enough for that pattern.
  function PassThrough(){ Transform.call(this); this._pbuf=[]; this._pended=false; this._pflow=false; }
  inherits(PassThrough, Transform);
  PassThrough.prototype._pflush=function(){ while(this._pbuf.length) this.emit('data', this._pbuf.shift()); if(this._pended){ this.emit('end'); this.emit('close'); } };
  PassThrough.prototype.write=function(c){ if(c==null) return true; if(this._pflow) this.emit('data', c); else this._pbuf.push(c); return true; };
  PassThrough.prototype.end=function(c){ if(c!=null && typeof c!=='function') this.write(c); this._pended=true; this.emit('finish'); if(this._pflow) this._pflush(); return this; };
  PassThrough.prototype.on=function(ev,cb){ EventEmitter.prototype.on.call(this,ev,cb); if((ev==='data'||ev==='readable')&&!this._pflow){ this._pflow=true; var self=this; Promise.resolve().then(function(){ self._pflush(); }); } return this; };
  PassThrough.prototype.addListener=PassThrough.prototype.on;
  PassThrough.prototype.once=function(ev,cb){ var self=this; function g(){ self.removeListener(ev,g); return cb.apply(this,arguments); } g.listener=cb; return self.on(ev,g); };
  PassThrough.prototype.resume=function(){ if(!this._pflow){ this._pflow=true; var self=this; Promise.resolve().then(function(){ self._pflush(); }); } return this; };
  PassThrough.prototype.pause=function(){ this._pflow=false; return this; };
  PassThrough.prototype.read=function(){ return this._pbuf.length?this._pbuf.shift():null; };
  PassThrough.prototype.pipe=function(dest){ this.on('data', function(c){ if(dest.write) dest.write(c); }); this.on('end', function(){ if(dest.end) dest.end(); }); return dest; };
  Stream.Readable=Readable; Stream.Writable=Writable; Stream.Duplex=Duplex; Stream.Transform=Transform; Stream.PassThrough=PassThrough; Stream.Stream=Stream;
  var streamMod=Stream;
  function parseRequest(text){ var idx=text.indexOf('\r\n\r\n'); var headPart=idx>=0?text.slice(0,idx):text; var body=idx>=0?text.slice(idx+4):''; var lines=headPart.split('\r\n'); var first=(lines[0]||'').split(' '); var method=first[0]||'GET'; var url=first[1]||'/'; var headers={}; for(var i=1;i<lines.length;i++){ var c=lines[i].indexOf(':'); if(c>0) headers[lines[i].slice(0,c).trim().toLowerCase()]=lines[i].slice(c+1).trim(); } var req=new Readable(); req.method=method; req.url=url; req.originalUrl=url; req.headers=headers; req.rawHeaders=[]; req.httpVersion='1.1'; req.body=body; req.socket={ remoteAddress:'127.0.0.1', remotePort:0, encrypted:false }; req.connection=req.socket; req.on=function(ev,cb){ if(ev==='data'&&body) cb(body); if(ev==='end') cb(); return this; }; req.setTimeout=function(){ return this; }; return req; }
  function ServerResponse(){ this.statusCode=200; this.statusMessage=''; this.headers={}; this._body=''; this._finished=false; this.headersSent=false; this.writable=true; this.finished=false; this.locals={}; }
  ServerResponse.prototype.setHeader=function(k,v){ this.headers[String(k).toLowerCase()]=v; return this; };
  ServerResponse.prototype.getHeader=function(k){ return this.headers[String(k).toLowerCase()]; };
  ServerResponse.prototype.removeHeader=function(k){ delete this.headers[String(k).toLowerCase()]; };
  ServerResponse.prototype.hasHeader=function(k){ return this.headers[String(k).toLowerCase()]!==undefined; };
  ServerResponse.prototype.getHeaders=function(){ return this.headers; };
  ServerResponse.prototype.writeHead=function(code,a,b){ this.statusCode=code; var h=(a&&typeof a==='object')?a:((b&&typeof b==='object')?b:null); if(typeof a==='string') this.statusMessage=a; if(h) for(var k in h) this.setHeader(k,h[k]); this.headersSent=true; return this; };
  ServerResponse.prototype.write=function(chunk){ if(chunk!=null) this._body+=(chunk.toString?chunk.toString():String(chunk)); return true; };
  ServerResponse.prototype.end=function(chunk){ if(chunk!=null) this.write(chunk); this._finished=true; this.finished=true; this.writable=false; if(this._onfinish) this._onfinish(); return this; };
  ServerResponse.prototype.flush=function(){};
  ServerResponse.prototype.on=function(ev,cb){ if(ev==='finish') this._onfinish=cb; return this; };
  ServerResponse.prototype.once=ServerResponse.prototype.on; ServerResponse.prototype.emit=function(){ return false; };
  ServerResponse.prototype._raw=function(){ var st=this.statusCode; var h=this.headers; if(h['content-type']===undefined) h['content-type']='text/plain'; h['content-length']=String(__byteLen(this._body)); h['connection']='close'; var out='HTTP/1.1 '+st+' '+__statusText(st)+'\r\n'; for(var k in h){ if(h.hasOwnProperty(k)) out+=k+': '+h[k]+'\r\n'; } out+='\r\n'+this._body; return out; };
  function createServer(a,b){ var handler=(typeof a==='function')?a:b; var srv=new EventEmitter(); srv._handler=handler; srv.on=function(ev,cb){ if(ev==='request') srv._handler=cb; return EventEmitter.prototype.on.call(this,ev,cb); }; srv.address=function(){ return { port:srv._port, address:'0.0.0.0', family:'IPv4' }; }; srv.setTimeout=function(){ return this; }; srv.close=function(cb){ if(cb) cb(); return this; }; srv.listen=function(port,a2,b2){ if(port&&typeof port==='object') port=port.port; srv._port=port; var cb=(typeof a2==='function')?a2:((typeof b2==='function')?b2:null); if(cb) cb(); EventEmitter.prototype.emit.call(srv,'listening'); globalThis.__mbServer={ port:port|0, handler:function(reqText){ var req=parseRequest(reqText); var res=new ServerResponse(); try{ srv._handler(req,res); }catch(e){ res.statusCode=500; res._body=String(e&&e.stack||e); res._finished=true; } return res; } }; return srv; }; return srv; }
  // Node HTTP client (http.request/get). node-fetch and many libs do `https.request(opts)`.
  // Implemented over the blocking __fetch native: buffer the request body, do one synchronous
  // round-trip, then replay the response as a Readable emitting 'response'->'data'->'end'.
  function __optsToUrl(o, defProto) {
    if (typeof o === 'string') return o;
    if (o instanceof globalThis.URL) return o.toString();
    var proto = o.protocol || defProto || 'http:';
    var host = o.hostname || o.host || 'localhost';
    var hasPort = host.indexOf(':') >= 0;
    var port = (o.port && !hasPort) ? (':' + o.port) : '';
    var path = o.path || (o.pathname ? (o.pathname + (o.search || '')) : '/');
    return proto + '//' + host + port + path;
  }
  function ClientRequest(options, cb, defProto) {
    EventEmitter.call(this);
    var optObj = (typeof options === 'string' || options instanceof globalThis.URL) ? {} : (options || {});
    this._url = __optsToUrl(options, defProto);
    this._method = String(optObj.method || 'GET').toUpperCase();
    this._headers = {};
    var h = optObj.headers || {};
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) this._headers[k] = h[k];
    this._body = '';
    this.destroyed = false;
    this.finished = false;
    if (typeof cb === 'function') this.once('response', cb);
  }
  inherits(ClientRequest, EventEmitter);
  ClientRequest.prototype.setHeader = function (k, v) { this._headers[k] = v; return this; };
  ClientRequest.prototype.getHeader = function (k) { return this._headers[k]; };
  ClientRequest.prototype.removeHeader = function (k) { delete this._headers[k]; };
  ClientRequest.prototype.setTimeout = function (ms, cb) { if (typeof cb === 'function') this.once('timeout', cb); return this; };
  ClientRequest.prototype.flushHeaders = function () { };
  ClientRequest.prototype.write = function (chunk) { if (chunk != null) this._body += (chunk.toString ? chunk.toString() : String(chunk)); return true; };
  ClientRequest.prototype.abort = function () { this.destroyed = true; this.aborted = true; this.emit('abort'); };
  ClientRequest.prototype.destroy = function (e) { this.destroyed = true; if (e) this.emit('error', e); return this; };
  ClientRequest.prototype.end = function (chunk) {
    if (chunk != null && typeof chunk !== 'function') this.write(chunk);
    this.finished = true;
    var self = this;
    Promise.resolve().then(function () { self._run(); });
    return this;
  };
  ClientRequest.prototype._run = function () {
    if (this.destroyed) return;
    var self = this;
    var lines = [];
    for (var k in this._headers) {
      if (!Object.prototype.hasOwnProperty.call(this._headers, k)) continue;
      // Force identity: minibun has no real zlib, so we must not let the server gzip the body
      // (node-fetch/others set Accept-Encoding: gzip and would then try to decompress).
      if (k.toLowerCase() === 'accept-encoding') continue;
      lines.push(k + ': ' + this._headers[k]);
    }
    lines.push('Accept-Encoding: identity');
    var raw;
    try { raw = __fetch(this._url, this._method, lines.join('\r\n'), this._body); }
    catch (e) { this.emit('error', e); return; }
    if (!raw || raw.error) { var er = new Error('request failed: ' + ((raw && raw.error) || 'unknown') + ' (' + this._url + ')'); this.emit('error', er); return; }
    var res = new Readable();
    res.statusCode = raw.status; res.statusMessage = ''; res.httpVersion = '1.1'; res.complete = true;
    res.headers = {}; res.rawHeaders = [];
    String(raw.headers || '').split('\r\n').forEach(function (l) { var i = l.indexOf(':'); if (i > 0) { var name = l.slice(0, i).trim(); var val = l.slice(i + 1).trim(); res.headers[name.toLowerCase()] = val; res.rawHeaders.push(name, val); } });
    res.setEncoding = function () { return this; };
    // Real pipe: forward emitted body/end/error to the destination (node-fetch does res.pipe(PassThrough)).
    res.pipe = function (dest) { res.on('data', function (c) { if (dest.write) dest.write(c); }); res.on('end', function () { if (dest.end) dest.end(); }); res.on('error', function (e) { if (dest.emit) dest.emit('error', e); }); return dest; };
    var body = raw.body || '';
    this.emit('response', res);
    Promise.resolve().then(function () { if (!res.destroyed) { if (body) res.emit('data', body); res.emit('end'); res.emit('close'); } });
  };
  function __clientRequest(defProto) { return function (options, cb) { return new ClientRequest(options, cb, defProto); }; }
  function __clientGet(defProto) { return function (options, cb) { var r = new ClientRequest(options, cb, defProto); r.end(); return r; }; }
  var httpMod={ createServer:createServer, Server:function(){ return createServer(); }, request:__clientRequest('http:'), get:__clientGet('http:'), STATUS_CODES:{}, METHODS:['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH'], IncomingMessage:Readable, ServerResponse:ServerResponse, ClientRequest:ClientRequest, globalAgent:{}, Agent:function(){} };
  var httpsMod={ createServer:createServer, Server:function(){ return createServer(); }, request:__clientRequest('https:'), get:__clientGet('https:'), STATUS_CODES:{}, METHODS:httpMod.METHODS, IncomingMessage:Readable, ServerResponse:ServerResponse, ClientRequest:ClientRequest, globalAgent:{}, Agent:function(){} };
  var netMod={ createServer:function(){ var s=new EventEmitter(); s.listen=function(p,cb){ if(typeof p==='function') cb=p; if(typeof cb==='function') cb(); return this; }; s.close=function(cb){ if(cb) cb(); return this; }; s.address=function(){ return { port:0 }; }; return s; }, Socket:function(){ return new EventEmitter(); }, connect:function(){ return new EventEmitter(); }, isIP:function(){ return 0; }, isIPv4:function(){ return false; }, isIPv6:function(){ return false; } };
  var cpMod={ spawn:function(){ var e=new EventEmitter(); e.stdout=new EventEmitter(); e.stderr=new EventEmitter(); e.stdin={ write:function(){}, end:function(){} }; e.kill=function(){}; e.pid=0; return e; }, exec:function(c,o,cb){ if(typeof o==='function') cb=o; if(cb) Promise.resolve().then(function(){ cb(null,'',''); }); return new EventEmitter(); }, execSync:function(){ return ''; }, execFile:function(f,a,o,cb){ cb=(typeof o==='function')?o:cb; if(typeof cb==='function') Promise.resolve().then(function(){ cb(null,'',''); }); return new EventEmitter(); }, fork:function(){ return new EventEmitter(); }, spawnSync:function(){ return { status:0, stdout:'', stderr:'', pid:0 }; } };
  var dnsMod={ lookup:function(h,o,cb){ cb=(typeof o==='function')?o:cb; if(typeof cb==='function') Promise.resolve().then(function(){ cb(null,'127.0.0.1',4); }); }, resolve:function(h,cb){ if(typeof cb==='function') cb(null,[]); }, promises:{ lookup:function(){ return Promise.resolve({ address:'127.0.0.1', family:4 }); } } };
  var vmMod={ runInThisContext:function(code){ return (0,eval)(code); }, runInNewContext:function(code){ return (0,eval)(code); }, createContext:function(o){ return o||{}; }, Script:function(code){ this.runInThisContext=function(){ return (0,eval)(code); }; this.runInNewContext=function(){ return (0,eval)(code); }; } };
  var perfMod={ performance:{ now:function(){ return 0; }, timeOrigin:0 }, PerformanceObserver:function(){ return { observe:function(){}, disconnect:function(){} }; } };
  function AsyncLocalStorage(){ this.getStore=function(){ return undefined; }; this.run=function(s,cb){ return cb(); }; this.enterWith=function(){}; this.exit=function(cb){ return cb(); }; }
  var asyncHooksMod={ createHook:function(){ return { enable:function(){ return this; }, disable:function(){ return this; } }; }, executionAsyncId:function(){ return 0; }, triggerAsyncId:function(){ return 0; }, AsyncLocalStorage:AsyncLocalStorage, AsyncResource:function(){ this.runInAsyncScope=function(fn,t){ return fn.apply(t, Array.prototype.slice.call(arguments,2)); }; } };
  var moduleMod={ createRequire:function(){ return function(r){ throw new Error('createRequire not supported: '+r); }; }, _cache:{}, builtinModules:[] };
  var timersMod={ setTimeout:function(){ return globalThis.setTimeout.apply(null,arguments); }, clearTimeout:function(){ return globalThis.clearTimeout.apply(null,arguments); }, setInterval:function(){ return globalThis.setInterval.apply(null,arguments); }, clearInterval:function(){ return globalThis.clearInterval.apply(null,arguments); }, setImmediate:function(){ return globalThis.setImmediate.apply(null,arguments); } };
  var builtins={ events:EventEmitter, path:pathMod, util:utilMod, assert:assertFn, fs:fsMod, os:osMod, tty:ttyMod, url:urlMod, querystring:qsMod, string_decoder:sdMod, crypto:cryptoMod, zlib:zlibMod, stream:streamMod, http:httpMod, https:httpsMod, net:netMod, child_process:cpMod, dns:dnsMod, vm:vmMod, perf_hooks:perfMod, async_hooks:asyncHooksMod, module:moduleMod, timers:timersMod, callsites:__parseCallSites, depd:__depd, v8:{ getHeapStatistics:function(){ return { total_heap_size:0, used_heap_size:0, heap_size_limit:1073741824 }; }, getHeapSpaceStatistics:function(){ return []; }, setFlagsFromString:function(){}, serialize:function(o){ return globalThis.Buffer.from(JSON.stringify(o)); }, deserialize:function(b){ return JSON.parse(b.toString()); } }, constants:{}, punycode:{ toASCII:function(s){ return s; }, toUnicode:function(s){ return s; }, encode:function(s){ return s; }, decode:function(s){ return s; } }, diagnostics_channel:{ channel:function(name){ return { name:name, hasSubscribers:false, publish:function(){}, subscribe:function(){}, unsubscribe:function(){}, bindStore:function(){}, unbindStore:function(){} }; }, hasSubscribers:function(){ return false; }, subscribe:function(){}, unsubscribe:function(){}, tracingChannel:function(){ return { hasSubscribers:false, subscribe:function(){}, unsubscribe:function(){}, traceSync:function(fn){ return fn.apply(null, Array.prototype.slice.call(arguments,2)); }, tracePromise:function(fn){ return fn.apply(null, Array.prototype.slice.call(arguments,2)); }, traceCallback:function(fn){ return fn.apply(null, Array.prototype.slice.call(arguments,2)); } }; } }, http2:{ constants:{ HTTP2_HEADER_PATH:':path', HTTP2_HEADER_STATUS:':status', HTTP2_HEADER_METHOD:':method', HTTP2_HEADER_AUTHORITY:':authority', HTTP2_HEADER_SCHEME:':scheme' }, createServer:createServer, createSecureServer:createServer, connect:function(){ return new EventEmitter(); }, getDefaultSettings:function(){ return {}; } }, worker_threads:{ isMainThread:true, Worker:function(){ return new EventEmitter(); }, parentPort:null, threadId:0, workerData:null, MessageChannel:function(){ this.port1=new EventEmitter(); this.port2=new EventEmitter(); }, MessagePort:function(){ return new EventEmitter(); }, BroadcastChannel:function(){ return new EventEmitter(); }, markAsUntransferable:function(){}, setEnvironmentData:function(){}, getEnvironmentData:function(){} }, tls:{ connect:function(){ return new EventEmitter(); }, createServer:function(){ return netMod.createServer(); }, TLSSocket:function(){ return new EventEmitter(); }, checkServerIdentity:function(){ return undefined; }, rootCertificates:[] } };
  builtins['fs/promises']=fsMod.promises; builtins['node:fs/promises']=fsMod.promises;
  if(!globalThis.global) globalThis.global=globalThis;
  if(!globalThis.TextDecoder){ globalThis.TextDecoder=function(enc,opts){ this.encoding=(enc||'utf-8').toLowerCase(); this.fatal=!!(opts&&opts.fatal); this.ignoreBOM=!!(opts&&opts.ignoreBOM); }; globalThis.TextDecoder.prototype.decode=function(buf){ if(buf==null) return ''; var bytes; if(buf.buffer&&buf.byteLength!==undefined) bytes=new Uint8Array(buf.buffer,buf.byteOffset||0,buf.byteLength); else if(buf.length!==undefined) bytes=buf; else bytes=new Uint8Array(buf); var out='',i=0,n=bytes.length; while(i<n){ var c=bytes[i++]; if(c<0x80) out+=String.fromCharCode(c); else if(c<0xE0) out+=String.fromCharCode(((c&0x1F)<<6)|(bytes[i++]&0x3F)); else if(c<0xF0) out+=String.fromCharCode(((c&0x0F)<<12)|((bytes[i++]&0x3F)<<6)|(bytes[i++]&0x3F)); else { var cp=((c&0x07)<<18)|((bytes[i++]&0x3F)<<12)|((bytes[i++]&0x3F)<<6)|(bytes[i++]&0x3F); cp-=0x10000; out+=String.fromCharCode(0xD800+(cp>>10),0xDC00+(cp&0x3FF)); } } return out; }; }
  if(!globalThis.atob){ var __B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; globalThis.btoa=function(s){ s=String(s); var out=''; for(var i=0;i<s.length;){ var c1=s.charCodeAt(i++),c2=s.charCodeAt(i++),c3=s.charCodeAt(i++); var e1=c1>>2,e2=((c1&3)<<4)|(c2>>4),e3=((c2&15)<<2)|(c3>>6),e4=c3&63; if(isNaN(c2)){ e3=64; e4=64; } else if(isNaN(c3)){ e4=64; } out+=__B64.charAt(e1)+__B64.charAt(e2)+(e3===64?'=':__B64.charAt(e3))+(e4===64?'=':__B64.charAt(e4)); } return out; }; globalThis.atob=function(s){ s=String(s).replace(/[^A-Za-z0-9+/]/g,''); var out=''; var i=0; while(i<s.length){ var e1=__B64.indexOf(s.charAt(i++)),e2=__B64.indexOf(s.charAt(i++)),e3=__B64.indexOf(s.charAt(i++)),e4=__B64.indexOf(s.charAt(i++)); out+=String.fromCharCode((e1<<2)|(e2>>4)); if(e3>=0) out+=String.fromCharCode(((e2&15)<<4)|(e3>>2)); if(e4>=0) out+=String.fromCharCode(((e3&3)<<6)|e4); } return out; }; }
  if(!globalThis.TextEncoder){ globalThis.TextEncoder=function(){ this.encoding='utf-8'; }; globalThis.TextEncoder.prototype.encode=function(str){ str=String(str); var bytes=[]; for(var i=0;i<str.length;i++){ var c=str.charCodeAt(i); if(c<0x80) bytes.push(c); else if(c<0x800) bytes.push(0xC0|(c>>6),0x80|(c&0x3F)); else if(c>=0xD800&&c<0xDC00){ var c2=str.charCodeAt(++i); var cp=0x10000+((c&0x3FF)<<10)+(c2&0x3FF); bytes.push(0xF0|(cp>>18),0x80|((cp>>12)&0x3F),0x80|((cp>>6)&0x3F),0x80|(cp&0x3F)); } else bytes.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F)); } return new Uint8Array(bytes); }; globalThis.TextEncoder.prototype.encodeInto=function(str,dest){ var e=this.encode(str); for(var i=0;i<e.length&&i<dest.length;i++) dest[i]=e[i]; return { read:str.length, written:Math.min(e.length,dest.length) }; }; }
  if(!globalThis.Buffer){
    function __decorateBuf(a){
      a._str=(a._str!==undefined)?a._str:null;
      a.toString=function(enc){ if(this._str!=null) return this._str; var s=''; for(var i=0;i<this.length;i++) s+=String.fromCharCode(this[i]); return s; };
      a.subarray=function(from,to){ return __decorateBuf(Array.prototype.slice.call(this,from,to)); };
      a.slice=a.subarray;
      a.readUInt8=function(o){ return this[o||0]&0xff; };
      a.writeUInt8=function(v,o){ this[o||0]=v&0xff; return (o||0)+1; };
      a.equals=function(o){ return this.toString()===(o&&o.toString?o.toString():String(o)); };
      return a;
    }
    function Buffer2(a,b){ if(typeof a==='number') return Buffer2.alloc(a); if(a!=null) return Buffer2.from(a,b); return Buffer2.from([]); }
    Buffer2.from=function(x){ if(typeof x==='string'){ var a=[]; for(var i=0;i<x.length;i++) a.push(x.charCodeAt(i)&0xff); a._str=x; return __decorateBuf(a); } if(Array.isArray(x)||(x&&x.length!==undefined&&typeof x!=='string')){ var b=Array.prototype.slice.call(x); return __decorateBuf(b); } return x; };
    Buffer2.alloc=function(n,f){ var a=[]; for(var i=0;i<n;i++) a.push((typeof f==='number')?f:0); a._str=''; return __decorateBuf(a); };
    Buffer2.allocUnsafe=Buffer2.alloc; Buffer2.allocUnsafeSlow=Buffer2.alloc;
    Buffer2.isBuffer=function(x){ return Array.isArray(x)&&typeof x.subarray==='function'&&x._str!==undefined; };
    Buffer2.concat=function(list){ var out=[]; for(var i=0;i<list.length;i++){ var it=list[i]; if(it) for(var j=0;j<it.length;j++) out.push(it[j]); } return __decorateBuf(out); };
    Buffer2.byteLength=function(s){ return typeof s==='string'?s.length:(s&&s.length||0); };
    globalThis.Buffer=Buffer2;
  }
  builtins.buffer={ Buffer:globalThis.Buffer, kMaxLength:2147483647, constants:{ MAX_LENGTH:2147483647 }, SlowBuffer:globalThis.Buffer, INSPECT_MAX_BYTES:50 };
  builtins.compression=function(){ var mw=function(req,res,next){ res.flush=res.flush||function(){}; if(typeof next==='function') next(); }; mw.filter=function(){ return false; }; return mw; };
  if(!globalThis.fetch){ function __hdrLines(h){ if(!h) return ''; var out=[]; if(typeof h.entries==='function'){ var es=h.entries(); for(var i=0;i<es.length;i++){ var k=String(es[i][0]).toLowerCase(); if(k==='host'||k==='content-length'||k==='connection') continue; out.push(es[i][0]+': '+es[i][1]); } } else { for(var k in h){ if(!h.hasOwnProperty(k)) continue; var kl=k.toLowerCase(); if(kl==='host'||kl==='content-length'||kl==='connection') continue; out.push(k+': '+h[k]); } } return out.join('\r\n'); }
    globalThis.fetch=function(url, opts){ opts=opts||{}; try{ var method=String(opts.method||'GET').toUpperCase(); var headers=__hdrLines(opts.headers); var body=(opts.body!=null)?(typeof opts.body==='string'?opts.body:String(opts.body)):''; var raw=__fetch(String(url), method, headers, body); if(!raw){ return Promise.reject(new Error('fetch failed: null response ('+url+')')); } if(raw.error){ var er=new Error('fetch failed: '+raw.error+' ('+url+')'); er.code=raw.error; return Promise.reject(er); } var hm={}; String(raw.headers||'').split('\r\n').forEach(function(l){ var i=l.indexOf(':'); if(i>0) hm[l.slice(0,i).trim().toLowerCase()]=l.slice(i+1).trim(); }); var bodyStr=raw.body||''; var res={ status:raw.status, statusText:'', ok:(raw.status>=200&&raw.status<300), url:String(url), redirected:false, type:'basic', bodyUsed:false, headers:{ get:function(n){ var v=hm[String(n).toLowerCase()]; return v===undefined?null:v; }, has:function(n){ return hm[String(n).toLowerCase()]!==undefined; }, forEach:function(cb){ for(var k in hm) cb(hm[k],k,this); }, entries:function(){ var a=[]; for(var k in hm) a.push([k,hm[k]]); return a; }, keys:function(){ return Object.keys(hm); } }, text:function(){ this.bodyUsed=true; return Promise.resolve(bodyStr); }, json:function(){ this.bodyUsed=true; try{ return Promise.resolve(JSON.parse(bodyStr)); }catch(e){ return Promise.reject(e); } }, arrayBuffer:function(){ this.bodyUsed=true; return Promise.resolve(bodyStr); }, blob:function(){ this.bodyUsed=true; return Promise.resolve(bodyStr); }, clone:function(){ return res; } }; return Promise.resolve(res); }catch(e){ return Promise.reject(e); } };
    globalThis.Headers=globalThis.Headers||function(init){ var m={}; if(init){ if(typeof init.forEach==='function'&&!Array.isArray(init)){ init.forEach(function(v,k){ m[String(k).toLowerCase()]=v; }); } else if(Array.isArray(init)){ init.forEach(function(p){ m[String(p[0]).toLowerCase()]=p[1]; }); } else { for(var k in init){ if(init.hasOwnProperty(k)) m[k.toLowerCase()]=init[k]; } } } this.get=function(k){ var v=m[String(k).toLowerCase()]; return v===undefined?null:v; }; this.set=function(k,v){ m[String(k).toLowerCase()]=v; }; this.has=function(k){ return m[String(k).toLowerCase()]!==undefined; }; this.append=this.set; this['delete']=function(k){ delete m[String(k).toLowerCase()]; }; this.forEach=function(cb){ for(var k in m) cb(m[k],k,this); }; this.entries=function(){ var a=[]; for(var k in m) a.push([k,m[k]]); return a; }; this.keys=function(){ return Object.keys(m); }; }; }
  if(!globalThis.SharedArrayBuffer){ globalThis.SharedArrayBuffer=ArrayBuffer; }
  if(!globalThis.queueMicrotask){ globalThis.queueMicrotask=function(cb){ Promise.resolve().then(cb); }; }
  if(!globalThis.structuredClone){ globalThis.structuredClone=function(o){ return (o==null||typeof o!=='object')?o:JSON.parse(JSON.stringify(o)); }; }
  if(!globalThis.crypto||!globalThis.crypto.getRandomValues){ globalThis.crypto=globalThis.crypto||{}; if(!globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues=function(a){ for(var i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256); return a; }; if(!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID=function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){ var r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8); return v.toString(16); }); }; }
  if(!globalThis.EventTarget){ function EventTarget(){ this.__lst={}; } EventTarget.prototype.addEventListener=function(t,cb){ if(!this.__lst)this.__lst={}; (this.__lst[t]||(this.__lst[t]=[])).push(cb); }; EventTarget.prototype.removeEventListener=function(t,cb){ if(!this.__lst)return; var a=this.__lst[t]; if(a){ var i=a.indexOf(cb); if(i>=0) a.splice(i,1); } }; EventTarget.prototype.dispatchEvent=function(ev){ if(!this.__lst)return true; var a=this.__lst[ev&&ev.type]; if(a) a.slice().forEach(function(f){ try{ (f.handleEvent||f).call(null,ev); }catch(e){} }); return true; }; globalThis.EventTarget=EventTarget; }
  if(!globalThis.Event){ globalThis.Event=function(type,init){ this.type=type; this.bubbles=!!(init&&init.bubbles); this.defaultPrevented=false; }; globalThis.Event.prototype.preventDefault=function(){ this.defaultPrevented=true; }; globalThis.Event.prototype.stopPropagation=function(){}; globalThis.Event.prototype.stopImmediatePropagation=function(){}; }
  if(!globalThis.AbortController){ function AbortSignal(){ this.aborted=false; this.reason=undefined; this.__lst={}; this.onabort=null; } AbortSignal.prototype.addEventListener=function(t,cb){ (this.__lst[t]||(this.__lst[t]=[])).push(cb); }; AbortSignal.prototype.removeEventListener=function(t,cb){ var a=this.__lst[t]; if(a){ var i=a.indexOf(cb); if(i>=0) a.splice(i,1); } }; AbortSignal.prototype.dispatchEvent=function(ev){ var a=this.__lst[ev&&ev.type]; if(a) a.slice().forEach(function(f){ try{ (f.handleEvent||f).call(null,ev); }catch(e){} }); if(ev&&ev.type==='abort'&&typeof this.onabort==='function'){ try{ this.onabort(ev); }catch(e){} } return true; }; AbortSignal.prototype.throwIfAborted=function(){ if(this.aborted) throw (this.reason||new Error('Aborted')); }; AbortSignal.abort=function(r){ var s=new AbortSignal(); s.aborted=true; s.reason=r||new Error('Aborted'); return s; }; AbortSignal.timeout=function(){ return new AbortSignal(); }; globalThis.AbortSignal=AbortSignal; function AbortController(){ this.signal=new AbortSignal(); } AbortController.prototype.abort=function(r){ if(this.signal.aborted) return; this.signal.aborted=true; this.signal.reason=r||new Error('Aborted'); this.signal.dispatchEvent({ type:'abort' }); }; globalThis.AbortController=AbortController; }
  if(globalThis.console){ var __c=globalThis.console; if(!__c.error)__c.error=__c.log; if(!__c.warn)__c.warn=__c.log; if(!__c.info)__c.info=__c.log; if(!__c.debug)__c.debug=__c.log; if(!__c.trace)__c.trace=__c.log; if(!__c.dir)__c.dir=__c.log; if(!__c.group)__c.group=function(){}; if(!__c.groupEnd)__c.groupEnd=function(){}; if(!__c.table)__c.table=__c.log; if(!__c.assert)__c.assert=function(){}; if(!__c.time)__c.time=function(){}; if(!__c.timeEnd)__c.timeEnd=function(){}; }
  var __envOverlay={}; var __env; try{ __env=new Proxy(__envOverlay,{ get:function(t,k){ if(Object.prototype.hasOwnProperty.call(t,k)) return t[k]; if(typeof k!=='string') return undefined; var v=__getenv(k); return v; }, set:function(t,k,v){ t[k]=(v==null?v:String(v)); return true; }, has:function(t,k){ if(Object.prototype.hasOwnProperty.call(t,k)) return true; return typeof k==='string' && __getenv(k)!==undefined; }, deleteProperty:function(t,k){ delete t[k]; return true; } }); }catch(e){ __env=__envOverlay; }
  if(!globalThis.process){ globalThis.process={ env:__env, argv:['minibun', __entryPath], platform:'darwin', arch:'arm64', version:'v18.0.0', versions:{node:'18.0.0'}, pid:1, title:'minibun', cwd:function(){ return dirname(__entryPath); }, nextTick:function(f){ var a=Array.prototype.slice.call(arguments,1); Promise.resolve().then(function(){ f.apply(null,a); }); }, on:function(){ return this; }, once:function(){ return this; }, emit:function(){ return false; }, exit:function(){}, hrtime:(function(){ var f=function(t){ return [0,0]; }; f.bigint=function(){ return BigInt(0); }; return f; })(), memoryUsage:(function(){ var f=function(){ return { rss:0, heapTotal:0, heapUsed:0, external:0, arrayBuffers:0 }; }; f.rss=function(){ return 0; }; return f; })(), uptime:function(){ return 0; }, stdout:{ write:function(s){ if(typeof s!=='string') s=String(s); if(s.slice(-1)==='\n') s=s.slice(0,-1); console.log(s); return true; }, isTTY:false, on:function(){ return this; }, once:function(){ return this; } }, stderr:{ write:function(s){ if(typeof s!=='string') s=String(s); if(s.slice(-1)==='\n') s=s.slice(0,-1); console.log(s); return true; }, isTTY:false, on:function(){ return this; }, once:function(){ return this; } } }; }
  builtins.process=globalThis.process; builtins['node:process']=globalThis.process;
  if(!globalThis.setTimeout){ globalThis.setTimeout=function(f,ms){ return 0; }; globalThis.clearTimeout=function(){}; globalThis.setInterval=function(){ return 0; }; globalThis.clearInterval=function(){}; globalThis.setImmediate=function(f){ Promise.resolve().then(f); return 0; }; globalThis.clearImmediate=function(){}; }
  globalThis.__mbGetRaw=function(res){ return res._raw(); };
  globalThis.__runEntry=function(entry){ return loadModule(entry); };
})();
