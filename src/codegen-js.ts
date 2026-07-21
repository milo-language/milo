// JS codegen backend — HIR → JavaScript for browser playground
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern } from "./hir";
import type { TypeKind } from "./types";

export class CodegenJS {
  private output: string[] = [];
  private indent = 0;
  private tempCounter = 0;
  private usedPropagate = false;
  // Names boxed as `{v: …}` in the current function: JS-immutable values (numbers,
  // strings, bools) that are taken by `&mut`/`&` must share mutations across the call,
  // which JS by-value passing can't do. Ref params + ref-taken locals become boxes.
  private boxed: Set<string> = new Set();

  // When true, emit requires/ensures as runtime checks (like a native `--debug`
  // build). Off by default so `milo emit-js` output — e.g. the browser emulators —
  // carries no contract overhead; the playground opts in.
  constructor(private emitContracts = false) {}

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
      this.genStruct(s);
    }

    // enums as tagged objects
    for (const e of module.enums) {
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

    // entry point
    this.emit("main();");
    this.emit("__flush();");
  }

  private emitRuntime() {
    this.emit("// runtime");
    this.emit("const __out = [];");
    this.emit("function __print(s) { __out.push(String(s)); }");
    this.emit("function __flush() { if (__out.length === 0) return; const text = __out.join(''); __out.length = 0; if (typeof process !== 'undefined') process.stdout.write(text); else if (typeof console !== 'undefined') console.log(text); }");
    this.emit("function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }");
    // C printf %g: 6 significant digits, trailing zeros trimmed, exponent when
    // exp < -4 or >= 6 — matches native's float print (which uses %g), so playground
    // output equals the compiled binary's.
    this.emit("function __fmtG(x) { if (!isFinite(x)) return String(x); if (x === 0) return '0'; let s = x.toPrecision(6); if (s.indexOf('e') >= 0) { s = Number(s).toExponential(); return s.replace(/e([+-])(\\d)$/, 'e$10$2'); } if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\\.$/, ''); return s; }");
    this.emit("function __propagate(r) { if (r.tag !== 0) throw { __milo_prop: r }; return r.data[0]; }");
    this.emit("function __eprint(s) { if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s); else if (typeof console !== 'undefined') console.error(s); }");
    // Display formatting to match native: structs as `Name { f: v, … }`, enums as
    // `Variant(a, …)`/`Variant`, strings quoted, floats via %g.
    this.emit("function __displayVal(v) { if (typeof v === 'string') return JSON.stringify(v); if (typeof v === 'boolean') return String(v); if (typeof v === 'number') return Number.isInteger(v) ? String(v) : __fmtG(v); if (v && typeof v === 'object' && v.constructor && v.constructor.name !== 'Object') return __displayStruct(v); return String(v); }");
    this.emit("function __displayStruct(v) { const ks = Object.keys(v); return v.constructor.name + ' { ' + ks.map(k => k + ': ' + __displayVal(v[k])).join(', ') + ' }'; }");
    this.emit("function __displayEnum(v, name) { const e = __enumMeta[name][v.tag]; return e[1] === 0 ? e[0] : e[0] + '(' + v.data.map(__displayVal).join(', ') + ')'; }");
    // Maps need the explicit branch: Object.keys of a Map is empty, so the
    // generic object path would silently produce an empty HashMap.
    this.emit("function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); if (v instanceof Map) return new Map(Array.from(v, ([k, x]) => [k, __clone(x)])); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }");
    this.emit("function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }");
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
    this.usedPropagate = false;
    for (const stmt of fn.body) this.genStmt(stmt);
    const used = this.usedPropagate;
    this.usedPropagate = prevUsed;
    this.output = prevOutput;
    this.boxed = prevBoxed;

    for (const cond of requireChecks)
      this.emit(`if (!(${cond})) throw new Error("requires clause violated");`);

    const emitBody = () => {
      if (used) {
        this.emit("try {");
        for (const l of lines) this.output.push(l);
        this.emit("} catch (__e) { if (__e && __e.__milo_prop) return __e.__milo_prop; throw __e; }");
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
      case "Let": {
        const val = this.genExpr(stmt.value);
        if (this.boxed.has(stmt.name)) {
          // ref-taken primitive local: box it so callees mutating `&mut name` write back.
          this.emit(`const ${stmt.name} = {v: ${val}};`);
          break;
        }
        const kw = stmt.mutable ? "let" : "const";
        this.emit(`${kw} ${stmt.name} = ${val};`);
        break;
      }
      case "Assign": {
        const target = this.genLValue(stmt.target);
        const val = this.genExpr(stmt.value);
        this.emit(`${target} = ${val};`);
        break;
      }
      case "Return": {
        if (stmt.value) {
          this.emit(`return ${this.genExpr(stmt.value)};`);
        } else {
          this.emit("return;");
        }
        break;
      }
      case "If": {
        this.emit(`if (${this.genExpr(stmt.cond)}) {`);
        this.indent++;
        for (const s of stmt.thenBody) this.genStmt(s);
        this.indent--;
        if (stmt.elseBody && stmt.elseBody.length > 0) {
          this.emit("} else {");
          this.indent++;
          for (const s of stmt.elseBody) this.genStmt(s);
          this.indent--;
        }
        this.emit("}");
        break;
      }
      case "While": {
        this.emit(`while (${this.genExpr(stmt.cond)}) {`);
        this.indent++;
        for (const s of stmt.body) this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "Break": {
        this.emit("break;");
        break;
      }
      case "Continue": {
        this.emit("continue;");
        break;
      }
      case "ExprStmt": {
        const val = this.genExpr(stmt.expr);
        this.emit(`${val};`);
        break;
      }
      case "Match": {
        this.genMatch(stmt);
        break;
      }
      case "ForRange": {
        this.emit(`for (let ${stmt.varName} = ${this.genExpr(stmt.start)}; ${stmt.varName} < ${this.genExpr(stmt.end)}; ${stmt.varName}++) {`);
        this.indent++;
        for (const s of stmt.body) this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "ForEach": {
        const iter = this.genExpr(stmt.iterable);
        if (stmt.iterableKind === "hashmap") {
          const k = stmt.varName;
          const v = stmt.varName2 ?? "_";
          this.emit(`for (const [${k}, ${v}] of ${iter}) {`);
        } else if (stmt.iterableKind === "string") {
          // milo iterates a string by byte (u8); JS `of` yields chars.
          const sv = this.nextTemp();
          const ix = this.nextTemp();
          this.emit(`const ${sv} = ${iter};`);
          this.emit(`for (let ${ix} = 0; ${ix} < ${sv}.length; ${ix}++) {`);
          this.indent++;
          this.emit(`const ${stmt.varName} = ${sv}.charCodeAt(${ix});`);
          for (const s of stmt.body) this.genStmt(s);
          this.indent--;
          this.emit("}");
          break;
        } else {
          this.emit(`for (const ${stmt.varName} of ${iter}) {`);
        }
        this.indent++;
        for (const s of stmt.body) this.genStmt(s);
        this.indent--;
        this.emit("}");
        break;
      }
      case "UnsafeBlock": {
        for (const s of stmt.body) this.genStmt(s);
        break;
      }
    }
  }

  private genMatch(stmt: HIRStmt & { kind: "Match" }) {
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
            val = JSON.stringify(p.value);
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
        for (const s of arm.body) this.genStmt(s);
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
            if (p.bindings[i].name !== "_") {
              this.emit(`const ${p.bindings[i].name} = ${tmp}.data[${i}];`);
            }
          }
          this.indent--;
        }
        this.indent++;
        for (const s of arm.body) this.genStmt(s);
        this.indent--;
        first = false;
      }
      this.emit("}");
    }
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
        return JSON.stringify(expr.value);
      case "Ident":
        return this.boxed.has(expr.name) ? `${expr.name}.v` : expr.name;
      case "BinOp":
        return this.genBinOp(expr);
      case "UnaryOp":
        return `(${expr.op}${this.genExpr(expr.operand)})`;
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
        // milo strings index by byte (u8); JS string[i] is a 1-char string.
        // charCodeAt gives the byte for ASCII (multi-byte UTF-8 handled elsewhere).
        if (expr.object.type.tag === "string")
          return `${this.genExpr(expr.object)}.charCodeAt(${this.genExpr(expr.index)})`;
        return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
      case "EnumLit": {
        const args = expr.args.map(a => this.genExpr(a)).join(", ");
        return `${expr.enumName}.${expr.variant}(${args})`;
      }
      case "ArrayLen":
      case "VecLen":
        return `${this.genExpr(expr.object)}.length`;
      case "StringLen":
        return `${this.genExpr(expr.object)}.length`;
      case "Unwrap":
        return `${this.genExpr(expr.operand)}.data[0]`;
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
      case "VecPush":
        return `${this.genExpr(expr.vec)}.push(${this.genExpr(expr.value)})`;
      case "VecPop":
        // pop(): Option<T> — Some(last)/None. Bind the array once so the length
        // check and the mutating .pop() hit the same reference.
        return `((_v) => _v.length > 0 ? ${expr.optionEnumName}.Some(_v.pop()) : ${expr.optionEnumName}.None())(${this.genExpr(expr.vec)})`;
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
      case "HashMapContains":
        return `${this.genExpr(expr.map)}.has(${this.genExpr(expr.key)})`;
      case "HashMapRemove":
        return `${this.genExpr(expr.map)}.delete(${this.genExpr(expr.key)})`;
      case "HashMapLen":
        return `${this.genExpr(expr.object)}.size`;
      case "StringPush":
        return `(${this.genExpr(expr.str)} += String.fromCharCode(${this.genExpr(expr.byte)}))`;
      case "StringSubstr":
      case "StringSlice":
        return `${this.genExpr(expr.str)}.slice(${this.genExpr(expr.start)}, ${this.genExpr(expr.end)})`;
      case "StringParseF64":
        return `parseFloat(${this.genExpr(expr.str)})`;
      case "StringClone":
        return this.genExpr(expr.str);
      case "StringWithCapacity":
        // capacity is a native allocation hint; JS strings need none.
        return `""`;
      case "NumberToString":
        return `String(${this.genExpr(expr.value)})`;
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
    // which JS f64/int32 math does not give for free.
    if (expr.type.tag === "int") {
      const op = expr.op;
      const bits = expr.type.bits;
      // JS bitwise/shift operators coerce operands to SIGNED int32. For <=32-bit
      // types maskInt then yields the correct (positive) value; but i64/u64 — used
      // by 32-bit CPU cores to hold masked 32-bit registers — need explicit
      // normalization so a bit31-set value like 0xFFFFFFFF isn't seen as -1.
      if (op === "&" || op === "|" || op === "^" || op === "<<") {
        const raw = `(${l} ${op} ${r})`;
        return bits >= 64 ? `(${raw} >>> 0)` : this.maskInt(raw, expr.type);
      }
      if (op === ">>") {
        // Divide-based shift is correct for any magnitude (JS `>>` would coerce to
        // int32 and sign-corrupt 32-bit values) and matches native arithmetic shift
        // for negatives (Math.floor rounds toward -inf).
        const raw = `Math.floor(${l} / 2 ** (${r}))`;
        return bits >= 64 ? raw : this.maskInt(raw, expr.type);
      }
      if (op === "+" || op === "-" || op === "*") {
        return this.maskInt(`(${l} ${op} ${r})`, expr.type);
      }
      if (op === "/") return this.maskInt(`Math.trunc(${l} / ${r})`, expr.type);
      if (op === "%") return `(${l} % ${r})`;
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
    return this.genExpr(a.expr);
  }

  private genCall(expr: HIRExpr & { kind: "Call" }): string {
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
      case "exit":
        return `(() => { throw new Error("exit: " + ${args[0]}); })()`;
      case "assert":
        return `__assert(${args[0]}, ${args[1] ?? '""'})`;
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
    if (target.tag === "float") return `(+${val})`;
    if (target.tag === "bool") return `Boolean(${val})`;
    return val;
  }

  private genClosure(expr: HIRExpr & { kind: "Closure" }): string {
    const params = expr.params.map(p => p.name).join(", ");
    if (expr.body.length === 1 && expr.body[0].kind === "Return" && expr.body[0].value) {
      const ret = this.genExpr(expr.body[0].value);
      return `((${params}) => ${ret})`;
    }
    const lines: string[] = [];
    const prevOutput = this.output;
    this.output = lines;
    for (const s of expr.body) this.genStmt(s);
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
    if (expr.type.tag === "enum") return `__displayEnum(${val}, ${JSON.stringify(expr.type.name)})`;
    return `String(${val})`;
  }

  private genLValue(expr: HIRExpr): string {
    switch (expr.kind) {
      case "Ident":
        return this.boxed.has(expr.name) ? `${expr.name}.v` : expr.name;
      case "FieldAccess":
        return `${this.genLValue(expr.object)}.${expr.field}`;
      case "IndexAccess":
        return `${this.genExpr(expr.object)}[${this.genExpr(expr.index)}]`;
      case "HeapDeref":
      case "PtrDeref":
        return this.genLValue(expr.operand);
      default:
        return this.genExpr(expr);
    }
  }
}
