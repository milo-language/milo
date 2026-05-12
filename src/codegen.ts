import type { MiloType, Expr, Stmt, Function, Program, StructDecl, EnumDecl, Pattern } from "./ast";

const MILO_TO_LLVM: Record<string, string> = {
  i8: "i8", i16: "i16", i32: "i32", i64: "i64",
  u8: "i8", u16: "i16", u32: "i32", u64: "i64",
  f32: "float", f64: "double",
  bool: "i1", void: "void",
};

interface StructLayout {
  name: string;
  fields: { name: string; type: string; miloType: MiloType }[];
}

interface EnumLayout {
  name: string;
  payloadSlots: number; // number of i64 slots for payload (0 = tag-only)
  variants: Map<string, { tag: number; fieldTypes: string[] }>;
}

export class Codegen {
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, { type: string; mutable: boolean; isRef: boolean }>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean; params: { type: MiloType; name: string }[] }>();
  private structLayouts = new Map<string, StructLayout>();
  private enumLayouts = new Map<string, EnumLayout>();
  private needsBoundsCheck = false;

  private nextTemp(): string { return `%t${this.tempCounter++}`; }
  private nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private emit(line: string) { this.output.push(line); }

  private llvmType(ty: MiloType): string {
    if (ty.isRef || ty.isRefMut) return "ptr"; // references are pointers
    if (ty.isPtr) return "ptr";
    if (ty.isArray) {
      const elem = MILO_TO_LLVM[ty.name] ?? `%${ty.name}`;
      if (ty.arraySize !== null) return `[${ty.arraySize} x ${elem}]`;
      return `{ ptr, i32 }`; // fat pointer for dynamic arrays
    }
    return MILO_TO_LLVM[ty.name] ?? `%${ty.name}`;
  }

  private llvmTypeFromName(name: string): string {
    return MILO_TO_LLVM[name] ?? `%${name}`;
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

  // approximate LLVM struct layout to compute payload buffer size
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

  generate(program: Program): string {
    // register struct layouts
    for (const s of program.structs) {
      const layout: StructLayout = {
        name: s.name,
        fields: s.fields.map(f => ({
          name: f.name,
          type: this.llvmType(f.type),
          miloType: f.type,
        })),
      };
      this.structLayouts.set(s.name, layout);
    }

    // register enum layouts (skip generic templates — only concrete/monomorphized)
    for (const e of program.enums) {
      if (e.typeParams.length > 0) continue;
      let maxPayload = 0;
      const variants = new Map<string, { tag: number; fieldTypes: string[] }>();
      e.variants.forEach((v, i) => {
        const fieldTypes = v.fields.map(f => this.llvmType(f));
        const payloadSize = this.structPayloadSize(fieldTypes);
        maxPayload = Math.max(maxPayload, payloadSize);
        variants.set(v.name, { tag: i, fieldTypes });
      });
      this.enumLayouts.set(e.name, {
        name: e.name,
        payloadSlots: Math.ceil(maxPayload / 8),
        variants,
      });
    }

    // register function signatures
    for (const fn of program.functions) {
      const ret = this.llvmType(fn.retType);
      this.fnSigs.set(fn.name, {
        paramTypes: fn.params.map(p => this.llvmType(p.type)),
        retType: ret,
        variadic: fn.isVariadic,
        params: fn.params.map(p => ({ type: p.type, name: p.name })),
      });
    }

    this.emit(`target triple = "arm64-apple-darwin25.3.0"`);
    this.emit("");

    const externs = program.functions.filter(f => f.isExtern);
    const functions = program.functions.filter(f => !f.isExtern);

    // generate function bodies first (collects string constants, sets needsBoundsCheck)
    const fnBodies: string[][] = [];
    for (const fn of functions) fnBodies.push(this.genFunction(fn));

    // insert bounds check helper if needed
    const hasExternPrintf = externs.some(e => e.name === "printf");
    if (this.needsBoundsCheck) {
      this.output.splice(1, 0, "declare void @exit(i32) noreturn");
      if (!hasExternPrintf) this.output.splice(1, 0, `declare i32 @printf(ptr, ...)`);
      this.output.splice(1, 0, `@.bounds_err = private unnamed_addr constant [40 x i8] c"milo: array index out of bounds: %d/%d\\0A\\00"`);
    }

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
      const paramTypes = ext.params.map(p => this.llvmType(p.type));
      if (ext.isVariadic) paramTypes.push("...");
      const params = paramTypes.join(", ");
      const ret = this.llvmType(ext.retType);
      this.output.splice(1, 0, `declare ${ret} @${ext.name}(${params})`);
    }

    // append function bodies
    for (const body of fnBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    return this.output.join("\n") + "\n";
  }

  private genFunction(fn: Function): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals.clear();
    const lines: string[] = [];

    const params = fn.params.map(p => `${this.llvmType(p.type)} %${p.name}`).join(", ");
    const ret = this.llvmType(fn.retType);
    lines.push(`define ${ret} @${fn.name}(${params}) {`);
    lines.push("entry:");

    for (const p of fn.params) {
      const isRef = p.type.isRef || p.type.isRefMut;
      if (isRef) {
        // refs are pointers; store the pointer, track inner type for load/store
        const innerTy = this.llvmTypeFromName(p.type.name);
        lines.push(`  %${p.name}.addr = alloca ptr`);
        lines.push(`  store ptr %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: innerTy, mutable: p.type.isRefMut, isRef: true });
      } else {
        const lt = this.llvmType(p.type);
        lines.push(`  %${p.name}.addr = alloca ${lt}`);
        lines.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
        this.locals.set(p.name, { type: lt, mutable: false, isRef: false });
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

  private genStmt(stmt: Stmt): [string[], boolean] {
    const lines: string[] = [];

    switch (stmt.kind) {
      case "LetDecl":
      case "VarDecl": {
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        const mutable = stmt.kind === "VarDecl";
        this.locals.set(stmt.name, { type: valTy, mutable, isRef: false });
        lines.push(`  %${stmt.name}.addr = alloca ${valTy}`);
        lines.push(`  store ${valTy} ${val}, ptr %${stmt.name}.addr`);
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
      case "IfStmt": return this.genIf(stmt);
      case "WhileStmt": return this.genWhile(stmt);
      case "ExprStmt": {
        const [exprLines] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        return [lines, false];
      }
      case "MatchStmt":
        return this.genMatch(stmt);
    }
  }

  // returns (lines, pointer to the storage location, element type)
  private genLValue(expr: Expr): [string[], string, string] {
    const lines: string[] = [];
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        // ref params: load the pointer
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

  private genBoundsCheckedPtr(expr: Expr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
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

  private genIf(stmt: Stmt & { kind: "IfStmt" }): [string[], boolean] {
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

  private genWhile(stmt: Stmt & { kind: "WhileStmt" }): [string[], boolean] {
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

  private genMatch(stmt: Stmt & { kind: "MatchStmt" }): [string[], boolean] {
    const lines: string[] = [];
    const [subjLines, subjVal, subjTy] = this.genExpr(stmt.subject);
    lines.push(...subjLines);

    // store subject to alloca so we can GEP into it
    const subjAddr = this.nextTemp();
    lines.push(`  ${subjAddr} = alloca ${subjTy}`);
    lines.push(`  store ${subjTy} ${subjVal}, ptr ${subjAddr}`);

    // load tag (field 0)
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const enumName = subjTy.replace(/^%/, "");
    const layout = this.enumLayouts.get(enumName)!;
    const endLabel = this.nextLabel("match.end");
    const defaultLabel = this.nextLabel("match.default");

    // build switch cases
    const armLabels: { tag: number; label: string; arm: typeof stmt.arms[0] }[] = [];
    let wildcardArm: typeof stmt.arms[0] | null = null;
    for (const arm of stmt.arms) {
      if (arm.pattern.kind === "WildcardPattern") {
        wildcardArm = arm;
      } else {
        const variant = layout.variants.get(arm.pattern.variant)!;
        const label = this.nextLabel(`match.${arm.pattern.variant}`);
        armLabels.push({ tag: variant.tag, label, arm });
      }
    }

    const cases = armLabels.map(a => `i32 ${a.tag}, label %${a.label}`).join(" ");
    const defaultTarget = wildcardArm ? this.nextLabel("match.wildcard") : defaultLabel;
    lines.push(`  switch i32 ${tag}, label %${defaultTarget} [${cases}]`);

    // generate each arm
    for (const { label, arm } of armLabels) {
      lines.push(`${label}:`);
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
        const variant = layout.variants.get(arm.pattern.variant)!;
        this.extractBindings(lines, subjAddr, subjTy, variant, arm.pattern.bindings);
      }
      for (const s of arm.body) {
        const [sl] = this.genStmt(s);
        lines.push(...sl);
      }
      lines.push(`  br label %${endLabel}`);
    }

    // wildcard arm
    if (wildcardArm) {
      lines.push(`${defaultTarget}:`);
      for (const s of wildcardArm.body) {
        const [sl] = this.genStmt(s);
        lines.push(...sl);
      }
      lines.push(`  br label %${endLabel}`);
    }

    // default (unreachable if exhaustive)
    if (!wildcardArm) {
      lines.push(`${defaultLabel}:`);
      lines.push(`  unreachable`);
    }

    lines.push(`${endLabel}:`);
    return [lines, false];
  }

  private extractBindings(
    lines: string[], subjAddr: string, subjTy: string,
    variant: { tag: number; fieldTypes: string[] }, bindings: string[],
  ) {
    if (bindings.length === 0) return;
    // get pointer to payload (field 1)
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${subjTy}, ptr ${subjAddr}, i32 0, i32 1`);

    if (bindings.length === 1) {
      // single field: load directly from payload pointer
      const ty = variant.fieldTypes[0];
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${ty}, ptr ${payloadPtr}`);
      lines.push(`  %${bindings[0]}.addr = alloca ${ty}`);
      lines.push(`  store ${ty} ${val}, ptr %${bindings[0]}.addr`);
      this.locals.set(bindings[0], { type: ty, mutable: false, isRef: false });
    } else {
      // multiple fields: use literal struct type for GEP
      const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
      for (let i = 0; i < bindings.length; i++) {
        const ty = variant.fieldTypes[i];
        const fieldPtr = this.nextTemp();
        lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
        lines.push(`  %${bindings[i]}.addr = alloca ${ty}`);
        lines.push(`  store ${ty} ${val}, ptr %${bindings[i]}.addr`);
        this.locals.set(bindings[i], { type: ty, mutable: false, isRef: false });
      }
    }
  }

  private genExpr(expr: Expr): [string[], string, string] {
    const lines: string[] = [];

    switch (expr.kind) {
      case "IntLit":
        return [lines, String(expr.value), "i32"];
      case "FloatLit":
        return [lines, `${expr.value.toExponential()}`, "double"];
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
          // ref: load the pointer, then load the value
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = load ptr, ptr %${expr.name}.addr`);
          // for struct refs, return the pointer (structs are passed by ptr)
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
        const [ll, lv, lt] = this.genExpr(expr.left);
        const [rl, rv] = this.genExpr(expr.right);
        lines.push(...ll, ...rl);
        const tmp = this.nextTemp();
        const isFloat = lt === "float" || lt === "double";
        const intOps: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "sdiv", "%": "srem" };
        const floatOps: Record<string, string> = { "+": "fadd", "-": "fsub", "*": "fmul", "/": "fdiv", "%": "frem" };
        const intCmps: Record<string, string> = { "==": "eq", "!=": "ne", "<": "slt", ">": "sgt", "<=": "sle", ">=": "sge" };
        const floatCmps: Record<string, string> = { "==": "oeq", "!=": "one", "<": "olt", ">": "ogt", "<=": "ole", ">=": "oge" };
        if (expr.op in intOps) {
          const op = isFloat ? floatOps[expr.op] : intOps[expr.op];
          lines.push(`  ${tmp} = ${op} ${lt} ${lv}, ${rv}`);
          return [lines, tmp, lt];
        }
        if (expr.op in intCmps) {
          if (isFloat) lines.push(`  ${tmp} = fcmp ${floatCmps[expr.op]} ${lt} ${lv}, ${rv}`);
          else lines.push(`  ${tmp} = icmp ${intCmps[expr.op]} ${lt} ${lv}, ${rv}`);
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
        const sig = this.fnSigs.get(expr.func);
        const argVals: { val: string; type: string }[] = [];
        for (let i = 0; i < expr.args.length; i++) {
          const paramDef = sig?.params[i];
          const isRefParam = paramDef && (paramDef.type.isRef || paramDef.type.isRefMut);
          if (isRefParam) {
            // auto-borrow: pass pointer to the variable
            const [al, aPtr] = this.genLValueForArg(expr.args[i]);
            lines.push(...al);
            argVals.push({ val: aPtr, type: "ptr" });
          } else {
            const [al, av, at] = this.genExpr(expr.args[i]);
            lines.push(...al);
            argVals.push({ val: av, type: at });
          }
        }
        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = sig?.retType ?? "i32";
        let callPrefix = retTy;
        if (sig?.variadic) {
          const paramStr = sig.paramTypes.join(", ");
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
        // load the whole struct as a value
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${structTy}, ptr ${alloca}`);
        return [lines, val, structTy];
      }
      case "FieldAccess": {
        // get pointer to field, then load
        const [ptrLines, ptr, fieldTy] = this.genFieldPtr(expr);
        lines.push(...ptrLines);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${fieldTy}, ptr ${ptr}`);
        return [lines, val, fieldTy];
      }
      case "ArrayLit": {
        if (expr.elements.length === 0) return [lines, "zeroinitializer", "[0 x i32]"];
        const [firstLines, firstVal, elemTy] = this.genExpr(expr.elements[0]);
        lines.push(...firstLines);
        const arrTy = `[${expr.elements.length} x ${elemTy}]`;
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${arrTy}`);
        // store first element
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
        // ptrLines already pushed into lines
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
        // store tag
        const tagPtr = this.nextTemp();
        lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${alloca}, i32 0, i32 0`);
        lines.push(`  store i32 ${variant.tag}, ptr ${tagPtr}`);
        // store payload fields
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
        // load whole enum value
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${enumTy}, ptr ${alloca}`);
        return [lines, val, enumTy];
      }
    }
  }

  private genFieldPtr(expr: Expr & { kind: "FieldAccess" }): [string[], string, string] {
    const lines: string[] = [];
    // get lvalue of the object
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

  // for auto-borrow: get a pointer to a variable for passing as &T
  private genLValueForArg(expr: Expr): [string[], string] {
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        // already a ref — load the pointer
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
    // fallback: evaluate to a temp, alloca, store, return ptr
    const lines: string[] = [];
    const [el, ev, et] = this.genExpr(expr);
    lines.push(...el);
    const tmp = this.nextTemp();
    lines.push(`  ${tmp} = alloca ${et}`);
    lines.push(`  store ${et} ${ev}, ptr ${tmp}`);
    return [lines, tmp];
  }
}
