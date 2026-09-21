// JS codegen backend — HIR → JavaScript for browser playground
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg } from "./hir";
import type { TypeKind } from "./types";

// Quote a Milo string literal as its UTF-8 bytes, one byte per JS code unit — the
// representation the whole backend assumes (see the runtime's byte-string note).
// `"héllo"` becomes "h\xc3\xa9llo", six units, so `.len` is 6 and `s[1]` is 195,
// exactly as native reads it. Escaping every non-printable byte also keeps the
// emitted file plain ASCII, so it can't be corrupted by an encoding guess.
const __utf8 = new TextEncoder();
// Built in bounded chunks joined once, not one `out += ` per byte: an `@embedFile` asset
// arrives here as one char per byte, so a multi-megabyte embed makes this the hottest loop
// in the backend. Same shape as `escapeCString` in codegen.ts, which cost ~15s on
// `examples/games/flight` before it was chunked.
function jsByteString(s: string): string {
  const parts: string[] = ['"'];
  let chunk = "";
  for (const b of __utf8.encode(s)) {
    if (b === 0x22) chunk += '\\"';
    else if (b === 0x5c) chunk += "\\\\";
    else if (b >= 0x20 && b < 0x7f) chunk += String.fromCharCode(b);
    else chunk += "\\x" + b.toString(16).padStart(2, "0");
    if (chunk.length >= 65536) { parts.push(chunk); chunk = ""; }
  }
  parts.push(chunk, '"');
  return parts.join("");
}

// Host-independent runtime helpers. Everything that does IO (`__print`, `__flush`,
// `__eprint`) is supplied by the host instead, because `milo emit-js` writes to a
// real stdout and the playground captures into an array. Shared so those two can't
// fork: the playground used to carry its own copy, which had already drifted to a
// 6-digit `%g` long after the emitted runtime moved to shortest-round-trip.
export const JS_RUNTIME_HELPERS: string = [
  `function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }`,
  // Every trap Milo guarantees natively — overflow, division by zero, out-of-bounds,
  // over-shift, unwrap-on-None. Without these the JS backend silently computes a
  // different answer than the binary for the exact inputs the native build refuses
  // to run at all, which is the worst way for a second backend to be wrong.
  `function __trap(m) { const e = new Error('milo: ' + m); e.__milo_trap = true; throw e; }`,
  `function __ovf(v, lo, hi) { if (!(v >= lo && v <= hi)) __trap('runtime error: integer overflow'); return v; }`,
  `function __idiv(a, b) { if (b === 0) __trap('division by zero'); return Math.trunc(a / b); }`,
  `function __irem(a, b) { if (b === 0) __trap('division by zero'); return a % b; }`,
  `function __idx(a, i) { if (!(i >= 0 && i < a.length)) __trap('array index out of bounds: ' + i + '/' + a.length); return a[i]; }`,
  `function __idxSet(a, i, v) { if (!(i >= 0 && i < a.length)) __trap('array index out of bounds: ' + i + '/' + a.length); a[i] = v; return v; }`,
  // 64-bit `& | ^` on doubles: split into int32 halves (the low word via >>> 0, the high
  // word by division, both correct for negatives), combine, and rebuild. Exact whenever
  // the result fits a JS integer (53 bits). When it does not, keep the low word exact and
  // let the high word lose its top bits: a rotate such as `(x << 30) | (x >> 2)` followed
  // by `& 0xffffffff` (every 32-bit hash in std) reads only the low word, while nothing
  // can read the true top bits of a 61-bit value from a double anyway.
  `function __b64(a, b, op) { const ah = Math.floor(a / 4294967296) | 0, al = a >>> 0, bh = Math.floor(b / 4294967296) | 0, bl = b >>> 0; let h = op === '&' ? (ah & bh) : op === '|' ? (ah | bh) : (ah ^ bh); const l = (op === '&' ? (al & bl) : op === '|' ? (al | bl) : (al ^ bl)) >>> 0; if (h > 2097151 || h < -2097152) h = (h << 11) >> 11; return h * 4294967296 + l; }`,
  `function __sh(s, bits) { if (!(s >= 0 && s < bits)) __trap('shift amount out of range (>= ' + bits + ')'); return s; }`,
  `function __unwrap(o) { if (o.tag !== 0) __trap('unwrap called on ' + (o.data === undefined ? 'None' : 'Err')); return o.data[0]; }`,
  // Milo strings are UTF-8 byte buffers, so in JS they are held as one byte per
  // UTF-16 code unit — a "binary string". That makes .length, s[i], .slice and `+=`
  // byte-exact for free, which matters in both directions: `"héllo".len` is 6, and a
  // string built a byte at a time (sha256, deflate, png) stays a byte buffer instead
  // of becoming text. Source literals are stored as their UTF-8 bytes to match; the
  // decode back to real text happens once, on output.
  `function __obytes(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF; return u; }`,
  `function __otext(s) { return typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(__obytes(s)) : s; }`,
  `function __sbyte(s, i) { if (!(i >= 0 && i < s.length)) __trap('string index out of bounds: ' + i + '/' + s.length); return s.charCodeAt(i); }`,
  // Mirrors @milo.fmt.f64 in codegen.ts so playground output equals the
  // compiled binary's: walk the integer-digit count up by powers of ten, then
  // raise %g precision until the text parses back to the same double. __gfmt
  // is C's "%.*g" — exponent form when exp < -4 or exp >= precision, trailing
  // zeros trimmed. Native prints f32 at f32 precision; JS has no f32, so a
  // literal typed f32 is the one case where the two backends can disagree.
  `function __gfmt(x, p) { if (x === 0) return Object.is(x, -0) ? '-0' : '0'; const es = x.toExponential(p - 1); const ei = es.indexOf('e'); const e = Number(es.slice(ei + 1)); if (e < -4 || e >= p) { let m = es.slice(0, ei); if (m.indexOf('.') >= 0) m = m.replace(/0+$/, '').replace(/\\.$/, ''); let ea = String(Math.abs(e)); if (ea.length < 2) ea = '0' + ea; return m + 'e' + (e < 0 ? '-' : '+') + ea; } let s = x.toFixed(Math.max(0, p - 1 - e)); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\\.$/, ''); return s; }`,
  `function __fmtG(x) { if (Number.isNaN(x)) return 'nan'; if (!isFinite(x)) return x > 0 ? 'inf' : '-inf'; let dig = 1, pow = 10; const av = Math.abs(x); while (dig < 17 && av >= pow) { dig++; pow *= 10; } for (let p = dig; p < 17; p++) { const s = __gfmt(x, p); if (Number(s) === x) return s; } return __gfmt(x, 17); }`,
  `function __propagate(r) { if (r.tag !== 0) throw { __milo_prop: r }; return r.data[0]; }`,
  // Display formatting to match native: structs as `Name { f: v, … }`, enums as
  // `Variant(a, …)`/`Variant`, strings quoted, floats via %g.
  // Array/Map are checked before the struct fallback: their constructor name is not
  // 'Object', so they would otherwise be rendered field-by-field as a struct.
  `function __displayVal(v) { if (typeof v === 'string') return JSON.stringify(v); if (typeof v === 'boolean') return String(v); if (typeof v === 'number') return Number.isInteger(v) ? String(v) : __fmtG(v); if (Array.isArray(v)) return __displaySeq(v); if (v instanceof Map) return __displayMap(v); if (v && typeof v === 'object' && v.constructor && v.constructor.name !== 'Object') return __displayStruct(v); return String(v); }`,
  `function __displaySeq(v) { return '[' + v.map(__displayVal).join(', ') + ']'; }`,
  `function __displayMap(v) { const out = []; for (const [k, val] of v) out.push(__displayVal(k) + ': ' + __displayVal(val)); return '{' + out.join(', ') + '}'; }`,
  `function __displayStruct(v) { const ks = Object.keys(v); return v.constructor.name + ' { ' + ks.map(k => k + ': ' + __displayVal(v[k])).join(', ') + ' }'; }`,
  `function __displayEnum(v, name) { const e = __enumMeta[name][v.tag]; return e[1] === 0 ? e[0] : e[0] + '(' + v.data.map(__displayVal).join(', ') + ')'; }`,
  // Maps need the explicit branch: Object.keys of a Map is empty, so the
  // generic object path would silently produce an empty HashMap.
  `function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); if (v instanceof Map) return new Map(Array.from(v, ([k, x]) => [k, __clone(x)])); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }`,
  `function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); if (a instanceof Map || b instanceof Map) { if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false; for (const [k, v] of a) { if (!b.has(k) || !__eq(v, b.get(k))) return false; } return true; } const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }`,
].join("\n");

// True if `s` can `break`/`continue` a loop OUTSIDE the block it appears in. A loop
// the block itself contains swallows its own jumps, so those bodies aren't searched.
// `return` is not counted: a match-expression arm compiles it to a sentinel throw the
// function boundary catches (see genFunction), so it does escape the arm correctly.
function breaksOuterLoop(s: HIRStmt): boolean {
  switch (s.kind) {
    case "Break": case "Continue":
      return true;
    case "If":
      return s.thenBody.some(breaksOuterLoop) || (s.elseBody?.some(breaksOuterLoop) ?? false);
    case "Match":
      return s.arms.some(a => a.body.some(breaksOuterLoop));
    case "UnsafeBlock":
      return s.body.some(breaksOuterLoop);
    default:
      return false;
  }
}

export class CodegenJS {
  private output: string[] = [];
  private indent = 0;
  private tempCounter = 0;
  private usedPropagate = false;
  // Depth of match-expression arms being generated, and whether any arm in the
  // current function returned — see genMatchExpr.
  private inMatchExprArm = 0;
  private usedMatchReturn = false;
  // Names boxed as `{v: …}` in the current function: JS-immutable values (numbers,
  // strings, bools) that are taken by `&mut`/`&` must share mutations across the call,
  // which JS by-value passing can't do. Ref params + ref-taken locals become boxes.
  private boxed: Set<string> = new Set();
  // Every top-level function name, and the locals renamed because they collide with
  // one. Milo lets `let lenBase = lenBase()` mean "call the function, bind a new
  // local"; JS reads it as a self-referential `const` and throws a TDZ
  // ReferenceError at the call. std/inflate does exactly this, so the whole PNG
  // path crashed under emit-js. The rename is registered AFTER the initializer is
  // generated, which is what lets the call in it still resolve to the function.
  private fnNames: Set<string> = new Set();
  private renamed: Map<string, string> = new Map();
  // Field/variant layouts, so `zeroed<T>()` can build the same all-zero value the
  // native backend gets from LLVM's zeroinitializer.
  private structFields: Map<string, { name: string; type: TypeKind }[]> = new Map();
  private enumVariants: Map<string, { name: string; tag: number; fields: TypeKind[] }[]> = new Map();
  // Set for the duration of a `@wrapping` function, mirroring codegen.ts: + - * and
  // unary neg use defined modular arithmetic instead of trapping, and an over-shift
  // is masked into range. Division by zero and bounds still trap.
  private currentFnWrapping = false;

  // When true, emit requires/ensures as runtime checks (like a native `--debug`
  // build). Off by default so `milo emit-js` output — e.g. the browser emulators —
  // carries no contract overhead; the playground opts in.
  constructor(private emitContracts = false) {}

  // The JS name a local binds to, renaming it out of the way of a same-named
  // top-level function. Call sites emit the function's name directly, so only
  // value references need the map.
  private bindLocal(name: string): string {
    if (!this.fnNames.has(name)) return name;
    const js = `${name}__local`;
    this.renamed.set(name, js);
    return js;
  }

  // A value reference to a name, after any such rename.
  private localRef(name: string): string {
    return this.renamed.get(name) ?? name;
  }

  // JS-immutable primitive → needs a box to be shared by reference. Objects (struct/
  // vec/map/enum) are already reference types, so a `&mut` to them works as-is.
  private needsBox(t: any): boolean {
    return !!t && (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "char" || t.tag === "string");
  }

  // Collect local names taken by-ref anywhere in a subtree (generic HIR walk: any
  // HIRArg with passByRef whose expr is a primitive Ident).
  private collectRefTaken(node: any, out: Set<string>) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) this.collectRefTaken(x, out); return; }
    // only `&mut` (mutation must write back) needs a box; a read-only `&` borrow of a
    // primitive can pass by value.
    if (node.refMut && node.expr && node.expr.kind === "Ident" && this.needsBox(node.expr.type)) {
      out.add(node.expr.name);
    }
    for (const k of Object.keys(node)) this.collectRefTaken(node[k], out);
  }

  private emit(line: string) {
    this.output.push("  ".repeat(this.indent) + line);
  }

  private nextTemp(): string {
    return `_t${this.tempCounter++}`;
  }

  generate(module: HIRModule): string {
    this.emit(`"use strict";`);
    this.emit("");

    // runtime helpers
    this.emitRuntime();

    this.emitBody(module);

    return this.output.join("\n") + "\n";
  }

  // Emit everything except runtime preamble — for playground use
  generateBody(module: HIRModule): string {
    this.emitBody(module);
    return this.output.join("\n") + "\n";
  }

  private emitBody(module: HIRModule) {
    // structs as classes
    for (const s of module.structs) {
      this.structFields.set(s.name, s.fields);
      this.genStruct(s);
    }

    // enums as tagged objects
    for (const e of module.enums) {
      this.enumVariants.set(e.name, e.variants);
      this.genEnum(e);
    }

    // enum metadata for Display: name -> [[variant, fieldCount], ...] in tag order.
    // Option/Result are built-ins (not in module.enums) but still printable.
    {
      const metaEntries = module.enums.map(
        e => `  ${JSON.stringify(e.name)}: [${e.variants.map(v => `[${JSON.stringify(v.name)}, ${v.fields.length}]`).join(", ")}]`,
      );
      metaEntries.push(`  "Option": [["Some", 1], ["None", 0]]`);
      metaEntries.push(`  "Result": [["Ok", 1], ["Err", 1]]`);
      this.emit(`const __enumMeta = {\n${metaEntries.join(",\n")}\n};`);
      this.emit("");
    }

    // interface dispatch table: "<Concrete>:<Iface>" -> [method fns in slot order].
    // Function declarations hoist, so referencing them here (before their defs) is fine.
    if (module.itables && module.itables.length > 0) {
      const entries = module.itables.map(
        it => `  ${JSON.stringify(it.concreteType + ":" + it.ifaceName)}: [${it.methods.join(", ")}]`,
      );
      this.emit(`const __itable = {\n${entries.join(",\n")}\n};`);
      this.emit("");
    }

    for (const fn of module.functions) this.fnNames.add(fn.name);

    // module-level globals (e.g. lookup tables). Emit before functions: function
    // decls hoist, so a global initializer may reference a function declared later,
    // but the global's own value must be evaluated before main() runs. No function
    // scope here, so no boxing applies.
    for (const g of module.globals) {
      const prevBoxed = this.boxed;
      this.boxed = new Set();
      this.emit(`${g.mutable ? "let" : "const"} ${g.name} = ${this.genExpr(g.value)};`);
      this.boxed = prevBoxed;
    }
    if (module.globals.length > 0) this.emit("");

    // functions
    for (const fn of module.functions) {
      if (fn.isExtern) continue;
      this.genFunction(fn);
      this.emit("");
    }

    // Entry point. A trap has to flush first: native writes stdout as it goes and
    // only then aborts, so output produced before the failing line is part of the
    // observable behaviour both backends must agree on. Buffered `__out` would
    // otherwise be dropped on the way out.
    this.emit("try { main(); __flush(); } catch (__e) { __flush(); if (__e && __e.__milo_trap) { __eprint(__e.message + \"\\n\"); if (typeof process !== 'undefined') process.exit(134); } throw __e; }");
  }

  private emitRuntime() {
    this.emit("// runtime");
    this.emit("const __out = [];");
    this.emit("function __print(s) { __out.push(String(s)); }");
    // Output is where the byte-string representation turns back into text: the
    // buffer holds UTF-8 bytes one per code unit, so it goes out as raw bytes on a
    // real stdout and gets decoded for console.log.
    this.emit("function __flush() { if (__out.length === 0) return; const text = __out.join(''); __out.length = 0; if (typeof process !== 'undefined') process.stdout.write(__obytes(text)); else if (typeof console !== 'undefined') console.log(__otext(text)); }");
    this.emit("function __eprint(s) { if (typeof process !== 'undefined' && process.stderr) process.stderr.write(__obytes(String(s))); else if (typeof console !== 'undefined') console.error(__otext(String(s))); }");
    for (const line of JS_RUNTIME_HELPERS.split("\n")) this.emit(line);
    this.emit("");
  }

  private genStruct(s: { name: string; fields: { name: string; type: TypeKind }[] }) {
    const fields = s.fields.map(f => f.name);
    this.emit(`class ${s.name} {`);
    this.indent++;
    this.emit(`constructor(${fields.join(", ")}) {`);
    this.indent++;
    for (const f of fields) this.emit(`this.${f} = ${f};`);
    this.indent--;
    this.emit("}");
    this.indent--;
    this.emit("}");
    this.emit("");
  }

  private genEnum(e: { name: string; variants: { name: string; tag: number; fields: TypeKind[] }[] }) {
    this.emit(`const ${e.name} = {`);
    this.indent++;
    for (const v of e.variants) {
      if (v.fields.length === 0) {
        this.emit(`${v.name}() { return { tag: ${v.tag} }; },`);
      } else {
        const params = v.fields.map((_, i) => `_${i}`).join(", ");
        this.emit(`${v.name}(${params}) { return { tag: ${v.tag}, data: [${params}] }; },`);
      }
    }
    this.indent--;
    this.emit("};");
    this.emit("");
  }

  private genFunction(fn: HIRFunction) {
    const params = fn.params.map(p => p.name).join(", ");
    this.emit(`function ${fn.name}(${params}) {`);
    this.indent++;
    // Boxed names for this function: ref/refMut primitive params (received as boxes)
    // plus primitive locals whose address is taken by a callee. Read/written via `.v`.
    const boxed = new Set<string>();
    for (const p of fn.params) if (p.isRefMut && this.needsBox(p.type)) boxed.add(p.name);
    this.collectRefTaken(fn.body, boxed);
    const prevBoxed = this.boxed;
    this.boxed = boxed;
    const prevRenamed = this.renamed;
    this.renamed = new Map();
    const prevWrapping = this.currentFnWrapping;
    this.currentFnWrapping = !!fn.isWrapping;
    const prevOutput = this.output;

    // Contracts. The browser has no solver, so — exactly like a native `--debug`
    // build — we enforce requires/ensures at runtime: requires at entry, ensures on
    // the return value. `ensures` refers to `result`, so we funnel the whole body
    // through an IIFE and bind its value to `result` before checking. Only functions
    // that actually carry contracts get wrapped; everything else is untouched.
    const contracts = this.emitContracts ? (fn.contracts ?? []) : [];
    const scratch: string[] = [];
    this.output = scratch;
    const requireChecks = contracts.filter(c => c.kind === "requires").map(c => this.genExpr(c.expr));
    const ensureChecks = contracts.filter(c => c.kind === "ensures").map(c => this.genExpr(c.expr));

    // Emit the body into a buffer so we know whether it used `?`; if so, wrap it in
    // try/catch that turns the propagate sentinel into an early Err/None return.
    const lines: string[] = [];
    this.output = lines;
    const prevUsed = this.usedPropagate;
    const prevMatchReturn = this.usedMatchReturn;
    this.usedPropagate = false;
    this.usedMatchReturn = false;
    for (const stmt of fn.body) this.genStmt(stmt);
    const used = this.usedPropagate || this.usedMatchReturn;
    const caughtMatchReturn = this.usedMatchReturn;
    this.usedPropagate = prevUsed;
    this.usedMatchReturn = prevMatchReturn;
    this.output = prevOutput;
    this.boxed = prevBoxed;
    this.renamed = prevRenamed;
    this.currentFnWrapping = prevWrapping;

    for (const cond of requireChecks)
      this.emit(`if (!(${cond})) throw new Error("requires clause violated");`);

    const emitBody = () => {
      if (used) {
        this.emit("try {");
        for (const l of lines) this.output.push(l);
        const matchRet = caughtMatchReturn ? " if (__e && __e.__milo_ret) return __e.__milo_ret[0];" : "";
        this.emit(`} catch (__e) { if (__e && __e.__milo_prop) return __e.__milo_prop;${matchRet} throw __e; }`);
      } else {
        for (const l of lines) this.output.push(l);
      }
    };

    if (ensureChecks.length) {
      this.emit("const result = (() => {");
      this.indent++;
      emitBody();
      this.indent--;
      this.emit("})();");
      for (const cond of ensureChecks)
        this.emit(`if (!(${cond})) throw new Error("ensures clause violated");`);
      this.emit("return result;");
    } else {
      emitBody();
    }

    this.indent--;
    this.emit("}");
  }

  private genStmt(stmt: HIRStmt) {
    switch (stmt.kind) {
      case "Let":         return this.genLet(stmt);
      case "Assign":      return this.genAssign(stmt);
      case "Return":      return this.genReturn(stmt);
      case "If":          return this.genIf(stmt);
      case "While":       return this.genWhile(stmt);
      case "Break":       return this.emit("break;");
      case "Continue":    return this.emit("continue;");
      case "ExprStmt":    return this.emit(`${this.genExpr(stmt.expr)};`);
      case "Match":       return this.genMatch(stmt);
      case "ForRange":    return this.genForRange(stmt);
      case "ForEach":     return this.genForEach(stmt);
      case "ForStrView":  return this.genForStrView(stmt);
      case "ForIterator": return this.genForIterator(stmt);
      // No `unsafe` in JS — there are no raw pointers to guard. The block is its body.
      case "UnsafeBlock": return this.genStmts(stmt.body);
      default:
        // `genExpr` next door already fails loudly on an unhandled kind; this one returns
        // void, so TypeScript enforces nothing and an unhandled statement was simply not
        // emitted — the JS ran and quietly did less than the program said. A backend gap
        // has to surface at compile time, not as a missing side effect at runtime.
        throw new Error(`codegen-js: unhandled HIR statement kind '${(stmt as { kind: string }).kind}'`);
    }
  }

  private genStmts(body: HIRStmt[]) {
    for (const s of body) this.genStmt(s);
  }

  // Body of an already-open brace: indent, emit, close. Every block statement ends this
  // way, and hand-rolling it per arm is how an indent++ loses its indent--.
  private genBlockBody(body: HIRStmt[]) {
    this.indent++;
    this.genStmts(body);
    this.indent--;
    this.emit("}");
  }

  private genLet(stmt: HIRStmt & { kind: "Let" }) {
    // Initializer first, THEN the rename — see the note on `fnNames`.
    const val = this.genExpr(stmt.value);
    // `let _ = f()` discards the value; a second one in the same block redeclared `_`,
    // which is a SyntaxError at load. Nothing can read `_`, so evaluate and drop it.
    if (stmt.name === "_") return this.emit(`${val};`);
    const js = this.bindLocal(stmt.name);
    // ref-taken primitive local: box it so callees mutating `&mut name` write back.
    if (this.boxed.has(stmt.name)) return this.emit(`const ${js} = {v: ${val}};`);
    this.emit(`${stmt.mutable ? "let" : "const"} ${js} = ${val};`);
  }

  private genAssign(stmt: HIRStmt & { kind: "Assign" }) {
    // A direct `v[i] = x` needs the bounds check on the store side too, and a
    // checked store can't be an assignment target — hence the helper call.
    const t = stmt.target;
    if (t.kind === "IndexAccess" && t.object.type.tag !== "string" && t.object.type.tag !== "hashmap") {
      return this.emit(`__idxSet(${this.genExpr(t.object)}, ${this.genExpr(t.index)}, ${this.genExpr(stmt.value)});`);
    }
    const target = this.genLValue(stmt.target);
    this.emit(`${target} = ${this.genExpr(stmt.value)};`);
  }

  private genReturn(stmt: HIRStmt & { kind: "Return" }) {
    const value = stmt.value ? this.genExpr(stmt.value) : "undefined";
    // Inside a match-expression arm a plain `return` would only leave the IIFE
    // that arm lives in. Throw a sentinel the function boundary turns back into
    // a real return — the same trick `?` already uses.
    if (this.inMatchExprArm > 0) {
      this.usedMatchReturn = true;
      this.emit(`throw {__milo_ret: [${value}]};`);
    } else if (stmt.value) {
      this.emit(`return ${value};`);
    } else {
      this.emit("return;");
    }
  }

  private genIf(stmt: HIRStmt & { kind: "If" }) {
    this.emit(`if (${this.genExpr(stmt.cond)}) {`);
    this.indent++;
    this.genStmts(stmt.thenBody);
    this.indent--;
    if (stmt.elseBody && stmt.elseBody.length > 0) {
      this.emit("} else {");
      this.genBlockBody(stmt.elseBody);
      return;
    }
    this.emit("}");
  }

  private genWhile(stmt: HIRStmt & { kind: "While" }) {
    this.emit(`while (${this.genExpr(stmt.cond)}) {`);
    this.genBlockBody(stmt.body);
  }

  private genForRange(stmt: HIRStmt & { kind: "ForRange" }) {
    // Both bounds are evaluated once, before the loop, exactly as native does —
    // inlining `end` into the JS condition re-evaluates it every iteration, so a
    // body that mutates it (or merely calls something costly) diverges.
    const start = this.nextTemp();
    const end = this.nextTemp();
    this.emit(`const ${start} = ${this.genExpr(stmt.start)};`);
    this.emit(`const ${end} = ${this.genExpr(stmt.end)};`);
    this.emit(`for (let ${stmt.varName} = ${start}; ${stmt.varName} < ${end}; ${stmt.varName}++) {`);
    this.genBlockBody(stmt.body);
  }

  private genForEach(stmt: HIRStmt & { kind: "ForEach" }) {
    const iter = this.genExpr(stmt.iterable);
    if (stmt.iterableKind === "hashmap") {
      this.emit(`for (const [${stmt.varName}, ${stmt.varName2 ?? "_"}] of ${iter}) {`);
    } else if (stmt.iterableKind === "string") {
      // milo iterates a string by UTF-8 byte (u8); JS `of` yields code points.
      const sv = this.nextTemp();
      const ix = this.nextTemp();
      this.emit(`const ${sv} = ${iter};`);
      this.emit(`for (let ${ix} = 0; ${ix} < ${sv}.length; ${ix}++) {`);
      this.indent++;
      this.emit(`const ${stmt.varName} = ${sv}.charCodeAt(${ix});`);
      this.indent--;
      this.genBlockBody(stmt.body);
      return;
    } else if (stmt.varName2) {
      // `for i, x in v` over a Vec/array binds (index, value) — dropping the second
      // binding here emitted a loop whose body referenced an undeclared variable, so
      // the JS died at runtime instead of the backend refusing up front.
      this.emit(`for (const [${stmt.varName}, ${stmt.varName2}] of ${iter}.entries()) {`);
    } else {
      this.emit(`for (const ${stmt.varName} of ${iter}) {`);
    }
    this.genBlockBody(stmt.body);
  }

  private genForStrView(stmt: HIRStmt & { kind: "ForStrView" }) {
    // No views in JS — the pieces are substrings. Same sequence, same emptiness rules;
    // only the zero-copy part is lost, which JS strings cannot express anyway.
    const sv = this.nextTemp();
    const parts = this.nextTemp();
    this.emit(`const ${sv} = ${this.genExpr(stmt.src)};`);
    if (stmt.mode === "lines") {
      this.emit(`const ${parts} = ${sv}.length === 0 ? [] : ${sv}.replace(/\\n$/, "").split("\\n").map(l => l.endsWith("\\r") ? l.slice(0, -1) : l);`);
    } else {
      this.emit(`const ${parts} = ${sv}.split(${this.genExpr(stmt.sep!)});`);
    }
    if (stmt.varName2) this.emit(`for (const [${stmt.varName}, ${stmt.varName2}] of ${parts}.entries()) {`);
    else this.emit(`for (const ${stmt.varName} of ${parts}) {`);
    this.genBlockBody(stmt.body);
  }

  private genForIterator(stmt: HIRStmt & { kind: "ForIterator" }) {
    // User iterator protocol: call next(&mut it) until it answers None. The iterable is
    // bound once — next() mutates it in place, and JS objects are references, so an
    // lvalue iterable advances exactly as native's does.
    const it = this.nextTemp();
    const res = this.nextTemp();
    const noneTag = this.enumVariants.get(stmt.optionEnumName)?.find(v => v.name === "None")?.tag ?? 1;
    this.emit(`const ${it} = ${this.genExpr(stmt.iterable)};`);
    this.emit("for (;;) {");
    this.indent++;
    this.emit(`const ${res} = ${stmt.nextMethod}(${it});`);
    this.emit(`if (${res}.tag === ${noneTag}) break;`);
    this.emit(`const ${stmt.varName} = ${res}.data[0];`);
    this.indent--;
    this.genBlockBody(stmt.body);
  }

  // `resultVar` turns the arms into value producers: all but the tail statement run
  // as statements and the tail ExprStmt assigns into the variable, mirroring how
  // codegen.ts threads a result slot through the same generator.
  private genMatch(stmt: HIRStmt & { kind: "Match" }, resultVar?: string) {
    const subj = this.genExpr(stmt.subject);
    const tmp = this.nextTemp();
    this.emit(`const ${tmp} = ${subj};`);

    // determine if literal or enum match
    const isLiteral = stmt.arms.some(a => a.pattern.kind === "LiteralPattern");

    if (isLiteral) {
      let first = true;
      for (const arm of stmt.arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          this.emit(`${first ? "if (true" : "} else"} {`);
        } else if (arm.pattern.kind === "LiteralPattern") {
          const p = arm.pattern;
          let val: string;
          if (p.literalKind === "string") {
            val = jsByteString(String(p.value));
          } else if (p.literalKind === "char") {
            // char subject is a numeric byte (see CharLit) — compare numerically.
            // pattern.value is the byte as a decimal ("97"); fall back to charCodeAt
            // if it's an actual character.
            const n = typeof p.value === "number" ? p.value : Number(p.value);
            val = String(Number.isNaN(n) ? String(p.value).charCodeAt(0) : n);
          } else {
            val = String(p.value); // int/float/bool
          }
          this.emit(`${first ? "" : "} else "}if (${tmp} === ${val}) {`);
        }
        this.indent++;
        this.genMatchArmBody(arm.body, resultVar);
        this.indent--;
        first = false;
      }
      this.emit("}");
    } else {
      let first = true;
      for (const arm of stmt.arms) {
        if (arm.pattern.kind === "WildcardPattern") {
          this.emit(`${first ? "" : "} else "}{ // wildcard`);
        } else if (arm.pattern.kind === "EnumPattern") {
          const p = arm.pattern;
          this.emit(`${first ? "" : "} else "}if (${tmp}.tag === ${p.tag}) {`);
          this.indent++;
          for (let i = 0; i < p.bindings.length; i++) {
            const b = p.bindings[i]!;
            if (b.name === "_") continue;
            // Through a `&mut` subject a primitive payload binds as a box over its slot
            // (the checker types it `&mut T`, and reads/writes go through `.v`); an
            // object payload is mutated where it sits, so the value itself will do.
            if (stmt.subjectIsMut && this.needsBox(b.type)) {
              this.boxed.add(b.name);
              this.emit(`const ${b.name} = {get v() { return ${tmp}.data[${i}]; }, set v(_x) { ${tmp}.data[${i}] = _x; }};`);
              continue;
            }
            this.emit(`const ${b.name} = ${tmp}.data[${i}];`);
          }
          this.indent--;
        }
        this.indent++;
        this.genMatchArmBody(arm.body, resultVar);
        this.indent--;
        first = false;
      }
      this.emit("}");
    }
  }

  private genMatchArmBody(body: HIRStmt[], resultVar?: string) {
    if (!resultVar) {
      for (const s of body) this.genStmt(s);
      return;
    }
    for (let i = 0; i < body.length - 1; i++) this.genStmt(body[i]);
    const last = body[body.length - 1];
    if (!last) return;
    if (last.kind === "ExprStmt") {
      this.emit(`${resultVar} = ${this.genExpr(last.expr)};`);
    } else {
      // A diverging tail (return/break/continue) produces no value — it leaves the
      // enclosing function or loop, so the result variable is never read.
      this.genStmt(last);
    }
  }

  // A match used as a value. The arms become an IIFE assigning into one variable.
  // An arm that `return`s belongs to the ENCLOSING function, not the IIFE — the
  // `let x = match opt { Some(v) => v, None => { return err } }` shape is how std
  // unwraps, so it has to work — and inMatchExprArm makes those returns compile to
  // the sentinel throw genFunction unwinds. `break`/`continue` have no such escape
  // hatch, so an arm that leaves an outer loop is refused instead of mis-emitted.
  private genMatchExpr(expr: HIRExpr & { kind: "MatchExpr" }): string {
    for (const arm of expr.arms) {
      if (arm.body.some(breaksOuterLoop)) {
        throw new Error("codegen-js: match-expression arm breaks out of the enclosing loop");
      }
    }
    const result = this.nextTemp();
    const lines: string[] = [];
    const prevOutput = this.output;
    const prevIndent = this.indent;
    this.output = lines;
    this.indent = 1;
    this.inMatchExprArm++;
    this.emit(`let ${result};`);
    this.genMatch({ kind: "Match", subject: expr.subject, arms: expr.arms, enumName: expr.enumName, subjectIsRef: expr.subjectIsRef, span: expr.span }, result);
    this.emit(`return ${result};`);
    this.inMatchExprArm--;
    this.output = prevOutput;
    this.indent = prevIndent;
    return `(() => {\n${lines.join("\n")}\n${"  ".repeat(this.indent)}})()`;
  }

  private genExpr(expr: HIRExpr): string {
    switch (expr.kind) {
      case "IntLit":
      case "FloatLit":
        return String(expr.value);
      case "BoolLit":
        return expr.value ? "true" : "false";
      case "CharLit":
        // a char literal is a u8 byte value (65 for 'A'), not a 1-char string —
        // match/comparison is numeric; coerceToString converts back for display.
        return String(expr.value);
      case "StringLit":
        return jsByteString(expr.value);
      case "Ident":
        return this.boxed.has(expr.name) ? `${this.localRef(expr.name)}.v` : this.localRef(expr.name);
      case "BinOp":
        return this.genBinOp(expr);
      case "UnaryOp": {
        const v = this.genExpr(expr.operand);
        // -INT_MIN is the one negation that overflows, and native traps on it.
        if (expr.op === "-" && expr.type.tag === "int") {
          const [lo, hi] = this.intRange(expr.type);
          return this.currentFnWrapping ? this.maskInt(`(-${v})`, expr.type) : `__ovf((-${v}), ${lo}, ${hi})`;
        }
        // `&x` (from x.addrOf()) has no JS meaning — there are no addresses here. It
        // used to be spelled straight through, producing a file that failed to parse
        // at load; refuse it so the gap reads as "outside the subset", not "broken output".
        if (expr.op === "&") throw new Error("codegen-js: address-of (addrOf) unsupported — the JS backend has no pointers");
        return `(${expr.op}${v})`;
      }
      case "Call":
        return this.genCall(expr);
      case "StructLit":
        return this.genStructLit(expr);
      case "FieldAccess":
        return `${this.genExpr(expr.object)}.${expr.field}`;
      case "ArrayLit":
        return `[${expr.elements.map(e => this.genExpr(e)).join(", ")}]`;
      case "ArrayRepeat": {
        const val = this.genExpr(expr.value);
        return `Array.from({length: ${expr.count}}, () => __clone(${val}))`;
      }
      case "IndexAccess":
        // milo strings index by byte (u8); JS string[i] is a UTF-16 code unit, which
        // is only the same thing for ASCII — "hé"[1] is 233, not the 195 native reads.
        if (expr.object.type.tag === "string")
          return `__sbyte(${this.genExpr(expr.object)}, ${this.genExpr(expr.index)})`;
        // Bounds-checked: native aborts on an out-of-range index, JS would hand back
        // `undefined` and let it propagate as NaN through the rest of the program.
        if (expr.object.type.tag === "hashmap")
          return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
        return `__idx(${this.genExpr(expr.object)}, ${this.genExpr(expr.index)})`;
      case "EnumLit": {
        const args = expr.args.map(a => this.genExpr(a)).join(", ");
        return `${expr.enumName}.${expr.variant}(${args})`;
      }
      case "ArrayLen":
      case "VecLen":
        return `${this.genExpr(expr.object)}.length`;
      case "StringLen":
        // byte length — exact, because a Milo string is stored one byte per code unit.
        return `${this.genExpr(expr.object)}.length`;
      case "Unwrap":
        return `__unwrap(${this.genExpr(expr.operand)})`;
      case "Propagate": {
        // `?`: on Err/None (tag !== 0) throw a sentinel caught at the function
        // boundary (genFunction wraps propagating bodies), which returns the Err/None.
        this.usedPropagate = true;
        return `__propagate(${this.genExpr(expr.operand)})`;
      }
      case "DefaultValue": {
        // Bind the operand once — it may have side effects (e.g. a mutating
        // Vec.pop()); embedding it twice would evaluate it twice.
        const operand = this.genExpr(expr.operand);
        const def = this.genExpr(expr.default);
        const t = this.nextTemp();
        return `((${t}) => ${t}.tag === 0 ? ${t}.data[0] : ${def})(${operand})`;
      }
      case "VecSort": {
        // In place and ascending, like native. JS's default sort is lexicographic even
        // for numbers ([10,9] stays [10,9]), so the comparator is required, not a
        // nicety. Byte-strings compare the same way native's memcmp ordering does.
        const el = expr.elementType;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string") {
          throw new Error(`codegen-js: sort on ${el.tag} elements unsupported`);
        }
        return `${this.genExpr(expr.object)}.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)`;
      }
      case "VecMinMax": {
        const el = expr.elementType;
        if (el.tag !== "int" && el.tag !== "float" && el.tag !== "string") {
          throw new Error(`codegen-js: min/max on ${el.tag} elements unsupported`);
        }
        const v = this.nextTemp();
        const pick = expr.isMax ? "b > a ? b : a" : "b < a ? b : a";
        return `((${v}) => ${v}.length === 0 ? {tag: 1} : {tag: 0, data: [${v}.reduce((a, b) => ${pick})]})(${this.genExpr(expr.object)})`;
      }
      case "VecGetOpt": {
        const v = this.nextTemp();
        const i = this.nextTemp();
        return `((${v}, ${i}) => ${i} >= 0 && ${i} < ${v}.length ? {tag: 0, data: [${v}[${i}]]} : {tag: 1})(${this.genExpr(expr.object)}, ${this.genExpr(expr.index)})`;
      }
      case "MatchExpr":
        return this.genMatchExpr(expr);
      case "OptionOp":
        return this.genOptionOp(expr);
      case "Zeroed":
        return this.zeroValue(expr.zeroType);
      case "Cast":
        return this.genCast(expr);
      case "IsCheck":
        return `(${this.genExpr(expr.operand)}.tag === ${expr.tag})`;
      case "HeapCreate":
        return this.genExpr(expr.value);
      case "HeapDeref":
      case "PtrDeref":
        return this.genExpr(expr.operand);
      case "VecNew":
        return "[]";
      case "VecWithCapacity":
        // A capacity hint has no JS spelling; the argument is still evaluated for its
        // side effects and its value discarded, matching native's ordering.
        return `(${this.genExpr(expr.capacity)}, [])`;
      case "VecFilled": {
        // Vec.filled(n, x). Cloned per element like ArrayRepeat: the value is
        // evaluated once in Milo too, but each slot owns its own copy, so a
        // Vec.filled of a struct must not hand out n aliases of one object.
        const val = this.genExpr(expr.value);
        return `Array.from({length: ${this.genExpr(expr.count)}}, () => __clone(${val}))`;
      }
      case "VecPush":
        return `${this.genExpr(expr.vec)}.push(${this.genExpr(expr.value)})`;
      case "VecReserve":
        // A JS array grows itself; the operands are still evaluated for their effects.
        return `(() => { ${this.genExpr(expr.object)}; ${this.genExpr(expr.additional)}; })()`;
      case "VecPop":
        // pop(): Option<T> — Some(last)/None. Bind the array once so the length
        // check and the mutating .pop() hit the same reference.
        return `((_v) => _v.length > 0 ? ${expr.optionEnumName}.Some(_v.pop()) : ${expr.optionEnumName}.None())(${this.genExpr(expr.vec)})`;
      case "MemReplace": {
        // replace(place, v): store v, hand back the old contents. The new value is
        // evaluated first, through the IIFE parameter, so it cannot observe the
        // half-updated place.
        const place = this.genPlaceAccess(expr.place);
        return `((_n) => { const _o = ${place.read}; ${place.write("_n")}; return _o; })(${this.genExpr(expr.value)})`;
      }
      case "Forget": {
        // JS is garbage collected, so there is no drop to suppress — `forget` is only
        // ever a no-op here. The operand is still evaluated for its side effects, which
        // is the whole of its observable behaviour on this target.
        return `(() => { ${this.genExpr(expr.value)}; })()`;
      }
      case "MemSwap": {
        // swap(a, b): exchange two places, yielding nothing.
        const a = this.genPlaceAccess(expr.a);
        const b = this.genPlaceAccess(expr.b);
        return `(() => { const _t = ${a.read}; ${a.write(b.read)}; ${b.write("_t")}; })()`;
      }
      case "VecClone":
        return `__clone(${this.genExpr(expr.object)})`;
      case "VecReverse":
        return `${this.genExpr(expr.object)}.reverse()`;
      case "VecSwap": {
        const v = this.genExpr(expr.object);
        const a = this.genExpr(expr.indexA);
        const b = this.genExpr(expr.indexB);
        return `((_v, _a, _b) => { const _t = _v[_a]; _v[_a] = _v[_b]; _v[_b] = _t; })(${v}, ${a}, ${b})`;
      }
      case "VecInsert":
        // Vec.insert(i, x): shift right — JS splice inserts at i, no removal.
        return `${this.genExpr(expr.object)}.splice(${this.genExpr(expr.index)}, 0, ${this.genExpr(expr.value)})`;
      case "VecRemove":
        // Vec.remove(i): returns the removed element (splice yields an array).
        return `${this.genExpr(expr.object)}.splice(${this.genExpr(expr.index)}, 1)[0]`;
      case "HashMapNew":
        return "new Map()";
      case "HashMapInsert":
        return `${this.genExpr(expr.map)}.set(${this.genExpr(expr.key)}, ${this.genExpr(expr.value)})`;
      case "HashMapGet": {
        const m = this.genExpr(expr.map);
        const k = this.genExpr(expr.key);
        return `(${m}.has(${k}) ? ${expr.optionEnumName}.Some(${m}.get(${k})) : ${expr.optionEnumName}.None())`;
      }
      case "HashMapGetOrDefault": {
        const m = this.genExpr(expr.map);
        const k = this.genExpr(expr.key);
        return `(${m}.has(${k}) ? ${m}.get(${k}) : ${this.genExpr(expr.default)})`;
      }
      case "HashMapModify": {
        // A primitive value reaches the callback as a `&mut` box (see genArg) that reads
        // and writes the entry; an array, Map or object is mutated where it sits.
        const m = this.genExpr(expr.map), k = this.genExpr(expr.key), f = this.genExpr(expr.callback);
        const vt = expr.map.type.tag === "hashmap" ? expr.map.type.value : undefined;
        const arg = this.needsBox(vt) ? `{get v() { return _m.get(_k); }, set v(_x) { _m.set(_k, _x); }}` : `_m.get(_k)`;
        return `((_m, _k) => _m.has(_k) ? (${f}(${arg}), true) : false)(${m}, ${k})`;
      }
      case "HashMapGetOrInsertWith": {
        const m = this.genExpr(expr.map), k = this.genExpr(expr.key), f = this.genExpr(expr.init);
        return `((_m, _k) => _m.has(_k) ? false : (_m.set(_k, ${f}()), true))(${m}, ${k})`;
      }
      case "HashMapContains":
        return `${this.genExpr(expr.map)}.has(${this.genExpr(expr.key)})`;
      case "HashMapRemove":
        return `${this.genExpr(expr.map)}.delete(${this.genExpr(expr.key)})`;
      case "HashMapLen":
        return `${this.genExpr(expr.object)}.size`;
      case "HashMapWithCapacity":
        // capacity is a native allocation hint; a JS Map needs none.
        return `new Map()`;
      case "HashMapClone":
        return `__clone(${this.genExpr(expr.object)})`;
      case "HashMapClear":
        return `${this.genExpr(expr.object)}.clear()`;
      case "HashMapEntries":
        return `Array.from(${this.genExpr(expr.object)}.${expr.field === "key" ? "keys" : "values"}(), __clone)`;
      case "StringPush":
        // Known gap: correct for ASCII only. Milo pushes one UTF-8 byte, but a JS
        // string can't hold a partial code point, so pushing the two bytes of a
        // multi-byte character yields two Latin-1 chars instead. Fixing it properly
        // needs Milo strings represented as byte arrays in JS, not JS strings.
        return `(${this.genExpr(expr.str)} += String.fromCharCode(${this.genExpr(expr.byte)}))`;
      case "StringPushStr":
        // Both operands are already in the backend's byte-string form, so this is
        // plain concatenation — none of StringPush's per-byte reinterpretation
        // applies, and unlike that case it is correct for non-ASCII too.
        return `(${this.genExpr(expr.str)} += ${this.genExpr(expr.other)})`;
      case "StringSubstr":
      case "StringSlice":
        // Byte offsets — see the byte-string note in the runtime.
        return `${this.genExpr(expr.str)}.slice(${this.genExpr(expr.start)}, ${this.genExpr(expr.end)})`;
      case "StringClone":
        return this.genExpr(expr.str);
      case "StringWithCapacity":
        // capacity is a native allocation hint; JS strings need none.
        return `""`;
      case "NumberToString":
        // Floats take __fmtG, not String(): both are shortest-round-trip, but
        // they disagree on presentation (JS says "1e-7", C's %g "1e-07"), and
        // the native backend is the reference.
        return expr.value.type.tag === "float"
          ? `__fmtG(${this.genExpr(expr.value)})`
          : `String(${this.genExpr(expr.value)})`;
      case "BoolToString":
        // "true" / "false" — the same two words the native backend prints, and
        // not JS's String(true) by accident: this has to keep agreeing with it.
        return `(${this.genExpr(expr.value)} ? "true" : "false")`;
      case "JsonStringify":
        return `JSON.stringify(${this.genExpr(expr.value)})`;
      case "Closure":
        return this.genClosure(expr);
      case "ClosureCall": {
        const callee = this.genExpr(expr.callee);
        const args = expr.args.map(a => this.genArg(a)).join(", ");
        return `${callee}(${args})`;
      }
      case "VecMap":
        return `${this.genExpr(expr.vec)}.map(${this.genExpr(expr.callback)})`;
      case "VecFilter":
        return `${this.genExpr(expr.vec)}.filter(${this.genExpr(expr.callback)})`;
      case "VecEach":
        return `${this.genExpr(expr.vec)}.forEach(${this.genExpr(expr.callback)})`;
      case "VecFind": {
        const v = this.genExpr(expr.vec);
        const cb = this.genExpr(expr.callback);
        return `((_f => { const _r = ${v}.find(_f); return _r !== undefined ? ${expr.optionEnumName}.Some(_r) : ${expr.optionEnumName}.None(); })(${cb}))`;
      }
      case "VecAny":
        return `${this.genExpr(expr.vec)}.some(${this.genExpr(expr.callback)})`;
      case "VecAll":
        return `${this.genExpr(expr.vec)}.every(${this.genExpr(expr.callback)})`;
      case "VecFold":
        // JS reduce takes (acc, elem) in the same order, so the Milo callback maps
        // over directly; the explicit initial value keeps the empty-Vec case total.
        return `${this.genExpr(expr.vec)}.reduce(${this.genExpr(expr.callback)}, ${this.genExpr(expr.init)})`;
      case "InterfaceCoerce":
        // JS is duck-typed: an interface value is just the concrete instance. Dispatch
        // later reads its constructor.name, so no boxing needed.
        return this.genExpr(expr.value);
      case "InterfaceMethodCall": {
        // dispatch via the concrete type's itable slot; pass the object as `self`.
        const obj = this.genExpr(expr.object);
        const args = expr.args.map(a => this.genArg(a));
        const iface = JSON.stringify(expr.ifaceName);
        const rest = args.length > 0 ? ", " + args.join(", ") : "";
        return `(__o => __itable[__o.constructor.name + ":" + ${iface}][${expr.methodIndex}](__o${rest}))(${obj})`;
      }
      case "IfExpr": {
        // JS has no block-valued if — emit an IIFE whose branches return their
        // trailing expression (the block's value).
        const lines: string[] = [];
        const prev = this.output;
        this.output = lines;
        this.emit(`if (${this.genExpr(expr.cond)}) {`);
        this.indent++;
        this.emitBlockReturn(expr.thenBody);
        this.indent--;
        this.emit("} else {");
        this.indent++;
        this.emitBlockReturn(expr.elseBody);
        this.indent--;
        this.emit("}");
        this.output = prev;
        return `(() => {\n${lines.join("\n")}\n${"  ".repeat(this.indent)}})()`;
      }
      case "WrappingArith": {
        // Fixed-width wrapping add/sub/mul (x.wrappingAdd(y) etc). Mask the raw
        // result to the type width, matching native two's-complement wraparound.
        const jsOp = ({ add: "+", sub: "-", mul: "*" } as Record<string, string>)[expr.op];
        return this.maskInt(`(${this.genExpr(expr.left)} ${jsOp} ${this.genExpr(expr.right)})`, expr.type);
      }
      case "SaturatingArith": {
        // Clamp to the type's representable range instead of wrapping.
        const jsOp = ({ add: "+", sub: "-", mul: "*" } as Record<string, string>)[expr.op];
        const [lo, hi] = this.intRange(expr.type);
        const v = `(${this.genExpr(expr.left)} ${jsOp} ${this.genExpr(expr.right)})`;
        return `(__v => __v < ${lo} ? ${lo} : (__v > ${hi} ? ${hi} : __v))(${v})`;
      }
      case "CheckedArith": {
        // Some(masked) when the true result fits the type, else None. Option is
        // represented as {tag:0,data:[x]} (Some) / {tag:1} (None) — see genEnum.
        const jsOp = ({ add: "+", sub: "-", mul: "*", div: "/", rem: "%" } as Record<string, string>)[expr.op];
        const [lo, hi] = this.intRange(expr.type);
        const raw = expr.op === "div" || expr.op === "rem"
          ? `Math.trunc(${this.genExpr(expr.left)} ${jsOp} ${this.genExpr(expr.right)})`
          : `(${this.genExpr(expr.left)} ${jsOp} ${this.genExpr(expr.right)})`;
        const masked = this.maskInt("__v", expr.type);
        return `(__v => (__v < ${lo} || __v > ${hi}) ? {tag:1} : {tag:0, data:[${masked}]})(${raw})`;
      }
      case "BitIntrinsic":
        return this.genBitIntrinsic(expr);
      case "StringCstr":
        // A null-terminated C string only means something at an FFI boundary, which
        // doesn't exist in JS; a Milo string is already a JS string, so pass it through.
        return this.genExpr(expr.object);
    }
    // No silent fallthrough: an unhandled kind used to interpolate `undefined`
    // into the output (e.g. `x = undefined`), producing code that ran but computed
    // garbage. Fail loudly so backend gaps surface at compile time, not at runtime.
    throw new Error(`codegen-js: unhandled HIR expression kind '${(expr as any).kind}'`);
  }

  // Inclusive [min, max] JS numeric literals for an integer type. 64-bit uses the
  // f64 safe-integer range (exact 2^63 wrap is unrepresentable in JS numbers).
  private intRange(ty: any): [string, string] {
    if (!ty || ty.tag !== "int") return ["-Infinity", "Infinity"];
    if (ty.bits >= 64) return ty.signed ? ["-9223372036854775808", "9223372036854775807"] : ["0", "18446744073709551615"];
    if (ty.signed) { const h = 2 ** (ty.bits - 1); return [String(-h), String(h - 1)]; }
    return ["0", String(2 ** ty.bits - 1)];
  }

  private genBitIntrinsic(expr: HIRExpr & { kind: "BitIntrinsic" }): string {
    const v = this.genExpr(expr.value);
    const bits = expr.type.tag === "int" ? expr.type.bits : 32;
    switch (expr.intrinsic) {
      case "ctpop": // popcount
        return `(__x => { let __c = 0; let __n = ${this.maskInt("__x", expr.type)}; while (__n) { __c += __n & 1; __n = Math.floor(__n / 2); } return __c; })(${v})`;
      case "ctlz": // leading zeros within the type width
        return `(__x => { let __n = ${this.maskInt("__x", expr.type)}; let __c = ${bits}; while (__n) { __c--; __n = Math.floor(__n / 2); } return __c; })(${v})`;
      case "cttz": // trailing zeros within the type width
        return `(__x => { let __n = ${this.maskInt("__x", expr.type)}; if (__n === 0) return ${bits}; let __c = 0; while ((__n & 1) === 0) { __c++; __n = Math.floor(__n / 2); } return __c; })(${v})`;
      case "fshl": // rotate left by amount (mod width)
      case "fshr": {
        if (bits > 32) throw new Error("codegen-js: rotate on >32-bit ints unsupported");
        const amt = expr.amount ? this.genExpr(expr.amount) : "0";
        // Normalize to a left-rotation amount in [0, bits).
        const leftAmt = expr.intrinsic === "fshl" ? `__s` : `(${bits} - __s)`;
        return `(__x => { const __m = ${this.maskInt("__x", expr.type)}; const __s = ((${amt}) % ${bits} + ${bits}) % ${bits}; const __l = ${leftAmt} % ${bits}; return ${this.maskInt(`((__m << __l) | (__m >>> (${bits} - __l)))`, expr.type)}; })(${v})`;
      }
      default:
        throw new Error(`codegen-js: unhandled bit intrinsic '${expr.intrinsic}'`);
    }
  }

  // Emit a block's statements, turning its trailing expression-statement into a
  // `return` so the enclosing IIFE yields the block value.
  private emitBlockReturn(body: HIRStmt[]) {
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      if (i === body.length - 1 && s.kind === "ExprStmt") {
        this.emit(`return ${this.genExpr(s.expr)};`);
      } else {
        this.genStmt(s);
      }
    }
  }

  private genBinOp(expr: HIRExpr & { kind: "BinOp" }): string {
    const l = this.genExpr(expr.left);
    const r = this.genExpr(expr.right);

    // string concatenation
    if (expr.op === "+" && expr.left.type.tag === "string") {
      return `(${l} + ${r})`;
    }

    // structural equality for structs/enums
    if (expr.op === "==" && (expr.left.type.tag === "struct" || expr.left.type.tag === "enum")) {
      return `__eq(${l}, ${r})`;
    }
    if (expr.op === "!=" && (expr.left.type.tag === "struct" || expr.left.type.tag === "enum")) {
      return `!__eq(${l}, ${r})`;
    }

    // string comparison
    if ((expr.op === "==" || expr.op === "!=") && expr.left.type.tag === "string") {
      return `(${l} ${expr.op} ${r})`;
    }

    // Integer ops must match native Milo's fixed-width two's-complement semantics,
    // which JS f64/int32 math does not give for free — and, outside a `@wrapping`
    // function, must trap on overflow rather than wrap. Silently wrapping where the
    // binary aborts is the divergence that matters most: the JS build keeps running
    // with a value the native build declared impossible.
    if (expr.type.tag === "int") {
      const op = expr.op;
      const bits = expr.type.bits;
      const [lo, hi] = this.intRange(expr.type);
      // JS bitwise operators coerce operands to SIGNED int32. For <=32-bit types
      // maskInt then yields the correct (positive) value; but i64/u64 — used by
      // 32-bit CPU cores to hold masked 32-bit registers — need explicit
      // normalization so a bit31-set value like 0xFFFFFFFF isn't seen as -1.
      if (op === "&" || op === "|" || op === "^") {
        // JS bitwise ops coerce to int32, so a 64-bit operand above 2^32 lost its high
        // word: `(docId << 32) | idx` came back as `idx`. Work the halves separately.
        if (bits >= 64) return `__b64(${l}, ${r}, "${op}")`;
        return this.maskInt(`(${l} ${op} ${r})`, expr.type);
      }
      if (op === "<<" || op === ">>") {
        // Native traps on a shift amount >= the type width; `@wrapping` masks it
        // into range instead. JS would do neither: `<<` silently takes `amount & 31`.
        const amt = this.currentFnWrapping ? `((${r}) % ${bits})` : `__sh(${r}, ${bits})`;
        if (op === "<<") {
          // Multiply, don't `<<`, above 32 bits: JS's shift coerces to int32, so
          // `1 << 40` on an i64 yields 256 instead of a trillion.
          const raw = bits >= 64 ? `Math.trunc(${l} * 2 ** (${amt}))` : `(${l} << ${amt})`;
          return bits >= 64 ? raw : this.maskInt(raw, expr.type);
        }
        // Divide-based shift is correct for any magnitude (JS `>>` would coerce to
        // int32 and sign-corrupt 32-bit values) and matches native arithmetic shift
        // for negatives (Math.floor rounds toward -inf).
        const raw = `Math.floor(${l} / 2 ** (${amt}))`;
        return bits >= 64 ? raw : this.maskInt(raw, expr.type);
      }
      if (op === "+" || op === "-" || op === "*") {
        const raw = `(${l} ${op} ${r})`;
        return this.currentFnWrapping ? this.maskInt(raw, expr.type) : `__ovf(${raw}, ${lo}, ${hi})`;
      }
      // Division by zero traps in a `@wrapping` function too — there is no modular
      // answer to give. Only the INT_MIN/-1 overflow is wrapped there.
      if (op === "/") {
        const raw = `__idiv(${l}, ${r})`;
        return this.currentFnWrapping ? this.maskInt(raw, expr.type) : `__ovf(${raw}, ${lo}, ${hi})`;
      }
      if (op === "%") return `__irem(${l}, ${r})`;
    }

    return `(${l} ${expr.op} ${r})`;
  }

  // Wrap an integer value to a fixed-width two's-complement representation, matching
  // native Milo. 8/16/32-bit are exact; 64-bit is best-effort (JS f64 can't wrap at
  // 2^64, but the emulators' 64-bit values stay well under 2^53).
  private maskInt(val: string, ty: any): string {
    if (!ty || ty.tag !== "int") return val;
    if (ty.signed) {
      if (ty.bits === 8) return `((${val} << 24) >> 24)`;
      if (ty.bits === 16) return `((${val} << 16) >> 16)`;
      if (ty.bits === 32) return `(${val} | 0)`;
      return `Math.trunc(${val})`;
    }
    if (ty.bits === 8) return `(${val} & 0xFF)`;
    if (ty.bits === 16) return `(${val} & 0xFFFF)`;
    if (ty.bits === 32) return `(${val} >>> 0)`;
    return `Math.trunc(${val})`;
  }

  // A by-ref arg that is a boxed primitive ident passes the BOX itself (so the callee
  // shares mutations); everything else evaluates normally (objects are already refs).
  private genArg(a: HIRArg): string {
    if (a.refMut && a.expr.kind === "Ident" && this.boxed.has(a.expr.name)) return a.expr.name;
    // `f(&mut self.pos)`, `f(&mut v[i])`: the callee reads and writes its parameter as a
    // box (`p.v`), so a primitive place that is not a local gets an accessor box over the
    // place, evaluated once. Passing the field's value handed the callee a fresh number
    // and dropped every write (std/json's string scanner lost its cursor this way).
    if (a.refMut && this.needsBox(a.expr.type)) {
      if (a.expr.kind === "FieldAccess") {
        return `((_o) => ({get v() { return _o.${a.expr.field}; }, set v(_x) { _o.${a.expr.field} = _x; }}))(${this.genExpr(a.expr.object)})`;
      }
      if (a.expr.kind === "IndexAccess" && a.expr.object.type.tag !== "string" && a.expr.object.type.tag !== "hashmap") {
        return `((_o, _i) => ({get v() { return __idx(_o, _i); }, set v(_x) { __idxSet(_o, _i, _x); }}))(${this.genExpr(a.expr.object)}, ${this.genExpr(a.expr.index)})`;
      }
    }
    return this.genExpr(a.expr);
  }

  // `_atomicAddI64((g.addrOf()) as *u8, n)` and its siblings, on a place. The native
  // backend needs the address for a real atomic; this one runs on a single thread and
  // has no addresses, so the place itself is the operand and the op is plain
  // arithmetic. Without this every program importing std/json or std/seal (both mint
  // a brand from such a counter) fell outside the JS subset.
  private genAtomicOnPlace(expr: HIRExpr & { kind: "Call" }): string | null {
    const m = /^_atomic(Add|Sub|Load|Store)(I64|I32)$/.exec(expr.func);
    if (!m) return null;
    let addr = expr.args[0]?.expr;
    while (addr && addr.kind === "Cast") addr = addr.operand;
    if (!addr || addr.kind !== "UnaryOp" || addr.op !== "&") return null;
    const place = addr.operand;
    if (place.kind !== "Ident" && place.kind !== "FieldAccess") return null;
    const p = this.genExpr(place);
    switch (m[1]) {
      case "Load": return `(${p})`;
      case "Store": return `(${p} = ${this.genArg(expr.args[1])})`;
      case "Add": { const n = this.genArg(expr.args[1]); return `((${p} += ${n}) - ${n})`; }
      default: { const n = this.genArg(expr.args[1]); return `((${p} -= ${n}) + ${n})`; }
    }
  }

  private genCall(expr: HIRExpr & { kind: "Call" }): string {
    const atomic = this.genAtomicOnPlace(expr);
    if (atomic !== null) return atomic;
    const args = expr.args.map(a => this.genArg(a));

    switch (expr.func) {
      case "print": {
        const parts = expr.args.map(a => this.coerceToString(a.expr));
        return `__print(${parts.join(" + ")} + "\\n")`;
      }
      case "eprint": {
        // stderr, not stdout — else it pollutes captured program output.
        const parts = expr.args.map(a => this.coerceToString(a.expr));
        return `__eprint(${parts.join(" + ")})`;
      }
      case "format": {
        const parts = expr.args.map(a => this.coerceToString(a.expr));
        return parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
      }
      case "flush":
        return "__flush()";
      // std/string's strParseF64 hands the decimal→binary conversion to libc; the JS
      // backend has no FFI, so the one libc name the prelude reaches for gets a shim.
      // The string is already validated by then, so parseFloat's leniency never shows.
      case "atof":
        return `parseFloat(${args[0]})`;
      case "exit":
        return `(() => { throw new Error("exit: " + ${args[0]}); })()`;
      case "assert":
        return `__assert(${args[0]}, ${args[1] ?? '""'})`;
      case "todo":
        return `__trap("todo: not implemented" + (${args[0] ?? '""'} ? ": " + ${args[0] ?? '""'} : ""))`;
      case "max":
        return `Math.max(${args.join(", ")})`;
      case "min":
        return `Math.min(${args.join(", ")})`;
      case "sqrt":
        return `Math.sqrt(${args[0]})`;
      case "abs":
        return `Math.abs(${args[0]})`;
      case "floor":
        return `Math.floor(${args[0]})`;
      case "ceil":
        return `Math.ceil(${args[0]})`;
      case "round":
        return `Math.round(${args[0]})`;
      case "pow":
        return `Math.pow(${args[0]}, ${args[1]})`;
      case "log":
        return `Math.log(${args[0]})`;
      case "sin":
        return `Math.sin(${args[0]})`;
      case "cos":
        return `Math.cos(${args[0]})`;
      case "strToUpper":
        return `${args[0]}.toUpperCase()`;
      case "strToLower":
        return `${args[0]}.toLowerCase()`;
      default:
        return `${expr.func}(${args.join(", ")})`;
    }
  }

  private genStructLit(expr: HIRExpr & { kind: "StructLit" }): string {
    const args = expr.fields.map(f => this.genExpr(f.value)).join(", ");
    return `new ${expr.name}(${args})`;
  }

  private genCast(expr: HIRExpr & { kind: "Cast" }): string {
    const val = this.genExpr(expr.operand);
    const target = expr.targetType;
    // Mask to the target width so `x as u8` wraps to 0..255 (native semantics),
    // not the 32-bit-signed truncation a bare `| 0` would give.
    if (target.tag === "int") return this.maskInt(val, target);
    // JS has one float type. `x as f32` is not a no-op in Milo — it rounds to
    // single precision, and native code that stores an f32 and reads it back
    // sees the rounded value. Without fround the two backends drift apart the
    // moment an f32 is compared against anything, which is exactly what a depth
    // buffer does every pixel.
    if (target.tag === "float") return target.bits === 32 ? `Math.fround(${val})` : `(+${val})`;
    if (target.tag === "bool") return `Boolean(${val})`;
    return val;
  }

  // `zeroed<T>()` — the JS analogue of LLVM's zeroinitializer: every scalar 0/false,
  // every field and element recursively zeroed. Pointers have no JS representation,
  // so a zeroed one is null, matching how the backend models them elsewhere.
  private zeroValue(t: TypeKind): string {
    switch (t.tag) {
      case "int": case "float": return "0";
      case "bool": return "false";
      case "string": return `""`;
      case "vec": return "[]";
      case "hashmap": return "new Map()";
      case "array": {
        // A fresh element per slot: `.fill(obj)` would alias one struct across the array.
        const n = t.size ?? 0;
        return `Array.from({length: ${n}}, () => ${this.zeroValue(t.element)})`;
      }
      case "struct": {
        const fields = this.structFields.get(t.name);
        if (!fields) return "null";
        return `new ${t.name}(${fields.map(f => this.zeroValue(f.type)).join(", ")})`;
      }
      case "enum": {
        // Tag 0 with a zeroed payload — the same bits zeroinitializer produces.
        // Option/Result aren't in module.enums; both have a 1-field variant at tag 0.
        const variants = this.enumVariants.get(t.name);
        const v0 = variants?.find(v => v.tag === 0);
        if (!v0) return `{tag: 0, data: [0]}`;
        if (v0.fields.length === 0) return `{tag: 0}`;
        return `{tag: 0, data: [${v0.fields.map(f => this.zeroValue(f)).join(", ")}]}`;
      }
      default: return "null";
    }
  }

  // Option/Result combinators. Both enums are {tag, data} with the "success"
  // variant (Some/Ok) at tag 0, so the same tag test serves isSome and isOk.
  // The operand is bound to a temp because it may have side effects, and the
  // default/closure slot stays inside the arrow so it is only evaluated on the
  // branch that needs it — `x.unwrapOr(expensive())` must not call expensive()
  // when x is Some.
  private genOptionOp(expr: HIRExpr & { kind: "OptionOp" }): string {
    const t = this.nextTemp();
    const value = this.genExpr(expr.value);
    const wrap = (body: string) => `((${t}) => ${body})(${value})`;
    if (expr.op === "isSome") return wrap(`${t}.tag === 0`);
    if (expr.op === "isNone") return wrap(`${t}.tag !== 0`);
    const arg = expr.default ? this.genExpr(expr.default) : "undefined";
    switch (expr.op) {
      case "unwrapOr":     return wrap(`${t}.tag === 0 ? ${t}.data[0] : ${arg}`);
      case "unwrapOrElse": return wrap(`${t}.tag === 0 ? ${t}.data[0] : (${arg})()`);
      // Result's unwrapOrElse is handed the error; Option's failure carries nothing.
      case "resultUnwrapOrElse": return wrap(`${t}.tag === 0 ? ${t}.data[0] : (${arg})(${t}.data[0])`);
      // Option.map/andThen drop to a payload-less None; the Result combinators carry the
      // untouched side's payload through, so they return the operand itself.
      case "map":          return wrap(`${t}.tag === 0 ? {tag: 0, data: [(${arg})(${t}.data[0])]} : {tag: 1}`);
      case "optionAndThen":return wrap(`${t}.tag === 0 ? (${arg})(${t}.data[0]) : {tag: 1}`);
      case "optionOrElse": return wrap(`${t}.tag === 0 ? ${t} : (${arg})()`);
      case "resultMap":    return wrap(`${t}.tag === 0 ? {tag: 0, data: [(${arg})(${t}.data[0])]} : ${t}`);
      case "resultMapErr": return wrap(`${t}.tag === 0 ? ${t} : {tag: 1, data: [(${arg})(${t}.data[0])]}`);
      case "resultAndThen":return wrap(`${t}.tag === 0 ? (${arg})(${t}.data[0]) : ${t}`);
      case "resultOrElse": return wrap(`${t}.tag === 0 ? ${t} : (${arg})(${t}.data[0])`);
    }
    throw new Error(`codegen-js: unhandled OptionOp '${expr.op}'`);
  }

  private genClosure(expr: HIRExpr & { kind: "Closure" }): string {
    const params = expr.params.map(p => p.name).join(", ");
    // A `&mut` primitive parameter arrives as a box, exactly as it does for a fn
    // (genFunction): `(v: &mut string) => v.pushStr("!")` wrote to a copy otherwise.
    // The enclosing function's boxes stay visible, since captures read them.
    const prevBoxed = this.boxed;
    this.boxed = new Set(prevBoxed);
    for (const p of expr.params) {
      if (p.type.tag === "ref" && p.type.mutable && this.needsBox(p.type.inner)) this.boxed.add(p.name);
    }
    this.collectRefTaken(expr.body, this.boxed);
    try {
      return this.genClosureBody(expr, params);
    } finally {
      this.boxed = prevBoxed;
    }
  }

  private genClosureBody(expr: HIRExpr & { kind: "Closure" }, params: string): string {
    if (expr.body.length === 1 && expr.body[0].kind === "Return" && expr.body[0].value) {
      const ret = this.genExpr(expr.body[0].value);
      return `((${params}) => ${ret})`;
    }
    const lines: string[] = [];
    const prevOutput = this.output;
    this.output = lines;
    // A `return` in the closure body leaves the CLOSURE, so it must not be turned
    // into the enclosing function's sentinel throw even when this closure is being
    // generated inside a match-expression arm.
    const prevArmDepth = this.inMatchExprArm;
    const prevMatchReturn = this.usedMatchReturn;
    this.inMatchExprArm = 0;
    this.usedMatchReturn = false;
    for (const s of expr.body) this.genStmt(s);
    if (this.usedMatchReturn) {
      // Would need its own catch wrapper around the arrow body; nothing emits one.
      throw new Error("codegen-js: closure with a returning match-expression arm unsupported");
    }
    this.inMatchExprArm = prevArmDepth;
    this.usedMatchReturn = prevMatchReturn;
    this.output = prevOutput;
    return `((${params}) => {\n${lines.join("\n")}\n${"  ".repeat(this.indent)}})`;
  }

  private coerceToString(expr: HIRExpr): string {
    const val = this.genExpr(expr);
    if (expr.type.tag === "string") return val;
    if (expr.type.tag === "bool") return `(${val} ? "true" : "false")`;
    if (expr.type.tag === "float") return `__fmtG(${val})`;
    if (expr.type.tag === "int") return `String(${val})`;
    if (expr.type.tag === "struct") return `__displayStruct(${val})`;
    // Containers render structurally, matching the native backend — the default JS
    // stringification would give "1,2,3" for a Vec and "[object Map]" for a HashMap.
    if (expr.type.tag === "vec" || expr.type.tag === "array") return `__displaySeq(${val})`;
    if (expr.type.tag === "hashmap") return `__displayMap(${val})`;
    if (expr.type.tag === "enum") return `__displayEnum(${val}, ${JSON.stringify(expr.type.name)})`;
    return `String(${val})`;
  }

  // A place as a read expression plus a write builder. `replace`/`swap` need both
  // halves, and an indexed place cannot supply them from one string: the checked
  // store is `__idxSet(...)`, a call, which is not an assignment target. The object
  // and index texts are emitted more than once, so a subscript with side effects
  // would be evaluated more than once.
  private genPlaceAccess(expr: HIRExpr): { read: string; write: (v: string) => string } {
    if (expr.kind === "IndexAccess" && expr.object.type.tag !== "string" && expr.object.type.tag !== "hashmap") {
      const obj = this.genExpr(expr.object);
      const idx = this.genExpr(expr.index);
      return { read: `__idx(${obj}, ${idx})`, write: v => `__idxSet(${obj}, ${idx}, ${v})` };
    }
    const lv = this.genLValue(expr);
    return { read: lv, write: v => `${lv} = ${v}` };
  }

  private genLValue(expr: HIRExpr): string {
    switch (expr.kind) {
      case "Ident":
        return this.boxed.has(expr.name) ? `${this.localRef(expr.name)}.v` : this.localRef(expr.name);
      case "FieldAccess":
        return `${this.genLValue(expr.object)}.${expr.field}`;
      case "IndexAccess":
        // `v[i].field = x` works through this: __idx yields the element object and
        // the field store lands on it. A bare `v[i] = x` is handled in Assign.
        if (expr.object.type.tag === "hashmap")
          return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
        return `__idx(${this.genExpr(expr.object)}, ${this.genExpr(expr.index)})`;
      // A Heap box has no separate identity in JS — the box IS the value — so storing
      // through `*box` is a store to the binding itself.
      case "HeapDeref":
        return this.genLValue(expr.operand);
      // A raw pointer does. Falling through to the operand emitted `vp = 11` for
      // `*vp = 11`: a store to the pointer VARIABLE, which throws when the binding is
      // const and silently loses the write when it isn't. Refuse it the same way
      // addrOf is refused — this backend has no addresses, and a wrong answer is worse
      // than a named limit.
      case "PtrDeref":
        throw new Error("codegen-js: store through a raw pointer (*p = v) unsupported — the JS backend has no pointers");
      default:
        return this.genExpr(expr);
    }
  }
}
