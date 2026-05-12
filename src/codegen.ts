import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern } from "./hir";
import type { TypeKind } from "./types";

interface StructLayout {
  name: string;
  fields: { name: string; type: string; typeKind: TypeKind }[];
}

interface EnumLayout {
  name: string;
  payloadSlots: number;
  variants: Map<string, { tag: number; fieldTypes: string[] }>;
}

export class Codegen {
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, { type: string; typeKind: TypeKind; mutable: boolean; isRef: boolean }>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>();
  private structLayouts = new Map<string, StructLayout>();
  private enumLayouts = new Map<string, EnumLayout>();
  private userDeclaredFns = new Set<string>();
  private needsBoundsCheck = false;
  private needsPrintf = false;
  private needsPutchar = false;
  private needsExit = false;
  private static BUILTINS = new Set(["print", "println", "exit"]);

  private nextTemp(): string { return `%t${this.tempCounter++}`; }
  private nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private emit(line: string) { this.output.push(line); }

  private llvmType(t: TypeKind): string {
    switch (t.tag) {
      case "int":    return `i${t.bits}`;
      case "float":  return t.bits === 32 ? "float" : "double";
      case "bool":   return "i1";
      case "void":   return "void";
      case "ptr":    return "ptr";
      case "ref":    return "ptr";
      case "struct": return `%${t.name}`;
      case "enum":   return `%${t.name}`;
      case "array":
        if (t.size !== null) return `[${t.size} x ${this.llvmType(t.element)}]`;
        return `{ ptr, i32 }`;
      case "unknown": throw new Error("unknown type in codegen");
    }
  }

  private isUnsigned(t: TypeKind): boolean {
    return t.tag === "int" && !t.signed;
  }

  private addString(value: string): { label: string; length: number } {
    const label = `@.str.${this.strCounter++}`;
    const escaped = value
      .replace(/\\/g, "\\5C").replace(/\n/g, "\\0A")
      .replace(/\t/g, "\\09").replace(/\0/g, "\\00").replace(/"/g, "\\22");
    const length = value.length + 1;
    this.strings.push({ label, escaped, length });
    return { label, length };
  }

  private typeSize(ty: string): number {
    if (ty === "i1" || ty === "i8") return 1;
    if (ty === "i16") return 2;
    if (ty === "i32") return 4;
    if (ty === "i64") return 8;
    if (ty === "float") return 4;
    if (ty === "double") return 8;
    if (ty === "ptr") return 8;
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return parseInt(arrMatch[1]) * this.typeSize(arrMatch[2]);
    return 8;
  }

  private structPayloadSize(fieldTypes: string[]): number {
    let offset = 0;
    let maxAlign = 1;
    for (const ty of fieldTypes) {
      const size = this.typeSize(ty);
      const align = Math.min(size, 8);
      offset = Math.ceil(offset / align) * align;
      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }
    return Math.ceil(offset / maxAlign) * maxAlign;
  }

  generate(module: HIRModule): string {
    // register struct layouts
    for (const s of module.structs) {
      const layout: StructLayout = {
        name: s.name,
        fields: s.fields.map(f => ({ name: f.name, type: this.llvmType(f.type), typeKind: f.type })),
      };
      this.structLayouts.set(s.name, layout);
    }

    // register enum layouts
    for (const e of module.enums) {
      let maxPayload = 0;
      const variants = new Map<string, { tag: number; fieldTypes: string[] }>();
      for (const v of e.variants) {
        const fieldTypes = v.fields.map(f => this.llvmType(f));
        const payloadSize = this.structPayloadSize(fieldTypes);
        maxPayload = Math.max(maxPayload, payloadSize);
        variants.set(v.name, { tag: v.tag, fieldTypes });
      }
      this.enumLayouts.set(e.name, {
        name: e.name,
        payloadSlots: Math.ceil(maxPayload / 8),
        variants,
      });
    }

    // register function signatures
    for (const fn of module.functions) {
      this.userDeclaredFns.add(fn.name);
      this.fnSigs.set(fn.name, {
        paramTypes: fn.params.map(p => p.isRef || p.isRefMut ? "ptr" : this.llvmType(p.type)),
        retType: this.llvmType(fn.retType),
        variadic: fn.isVariadic,
      });
    }

    this.emit(`target triple = "arm64-apple-darwin25.3.0"`);
    this.emit("");

    const externs = module.functions.filter(f => f.isExtern);
    const functions = module.functions.filter(f => !f.isExtern);

    // generate function bodies first (collects string constants, sets needsBoundsCheck)
    const fnBodies: string[][] = [];
    for (const fn of functions) fnBodies.push(this.genFunction(fn));

    // auto-declare C functions needed by built-ins and bounds checks
    const declaredExterns = new Set(externs.map(e => e.name));
    if (this.needsBoundsCheck) { this.needsPrintf = true; this.needsExit = true; }
    if (this.needsExit && !declaredExterns.has("exit"))
      this.output.splice(1, 0, "declare void @exit(i32) noreturn");
    if (this.needsPutchar && !declaredExterns.has("putchar"))
      this.output.splice(1, 0, "declare i32 @putchar(i32)");
    if (this.needsPrintf && !declaredExterns.has("printf"))
      this.output.splice(1, 0, `declare i32 @printf(ptr, ...)`);
    if (this.needsBoundsCheck)
      this.output.splice(1, 0, `@.bounds_err = private unnamed_addr constant [40 x i8] c"milo: array index out of bounds: %d/%d\\0A\\00"`);

    // insert string constants
    for (let i = this.strings.length - 1; i >= 0; i--) {
      const { label, escaped, length } = this.strings[i];
      this.output.splice(1, 0, `${label} = private unnamed_addr constant [${length} x i8] c"${escaped}\\00"`);
    }
    if (this.strings.length > 0) this.output.splice(1, 0, "");

    // insert struct type definitions
    for (const [name, layout] of this.structLayouts) {
      const fieldTypes = layout.fields.map(f => f.type).join(", ");
      this.output.splice(1, 0, `%${name} = type { ${fieldTypes} }`);
    }

    // insert enum type definitions
    for (const [name, layout] of this.enumLayouts) {
      if (layout.payloadSlots > 0) {
        this.output.splice(1, 0, `%${name} = type { i32, [${layout.payloadSlots} x i64] }`);
      } else {
        this.output.splice(1, 0, `%${name} = type { i32 }`);
      }
    }

    // insert extern declarations
    for (const ext of externs) {
      const sig = this.fnSigs.get(ext.name)!;
      const paramTypes = [...sig.paramTypes];
      if (ext.isVariadic) paramTypes.push("...");
      this.output.splice(1, 0, `declare ${sig.retType} @${ext.name}(${paramTypes.join(", ")})`);
    }

    // append function bodies
    for (const body of fnBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    return this.output.join("\n") + "\n";
  }

  private genFunction(fn: HIRFunction): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals.clear();
    const lines: string[] = [];

    const params = fn.params.map(p => {
      const lt = p.isRef || p.isRefMut ? "ptr" : this.llvmType(p.type);
      return `${lt} %${p.name}`;
    }).join(", ");
    const ret = this.llvmType(fn.retType);
    lines.push(`define ${ret} @${fn.name}(${params}) {`);
    lines.push("entry:");

    for (const p of fn.params) {
      if (p.isRef || p.isRefMut) {
        const innerTy = this.llvmType(p.type);
        lines.push(`  %${p.name}.addr = alloca ptr`);
        lines.push(`  store ptr %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: innerTy, typeKind: p.type, mutable: p.isRefMut, isRef: true });
      } else {
        const lt = this.llvmType(p.type);
        lines.push(`  %${p.name}.addr = alloca ${lt}`);
        lines.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: lt, typeKind: p.type, mutable: false, isRef: false });
      }
    }

    let hasTerminator = false;
    for (const stmt of fn.body) {
      const [stmtLines, terminated] = this.genStmt(stmt);
      lines.push(...stmtLines);
      if (terminated) hasTerminator = true;
    }

    if (!hasTerminator) {
      if (ret === "void") lines.push("  ret void");
      else if (ret === "i32") lines.push("  ret i32 0");
    }

    lines.push("}");
    return lines;
  }

  private genStmt(stmt: HIRStmt): [string[], boolean] {
    const lines: string[] = [];

    switch (stmt.kind) {
      case "Let": {
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        const declTy = this.llvmType(stmt.type);
        this.locals.set(stmt.name, { type: declTy, typeKind: stmt.type, mutable: stmt.mutable, isRef: false });
        lines.push(`  %${stmt.name}.addr = alloca ${declTy}`);
        lines.push(`  store ${declTy} ${val}, ptr %${stmt.name}.addr`);
        return [lines, false];
      }
      case "Assign": {
        const [valLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...valLines);
        const [targetLines, targetPtr, targetTy] = this.genLValue(stmt.target);
        lines.push(...targetLines);
        lines.push(`  store ${valTy} ${val}, ptr ${targetPtr}`);
        return [lines, false];
      }
      case "Return": {
        if (!stmt.value) { lines.push("  ret void"); return [lines, true]; }
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        lines.push(`  ret ${valTy} ${val}`);
        return [lines, true];
      }
      case "If": return this.genIf(stmt);
      case "While": return this.genWhile(stmt);
      case "ExprStmt": {
        const [exprLines] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        return [lines, false];
      }
      case "Match":
        return this.genMatch(stmt);
    }
  }

  private genLValue(expr: HIRExpr): [string[], string, string] {
    const lines: string[] = [];
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ptr, ptr %${expr.name}.addr`);
        return [lines, tmp, local.type];
      }
      return [lines, `%${expr.name}.addr`, local?.type ?? "i32"];
    }
    if (expr.kind === "FieldAccess") {
      const [objLines, objPtr, objTy] = this.genLValue(expr.object);
      lines.push(...objLines);
      const structName = this.getStructName(objTy);
      if (structName) {
        const layout = this.structLayouts.get(structName)!;
        const idx = layout.fields.findIndex(f => f.name === expr.field);
        const fieldTy = layout.fields[idx].type;
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = getelementptr %${structName}, ptr ${objPtr}, i32 0, i32 ${idx}`);
        return [lines, tmp, fieldTy];
      }
    }
    if (expr.kind === "IndexAccess") {
      return this.genBoundsCheckedPtr(expr, lines);
    }
    return [lines, "null", "i32"];
  }

  private genBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    const [objLines, objPtr, objTy] = this.genLValue(expr.object);
    lines.push(...objLines);
    const [idxLines, idxVal] = this.genExpr(expr.index);
    lines.push(...idxLines);

    const match = objTy.match(/\[(\d+) x (.+)\]/);
    if (match) {
      const size = parseInt(match[1]);
      const elemTy = match[2];
      this.emitBoundsCheck(lines, idxVal, String(size));
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${objTy}, ptr ${objPtr}, i32 0, i32 ${idxVal}`);
      return [lines, ptr, elemTy];
    }
    return [lines, "null", "i32"];
  }

  private emitBoundsCheck(lines: string[], idx: string, size: string) {
    this.needsBoundsCheck = true;
    const cmpTmp = this.nextTemp();
    const okLabel = this.nextLabel("bounds.ok");
    const failLabel = this.nextLabel("bounds.fail");

    lines.push(`  ${cmpTmp} = icmp ult i32 ${idx}, ${size}`);
    lines.push(`  br i1 ${cmpTmp}, label %${okLabel}, label %${failLabel}`);
    lines.push(`${failLabel}:`);
    const fmtPtr = this.nextTemp();
    lines.push(`  ${fmtPtr} = getelementptr [40 x i8], ptr @.bounds_err, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${fmtPtr}, i32 ${idx}, i32 ${size})`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);
    lines.push(`${okLabel}:`);
  }

  private getStructName(llvmTy: string): string | null {
    const m = llvmTy.match(/^%(.+)$/);
    if (m && this.structLayouts.has(m[1])) return m[1];
    return null;
  }

  private genIf(stmt: HIRStmt & { kind: "If" }): [string[], boolean] {
    const lines: string[] = [];
    const [condLines, condVal] = this.genExpr(stmt.cond);
    lines.push(...condLines);
    const thenLabel = this.nextLabel("then");
    const elseLabel = this.nextLabel("else");
    const endLabel = this.nextLabel("endif");
    lines.push(`  br i1 ${condVal}, label %${thenLabel}, label %${elseLabel}`);
    lines.push(`${thenLabel}:`);
    let thenTerminated = false;
    for (const s of stmt.thenBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) thenTerminated = true; }
    if (!thenTerminated) lines.push(`  br label %${endLabel}`);
    lines.push(`${elseLabel}:`);
    let elseTerminated = false;
    if (stmt.elseBody) { for (const s of stmt.elseBody) { const [sl, t] = this.genStmt(s); lines.push(...sl); if (t) elseTerminated = true; } }
    if (!elseTerminated) lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, thenTerminated && elseTerminated];
  }

  private genWhile(stmt: HIRStmt & { kind: "While" }): [string[], boolean] {
    const lines: string[] = [];
    const condLabel = this.nextLabel("while.cond");
    const bodyLabel = this.nextLabel("while.body");
    const endLabel = this.nextLabel("while.end");
    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const [condLines, condVal] = this.genExpr(stmt.cond);
    lines.push(...condLines);
    lines.push(`  br i1 ${condVal}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);
    for (const s of stmt.body) { const [sl] = this.genStmt(s); lines.push(...sl); }
    lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    return [lines, false];
  }

  private genMatch(stmt: HIRStmt & { kind: "Match" }): [string[], boolean] {
    const lines: string[] = [];
    const [subjLines, subjVal, subjTy] = this.genExpr(stmt.subject);
    lines.push(...subjLines);

    const subjAddr = this.nextTemp();
    lines.push(`  ${subjAddr} = alloca ${subjTy}`);
    lines.push(`  store ${subjTy} ${subjVal}, ptr ${subjAddr}`);

    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const layout = this.enumLayouts.get(stmt.enumName)!;
    const endLabel = this.nextLabel("match.end");
    const defaultLabel = this.nextLabel("match.default");

    const armLabels: { tag: number; label: string; arm: typeof stmt.arms[0] }[] = [];
    let wildcardArm: typeof stmt.arms[0] | null = null;
    for (const arm of stmt.arms) {
      if (arm.pattern.kind === "WildcardPattern") {
        wildcardArm = arm;
      } else {
        const label = this.nextLabel(`match.${arm.pattern.variant}`);
        armLabels.push({ tag: arm.pattern.tag, label, arm });
      }
    }

    const cases = armLabels.map(a => `i32 ${a.tag}, label %${a.label}`).join(" ");
    const defaultTarget = wildcardArm ? this.nextLabel("match.wildcard") : defaultLabel;
    lines.push(`  switch i32 ${tag}, label %${defaultTarget} [${cases}]`);

    for (const { label, arm } of armLabels) {
      lines.push(`${label}:`);
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
        const variant = layout.variants.get(arm.pattern.variant)!;
        this.extractBindings(lines, subjAddr, subjTy, variant, arm.pattern);
      }
      for (const s of arm.body) {
        const [sl] = this.genStmt(s);
        lines.push(...sl);
      }
      lines.push(`  br label %${endLabel}`);
    }

    if (wildcardArm) {
      lines.push(`${defaultTarget}:`);
      for (const s of wildcardArm.body) {
        const [sl] = this.genStmt(s);
        lines.push(...sl);
      }
      lines.push(`  br label %${endLabel}`);
    }

    if (!wildcardArm) {
      lines.push(`${defaultLabel}:`);
      lines.push(`  unreachable`);
    }

    lines.push(`${endLabel}:`);
    return [lines, false];
  }

  private extractBindings(
    lines: string[], subjAddr: string, subjTy: string,
    variant: { tag: number; fieldTypes: string[] },
    pattern: HIRPattern & { kind: "EnumPattern" },
  ) {
    if (pattern.bindings.length === 0) return;
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 1`);

    if (pattern.bindings.length === 1) {
      const ty = variant.fieldTypes[0];
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${ty}, ptr ${payloadPtr}`);
      lines.push(`  %${pattern.bindings[0].name}.addr = alloca ${ty}`);
      lines.push(`  store ${ty} ${val}, ptr %${pattern.bindings[0].name}.addr`);
      this.locals.set(pattern.bindings[0].name, { type: ty, typeKind: pattern.bindings[0].type, mutable: false, isRef: false });
    } else {
      const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
      for (let i = 0; i < pattern.bindings.length; i++) {
        const ty = variant.fieldTypes[i];
        const fieldPtr = this.nextTemp();
        lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
        lines.push(`  %${pattern.bindings[i].name}.addr = alloca ${ty}`);
        lines.push(`  store ${ty} ${val}, ptr %${pattern.bindings[i].name}.addr`);
        this.locals.set(pattern.bindings[i].name, { type: ty, typeKind: pattern.bindings[i].type, mutable: false, isRef: false });
      }
    }
  }

  private genBuiltinCall(expr: HIRExpr & { kind: "Call" }, lines: string[]): [string[], string, string] {
    if (expr.func === "print" || expr.func === "println") {
      this.needsPrintf = true;
      if (expr.func === "println") this.needsPutchar = true;
      const argVals: { val: string; type: string }[] = [];
      for (const arg of expr.args) {
        const [al, av, at] = this.genExpr(arg.expr);
        lines.push(...al);
        argVals.push({ val: av, type: at });
      }
      const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
      lines.push(`  call i32 (ptr, ...) @printf(${argsStr})`);
      if (expr.func === "println") lines.push(`  call i32 @putchar(i32 10)`);
      return [lines, "void", "void"];
    }
    if (expr.func === "exit") {
      this.needsExit = true;
      const [al, av] = this.genExpr(expr.args[0].expr);
      lines.push(...al);
      lines.push(`  call void @exit(i32 ${av})`);
      return [lines, "void", "void"];
    }
    return [lines, "void", "void"];
  }

  private genExpr(expr: HIRExpr): [string[], string, string] {
    const lines: string[] = [];
    const lt = this.llvmType(expr.type);

    switch (expr.kind) {
      case "IntLit":
        return [lines, String(expr.value), lt];
      case "FloatLit":
        return [lines, `${expr.value.toExponential()}`, lt];
      case "BoolLit":
        return [lines, expr.value ? "1" : "0", "i1"];
      case "StringLit": {
        const { label, length } = this.addString(expr.value);
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = getelementptr [${length} x i8], ptr ${label}, i32 0, i32 0`);
        return [lines, tmp, "ptr"];
      }
      case "Ident": {
        const local = this.locals.get(expr.name);
        if (!local) { console.error(`error[codegen]: undefined variable '${expr.name}'`); process.exit(1); }
        if (local.isRef) {
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = load ptr, ptr %${expr.name}.addr`);
          if (this.getStructName(local.type)) return [lines, ptr, local.type];
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${local.type}, ptr ${ptr}`);
          return [lines, val, local.type];
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ${local.type}, ptr %${expr.name}.addr`);
        return [lines, tmp, local.type];
      }
      case "BinOp": {
        const [ll, lv, llt] = this.genExpr(expr.left);
        const [rl, rv] = this.genExpr(expr.right);
        lines.push(...ll, ...rl);
        const tmp = this.nextTemp();
        const isFloat = llt === "float" || llt === "double";
        const unsigned = !isFloat && this.isUnsigned(expr.left.type);
        const intOps: Record<string, string> = unsigned
          ? { "+": "add", "-": "sub", "*": "mul", "/": "udiv", "%": "urem" }
          : { "+": "add", "-": "sub", "*": "mul", "/": "sdiv", "%": "srem" };
        const floatOps: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "%": "frem" };
        const intCmps: Record<string, string> = unsigned
          ? { "==": "eq", "!=": "ne", "<": "ult", ">": "ugt", "<=": "ule", ">=": "uge" }
          : { "==": "eq", "!=": "ne", "<": "slt", ">": "sgt", "<=": "sle", ">=": "sge" };
        const floatCmps: Record<string, string> = { "==": "oeq", "!=": "one", "<": "olt", ">": "ogt", "<=": "ole", ">=": "oge" };
        if (expr.op in intOps) {
          const op = isFloat ? floatOps[expr.op] : intOps[expr.op];
          lines.push(`  ${tmp} = ${op} ${llt} ${lv}, ${rv}`);
          return [lines, tmp, llt];
        }
        if (expr.op in intCmps) {
          if (isFloat) lines.push(`  ${tmp} = fcmp ${floatCmps[expr.op]} ${llt} ${lv}, ${rv}`);
          else lines.push(`  ${tmp} = icmp ${intCmps[expr.op]} ${llt} ${lv}, ${rv}`);
          return [lines, tmp, "i1"];
        }
        console.error(`error[codegen]: unknown binary op '${expr.op}'`); process.exit(1);
      }
      case "UnaryOp": {
        const [ol, ov, ot] = this.genExpr(expr.operand);
        lines.push(...ol);
        const tmp = this.nextTemp();
        if (expr.op === "-") {
          if (ot === "float" || ot === "double") lines.push(`  ${tmp} = fneg ${ot} ${ov}`);
          else lines.push(`  ${tmp} = sub ${ot} 0, ${ov}`);
          return [lines, tmp, ot];
        }
        if (expr.op === "!") { lines.push(`  ${tmp} = xor i1 ${ov}, 1`); return [lines, tmp, "i1"]; }
        console.error(`error[codegen]: unknown unary op '${expr.op}'`); process.exit(1);
      }
      case "Call": {
        if (Codegen.BUILTINS.has(expr.func) && !this.userDeclaredFns.has(expr.func)) {
          return this.genBuiltinCall(expr, lines);
        }
        const sig = this.fnSigs.get(expr.func);
        const argVals: { val: string; type: string }[] = [];
        for (const arg of expr.args) {
          if (arg.passByRef) {
            const [al, aPtr] = this.genLValueForArg(arg.expr);
            lines.push(...al);
            argVals.push({ val: aPtr, type: "ptr" });
          } else {
            const [al, av, at] = this.genExpr(arg.expr);
            lines.push(...al);
            argVals.push({ val: av, type: at });
          }
        }
        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = sig?.retType ?? "i32";
        let callPrefix = retTy;
        if (expr.variadic) {
          const paramStr = sig!.paramTypes.join(", ");
          callPrefix = `${retTy} (${paramStr}, ...)`;
        }
        if (retTy === "void") {
          lines.push(`  call ${callPrefix} @${expr.func}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = call ${callPrefix} @${expr.func}(${argsStr})`);
        return [lines, tmp, retTy];
      }
      case "StructLit": {
        const layout = this.structLayouts.get(expr.name)!;
        const structTy = `%${expr.name}`;
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${structTy}`);
        for (const f of expr.fields) {
          const idx = layout.fields.findIndex(lf => lf.name === f.name);
          const fieldTy = layout.fields[idx].type;
          const [fLines, fVal] = this.genExpr(f.value);
          lines.push(...fLines);
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = getelementptr ${structTy}, ptr ${alloca}, i32 0, i32 ${idx}`);
          lines.push(`  store ${fieldTy} ${fVal}, ptr ${ptr}`);
        }
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${structTy}, ptr ${alloca}`);
        return [lines, val, structTy];
      }
      case "FieldAccess": {
        const [ptrLines, ptr, fieldTy] = this.genFieldPtr(expr);
        lines.push(...ptrLines);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${fieldTy}, ptr ${ptr}`);
        return [lines, val, fieldTy];
      }
      case "ArrayLen": {
        // compile-time constant — extract size from the object's array type
        const objType = expr.object.type;
        if (objType.tag === "array" && objType.size !== null) {
          return [lines, String(objType.size), "i32"];
        }
        return [lines, "0", "i32"];
      }
      case "ArrayLit": {
        if (expr.elements.length === 0) return [lines, "zeroinitializer", "[0 x i32]"];
        const [firstLines, firstVal, elemTy] = this.genExpr(expr.elements[0]);
        lines.push(...firstLines);
        const arrTy = `[${expr.elements.length} x ${elemTy}]`;
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${arrTy}`);
        const ptr0 = this.nextTemp();
        lines.push(`  ${ptr0} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 0`);
        lines.push(`  store ${elemTy} ${firstVal}, ptr ${ptr0}`);
        for (let i = 1; i < expr.elements.length; i++) {
          const [el, ev] = this.genExpr(expr.elements[i]);
          lines.push(...el);
          const pi = this.nextTemp();
          lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
          lines.push(`  store ${elemTy} ${ev}, ptr ${pi}`);
        }
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${arrTy}, ptr ${alloca}`);
        return [lines, val, arrTy];
      }
      case "IndexAccess": {
        const [ptrLines, ptr, elemTy] = this.genBoundsCheckedPtr(expr, lines);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
        return [lines, val, elemTy];
      }
      case "EnumLit": {
        const layout = this.enumLayouts.get(expr.enumName)!;
        const variant = layout.variants.get(expr.variant)!;
        const enumTy = `%${expr.enumName}`;
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${enumTy}`);
        const tagPtr = this.nextTemp();
        lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${alloca}, i32 0, i32 0`);
        lines.push(`  store i32 ${variant.tag}, ptr ${tagPtr}`);
        if (expr.args.length > 0) {
          const payloadPtr = this.nextTemp();
          lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${alloca}, i32 0, i32 1`);
          if (expr.args.length === 1) {
            const [argLines, argVal, argTy] = this.genExpr(expr.args[0]);
            lines.push(...argLines);
            lines.push(`  store ${argTy} ${argVal}, ptr ${payloadPtr}`);
          } else {
            const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
            for (let i = 0; i < expr.args.length; i++) {
              const [argLines, argVal, argTy] = this.genExpr(expr.args[i]);
              lines.push(...argLines);
              const fieldPtr = this.nextTemp();
              lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
              lines.push(`  store ${argTy} ${argVal}, ptr ${fieldPtr}`);
            }
          }
        }
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${enumTy}, ptr ${alloca}`);
        return [lines, val, enumTy];
      }
    }
  }

  private genFieldPtr(expr: HIRExpr & { kind: "FieldAccess" }): [string[], string, string] {
    const lines: string[] = [];
    const [objLines, objPtr, objTy] = this.genLValue(expr.object);
    lines.push(...objLines);
    const structName = this.getStructName(objTy);
    if (structName) {
      const layout = this.structLayouts.get(structName)!;
      const idx = layout.fields.findIndex(f => f.name === expr.field);
      const fieldTy = layout.fields[idx].type;
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr %${structName}, ptr ${objPtr}, i32 0, i32 ${idx}`);
      return [lines, ptr, fieldTy];
    }
    return [lines, "null", "i32"];
  }

  private genLValueForArg(expr: HIRExpr): [string[], string] {
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        const lines: string[] = [];
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ptr, ptr %${expr.name}.addr`);
        return [lines, tmp];
      }
      return [[], `%${expr.name}.addr`];
    }
    if (expr.kind === "FieldAccess") {
      const [lines, ptr] = this.genFieldPtr(expr);
      return [lines, ptr];
    }
    const lines: string[] = [];
    const [el, ev, et] = this.genExpr(expr);
    lines.push(...el);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${et}`);
    lines.push(`  store ${et} ${ev}, ptr ${tmp}`);
    return [lines, tmp];
  }
}
