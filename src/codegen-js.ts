// JS codegen backend — HIR → JavaScript for browser playground
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern } from "./hir";
import type { TypeKind } from "./types";

export class CodegenJS {
  private output: string[] = [];
  private indent = 0;
  private tempCounter = 0;

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
    this.emit("function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }");
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
    for (const stmt of fn.body) {
      this.genStmt(stmt);
    }
    this.indent--;
    this.emit("}");
  }

  private genStmt(stmt: HIRStmt) {
    switch (stmt.kind) {
      case "Let": {
        const val = this.genExpr(stmt.value);
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
          const val = typeof arm.pattern.value === "string"
            ? JSON.stringify(arm.pattern.value)
            : String(arm.pattern.value);
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
        return `String.fromCharCode(${expr.value})`;
      case "StringLit":
        return JSON.stringify(expr.value);
      case "Ident":
        return expr.name;
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
        // in JS playground we just unwrap — no real error propagation across async boundaries
        return `${this.genExpr(expr.operand)}.data[0]`;
      }
      case "DefaultValue": {
        const operand = this.genExpr(expr.operand);
        const def = this.genExpr(expr.default);
        return `(${operand}.tag === 0 ? ${operand}.data[0] : ${def})`;
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
        return `${this.genExpr(expr.vec)}.pop()`;
      case "HashMapNew":
        return "new Map()";
      case "HashMapInsert":
        return `${this.genExpr(expr.map)}.set(${this.genExpr(expr.key)}, ${this.genExpr(expr.value)})`;
      case "HashMapGet": {
        const m = this.genExpr(expr.map);
        const k = this.genExpr(expr.key);
        return `(${m}.has(${k}) ? ${expr.optionEnumName}.Some(${m}.get(${k})) : ${expr.optionEnumName}.None())`;
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
      case "NumberToString":
        return `String(${this.genExpr(expr.value)})`;
      case "JsonStringify":
        return `JSON.stringify(${this.genExpr(expr.value)})`;
      case "Closure":
        return this.genClosure(expr);
      case "ClosureCall": {
        const callee = this.genExpr(expr.callee);
        const args = expr.args.map(a => this.genExpr(a.expr)).join(", ");
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

    return `(${l} ${expr.op} ${r})`;
  }

  private genCall(expr: HIRExpr & { kind: "Call" }): string {
    const args = expr.args.map(a => this.genExpr(a.expr));

    switch (expr.func) {
      case "print": {
        const parts = expr.args.map(a => this.coerceToString(a.expr));
        return `__print(${parts.join(" + ")} + "\\n")`;
      }
      case "eprint": {
        const parts = expr.args.map(a => this.coerceToString(a.expr));
        return `__print(${parts.join(" + ")})`;
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
    if (target.tag === "int") return `(${val} | 0)`;
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
    if (expr.type.tag === "char") return `String.fromCharCode(${val})`;
    if (expr.type.tag === "float") return `__fmtG(${val})`;
    if (expr.type.tag === "int") return `String(${val})`;
    return `String(${val})`;
  }

  private genLValue(expr: HIRExpr): string {
    switch (expr.kind) {
      case "Ident":
        return expr.name;
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
