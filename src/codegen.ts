import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern } from "./hir";
import { type TypeKind, needsDrop } from "./types";

interface StructLayout {
  name: string;
  fields: { name: string; type: string; typeKind: TypeKind }[];
}

interface EnumLayout {
  name: string;
  payloadSlots: number;
  variants: Map<string, { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }>;
}

export class Codegen {
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, { type: string; typeKind: TypeKind; mutable: boolean; isRef: boolean; addr?: string }>();
  private fnSigs = new Map<string, { paramTypes: string[]; retType: string; variadic: boolean }>();
  private structLayouts = new Map<string, StructLayout>();
  private enumLayouts = new Map<string, EnumLayout>();
  private userDeclaredFns = new Set<string>();
  private needsBoundsCheck = false;
  private needsPrintf = false;
  private needsPutchar = false;
  private needsExit = false;
  private needsMalloc = false;
  private needsFree = false;
  private needsMemcpy = false;
  private needsMemcmp = false;
  private hasStringType = false;
  private hasVecType = false;
  private hasHashMapType = false;
  private needsGetentropy = false;
  private needsStrtod = false;
  private loopHeader: string | null = null;
  private loopExit: string | null = null;
  private droppableLocals: { name: string; typeKind: TypeKind }[] = [];
  private droppableEnums = new Set<string>();
  private dropImpls = new Set<string>();
  private structDropCache = new Map<string, boolean>();
  private generatedDropHelpers = new Set<string>();
  private dropHelperBodies: string[][] = [];
  private closureBodies: string[][] = [];
  private closureCounter = 0;
  private scopeCounter = 0;
  private entryAllocas: string[] = [];
  private static BUILTINS = new Set(["print", "println", "exit"]);

  private nextTemp(): string { return `%t${this.tempCounter++}`; }
  private nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private localAddr(name: string): string { return this.locals.get(name)?.addr ?? `%${name}.addr`; }
  private emit(line: string) { this.output.push(line); }

  private llvmType(t: TypeKind): string {
    switch (t.tag) {
      case "int":    return `i${t.bits}`;
      case "float":  return t.bits === 32 ? "float" : "double";
      case "bool":   return "i1";
      case "void":   return "void";
      case "string": return "%String";
      case "ptr":    return "ptr";
      case "box":    return "ptr";
      case "vec":    return "%Vec";
      case "hashmap": return "%HashMap";
      case "ref":    return "ptr";
      case "struct": return `%${t.name}`;
      case "enum":   return `%${t.name}`;
      case "fn":     return "{ ptr, ptr }";
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
      .replace(/\\/g, "\\5C").replace(/\n/g, "\\0A").replace(/\r/g, "\\0D")
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
    if (ty === "{ ptr, ptr }") return 16;
    if (ty === "%String") return 24; // ptr + i64 + i64
    if (ty === "%Vec") return 24; // ptr + i64 + i64
    if (ty === "%HashMap") return 32; // ptr + i64 + i64 + i64
    const arrMatch = ty.match(/\[(\d+) x (.+)\]/);
    if (arrMatch) return parseInt(arrMatch[1]) * this.typeSize(arrMatch[2]);
    const structName = this.getStructName(ty);
    if (structName) {
      const layout = this.structLayouts.get(structName);
      if (layout) return this.structPayloadSize(layout.fields.map(f => f.type));
    }
    const enumMatch = ty.match(/^%(.+)$/);
    if (enumMatch && this.enumLayouts.has(enumMatch[1])) {
      const layout = this.enumLayouts.get(enumMatch[1])!;
      return 4 + layout.payloadSlots * 8;
    }
    return 8;
  }

  private typeSizeOf(t: TypeKind): number {
    return this.typeSize(this.llvmType(t));
  }

  private needsDropCg(t: TypeKind): boolean {
    if (needsDrop(t)) return true;
    if (t.tag === "enum") return this.droppableEnums.has(t.name);
    if (t.tag === "struct") return this.structNeedsDrop(t.name);
    return false;
  }

  private structNeedsDrop(name: string): boolean {
    if (this.structDropCache.has(name)) return this.structDropCache.get(name)!;
    // guard against recursion (recursive structs use Box, not direct embedding)
    this.structDropCache.set(name, false);
    let result = this.dropImpls.has(name);
    if (!result) {
      const layout = this.structLayouts.get(name);
      if (layout) result = layout.fields.some(f => this.needsDropCg(f.typeKind));
    }
    this.structDropCache.set(name, result);
    return result;
  }

  private needsPanicFmt = false;

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
      const variants = new Map<string, { tag: number; fieldTypes: string[]; fieldTypeKinds: TypeKind[] }>();
      for (const v of e.variants) {
        const fieldTypes = v.fields.map(f => this.llvmType(f));
        const payloadSize = this.structPayloadSize(fieldTypes);
        maxPayload = Math.max(maxPayload, payloadSize);
        variants.set(v.name, { tag: v.tag, fieldTypes, fieldTypeKinds: v.fields });
      }
      this.enumLayouts.set(e.name, {
        name: e.name,
        payloadSlots: Math.ceil(maxPayload / 8),
        variants,
      });
    }

    // store user-defined Drop impls
    this.dropImpls = module.dropImpls;
    this.structDropCache.clear();

    // compute which enums need drop glue
    for (const [name, layout] of this.enumLayouts) {
      for (const [, variant] of layout.variants) {
        if (variant.fieldTypeKinds.some(f => this.needsDropCg(f) || (f.tag === "enum" && f.name === name))) {
          this.droppableEnums.add(name);
          break;
        }
      }
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
    if (this.needsSnprintf && !declaredExterns.has("snprintf"))
      this.output.splice(1, 0, "declare i32 @snprintf(ptr, i64, ptr, ...)");
    if (this.needsStrtod && !declaredExterns.has("strtod"))
      this.output.splice(1, 0, "declare double @strtod(ptr, ptr)");
    if (this.needsMemset && !declaredExterns.has("memset"))
      this.output.splice(1, 0, "declare ptr @memset(ptr, i32, i64)");
    if (this.needsGetentropy && !declaredExterns.has("getentropy"))
      this.output.splice(1, 0, "declare i32 @getentropy(ptr, i64)");
    if (this.needsMemcmp && !declaredExterns.has("memcmp"))
      this.output.splice(1, 0, "declare i32 @memcmp(ptr, ptr, i64)");
    if (this.needsMemcpy && !declaredExterns.has("memcpy"))
      this.output.splice(1, 0, "declare ptr @memcpy(ptr, ptr, i64)");
    if (this.needsFree && !declaredExterns.has("free"))
      this.output.splice(1, 0, "declare void @free(ptr)");
    if (this.needsMalloc && !declaredExterns.has("malloc"))
      this.output.splice(1, 0, "declare ptr @malloc(i64)");
    if (this.needsExit && !declaredExterns.has("exit"))
      this.output.splice(1, 0, "declare void @exit(i32) noreturn");
    if (this.needsPutchar && !declaredExterns.has("putchar"))
      this.output.splice(1, 0, "declare i32 @putchar(i32)");
    if (this.needsPrintf && !declaredExterns.has("printf"))
      this.output.splice(1, 0, `declare i32 @printf(ptr, ...)`);
    if (this.needsBoundsCheck)
      this.output.splice(1, 0, `@.bounds_err = private unnamed_addr constant [40 x i8] c"milo: array index out of bounds: %d/%d\\0A\\00"`);
    if (this.hasHashMapType)
      this.output.splice(1, 0, `%HashMap = type { ptr, i64, i64, i64 }`);
    if (this.hasVecType)
      this.output.splice(1, 0, `%Vec = type { ptr, i64, i64 }`);
    if (this.hasStringType)
      this.output.splice(1, 0, `%String = type { ptr, i64, i64 }`);

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

    // append drop helper functions
    for (const body of this.dropHelperBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    // append closure function bodies
    for (const body of this.closureBodies) {
      this.emit("");
      for (const line of body) this.emit(line);
    }

    return this.output.join("\n") + "\n";
  }

  private genFunction(fn: HIRFunction): string[] {
    this.tempCounter = 0;
    this.labelCounter = 0;
    this.locals.clear();
    this.droppableLocals = [];
    this.entryAllocas = [];
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
        if (this.needsDropCg(p.type)) this.droppableLocals.push({ name: p.name, typeKind: p.type });
      }
    }

    const allocaInsertPoint = lines.length;

    let hasTerminator = false;
    for (const stmt of fn.body) {
      const [stmtLines, terminated] = this.genStmt(stmt);
      lines.push(...stmtLines);
      if (terminated) hasTerminator = true;
    }

    if (!hasTerminator) {
      this.emitDropGlue(lines);
      if (ret === "void") lines.push("  ret void");
      else if (ret === "i32") lines.push("  ret i32 0");
    }

    // hoist body allocas to entry block
    if (this.entryAllocas.length > 0) {
      lines.splice(allocaInsertPoint, 0, ...this.entryAllocas);
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
        const addrName = this.locals.has(stmt.name) ? `%${stmt.name}.${this.scopeCounter++}.addr` : `%${stmt.name}.addr`;
        this.locals.set(stmt.name, { type: declTy, typeKind: stmt.type, mutable: stmt.mutable, isRef: false, addr: addrName });
        this.entryAllocas.push(`  ${addrName} = alloca ${declTy}`);
        // Zero-init droppable allocas so a drop-glue pass over a never-initialized
        // branch-local (e.g. `let s` inside an `if` that wasn't taken) reads cap=0 and skips free.
        if (this.needsDropCg(stmt.type)) {
          this.entryAllocas.push(`  store ${declTy} zeroinitializer, ptr ${addrName}`);
        }
        lines.push(`  store ${declTy} ${val}, ptr ${addrName}`);
        if (this.needsDropCg(stmt.type)) this.droppableLocals.push({ name: stmt.name, typeKind: stmt.type });
        return [lines, false];
      }
      case "Assign": {
        const [valLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...valLines);
        const [targetLines, targetPtr, targetTy] = this.genLValue(stmt.target);
        lines.push(...targetLines);
        if (stmt.target.kind === "Ident" && this.needsDropCg(stmt.target.type)) {
          this.emitDropValue(lines, targetPtr, stmt.target.type);
        }
        lines.push(`  store ${valTy} ${val}, ptr ${targetPtr}`);
        return [lines, false];
      }
      case "Return": {
        if (!stmt.value) {
          this.emitDropGlue(lines);
          lines.push("  ret void");
          return [lines, true];
        }
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        this.emitDropGlue(lines);
        lines.push(`  ret ${valTy} ${val}`);
        return [lines, true];
      }
      case "If": return this.genIf(stmt);
      case "While": return this.genWhile(stmt);
      case "Break":
        if (this.loopExit) lines.push(`  br label %${this.loopExit}`);
        return [lines, true];
      case "Continue":
        if (this.loopHeader) lines.push(`  br label %${this.loopHeader}`);
        return [lines, true];
      case "ExprStmt": {
        const [exprLines] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        return [lines, false];
      }
      case "Match":
        return this.genMatch(stmt);
      case "UnsafeBlock": {
        let terminated = false;
        for (const s of stmt.body) {
          const [sl, st] = this.genStmt(s);
          lines.push(...sl);
          if (st) { terminated = true; break; }
        }
        return [lines, terminated];
      }
    }
  }

  private genLValue(expr: HIRExpr): [string[], string, string] {
    const lines: string[] = [];
    if (expr.kind === "Ident") {
      const local = this.locals.get(expr.name);
      if (local?.isRef) {
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ptr, ptr ${this.localAddr(expr.name)}`);
        return [lines, tmp, local.type];
      }
      return [lines, this.localAddr(expr.name), local?.type ?? "i32"];
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
      if (expr.object.type.tag === "ptr") {
        const [objLines, objVal] = this.genExpr(expr.object);
        lines.push(...objLines);
        const [idxLines, idxVal] = this.genExpr(expr.index);
        lines.push(...idxLines);
        const elemTy = this.llvmType(expr.type);
        const gep = this.nextTemp();
        lines.push(`  ${gep} = getelementptr ${elemTy}, ptr ${objVal}, i64 ${idxVal}`);
        return [lines, gep, elemTy];
      }
      if (expr.object.type.tag === "vec") {
        return this.genVecBoundsCheckedPtr(expr, lines);
      }
      return this.genBoundsCheckedPtr(expr, lines);
    }
    if (expr.kind === "PtrDeref") {
      const [ptrLines, ptrVal] = this.genExpr(expr.operand);
      lines.push(...ptrLines);
      const innerTy = this.llvmType(expr.type);
      return [lines, ptrVal, innerTy];
    }
    if (expr.kind === "BoxDeref") {
      const [ptrLines, ptrVal] = this.genExpr(expr.operand);
      lines.push(...ptrLines);
      const innerTy = this.llvmType(expr.type);
      return [lines, ptrVal, innerTy];
    }
    return [lines, "null", "i32"];
  }

  private genBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    const [objLines, objPtr, objTy] = this.genLValue(expr.object);
    lines.push(...objLines);
    const [idxLines, idxVal, idxTy] = this.genExpr(expr.index);
    lines.push(...idxLines);

    const match = objTy.match(/\[(\d+) x (.+)\]/);
    if (match) {
      const size = parseInt(match[1]);
      const elemTy = match[2];
      // truncate i64 index to i32 for bounds check and GEP
      let idx32 = idxVal;
      if (idxTy === "i64") {
        idx32 = this.nextTemp();
        lines.push(`  ${idx32} = trunc i64 ${idxVal} to i32`);
      }
      this.emitBoundsCheck(lines, idx32, String(size));
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = getelementptr ${objTy}, ptr ${objPtr}, i32 0, i32 ${idx32}`);
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
    // when both arms return/diverge, the merge block is unreachable; LLVM still requires a terminator
    if (thenTerminated && elseTerminated) lines.push(`  unreachable`);
    return [lines, thenTerminated && elseTerminated];
  }

  private genWhile(stmt: HIRStmt & { kind: "While" }): [string[], boolean] {
    const lines: string[] = [];
    const condLabel = this.nextLabel("while.cond");
    const bodyLabel = this.nextLabel("while.body");
    const endLabel = this.nextLabel("while.end");
    const prevHeader = this.loopHeader;
    const prevExit = this.loopExit;
    this.loopHeader = condLabel;
    this.loopExit = endLabel;
    lines.push(`  br label %${condLabel}`);
    lines.push(`${condLabel}:`);
    const [condLines, condVal] = this.genExpr(stmt.cond);
    lines.push(...condLines);
    lines.push(`  br i1 ${condVal}, label %${bodyLabel}, label %${endLabel}`);
    lines.push(`${bodyLabel}:`);
    let bodyTerminated = false;
    for (const s of stmt.body) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) { bodyTerminated = true; break; }
    }
    if (!bodyTerminated) lines.push(`  br label %${condLabel}`);
    lines.push(`${endLabel}:`);
    this.loopHeader = prevHeader;
    this.loopExit = prevExit;
    return [lines, false];
  }

  private genMatch(stmt: HIRStmt & { kind: "Match" }): [string[], boolean] {
    const lines: string[] = [];
    // Subject-source direct path: matching `match *box` writes the "zero payload after
    // extraction" stores into the actual Box heap, not a staged copy. Without this, the
    // staged copy + the source both end up owning the same field heaps and double-free
    // when each drops independently.
    let subjAddr: string;
    let subjTy: string;
    if (stmt.subject.kind === "BoxDeref" && stmt.subject.operand.kind === "Ident") {
      // Only handle the simple `match *ident` form; anything more complex falls through
      // to the staged copy path (genExpr would synthesize an undef-laden ptr otherwise).
      const [boxLines, boxVal] = this.genExpr(stmt.subject.operand);
      lines.push(...boxLines);
      subjAddr = boxVal;
      subjTy = this.llvmType(stmt.subject.type);
    } else if (stmt.subject.kind === "Ident" && this.locals.has(stmt.subject.name)) {
      const local = this.locals.get(stmt.subject.name)!;
      subjAddr = this.localAddr(stmt.subject.name);
      subjTy = local.type;
    } else {
      const [subjLines, subjVal, subjTyL] = this.genExpr(stmt.subject);
      lines.push(...subjLines);
      subjAddr = this.nextTemp();
      subjTy = subjTyL;
      lines.push(`  ${subjAddr} = alloca ${subjTy}`);
      lines.push(`  store ${subjTy} ${subjVal}, ptr ${subjAddr}`);
    }

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

    let allArmsTerminated = true;
    for (const { label, arm } of armLabels) {
      lines.push(`${label}:`);
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.length > 0) {
        const variant = layout.variants.get(arm.pattern.variant)!;
        this.extractBindings(lines, subjAddr, subjTy, variant, arm.pattern);
      }
      let armTerminated = false;
      for (const s of arm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { armTerminated = true; break; }
      }
      if (!armTerminated) lines.push(`  br label %${endLabel}`);
      if (!armTerminated) allArmsTerminated = false;
    }

    if (wildcardArm) {
      lines.push(`${defaultTarget}:`);
      let wcTerminated = false;
      for (const s of wildcardArm.body) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) { wcTerminated = true; break; }
      }
      if (!wcTerminated) lines.push(`  br label %${endLabel}`);
      if (!wcTerminated) allArmsTerminated = false;
    }

    if (!wildcardArm) {
      lines.push(`${defaultLabel}:`);
      lines.push(`  unreachable`);
    }

    lines.push(`${endLabel}:`);
    if (allArmsTerminated) lines.push(`  unreachable`);
    return [lines, allArmsTerminated];
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
      const fieldKind = pattern.bindings[0].type;
      const val = this.nextTemp();
      lines.push(`  ${val} = load ${ty}, ptr ${payloadPtr}`);
      // Move semantics: binding consumes the payload. Zero the source so the subject's
      // drop chain doesn't free the same heap data the binding now owns.
      if (this.needsDropCg(fieldKind)) {
        lines.push(`  store ${ty} zeroinitializer, ptr ${payloadPtr}`);
      }
      const uid = this.labelCounter++;
      const addr = `%${pattern.bindings[0].name}.${uid}.addr`;
      lines.push(`  ${addr} = alloca ${ty}`);
      lines.push(`  store ${ty} ${val}, ptr ${addr}`);
      this.locals.set(pattern.bindings[0].name, { type: ty, typeKind: fieldKind, mutable: false, isRef: false, addr });
    } else {
      const payloadStructTy = `{ ${variant.fieldTypes.join(", ")} }`;
      for (let i = 0; i < pattern.bindings.length; i++) {
        const ty = variant.fieldTypes[i];
        const fieldKind = pattern.bindings[i].type;
        const fieldPtr = this.nextTemp();
        lines.push(`  ${fieldPtr} = getelementptr ${payloadStructTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${ty}, ptr ${fieldPtr}`);
        if (this.needsDropCg(fieldKind)) {
          lines.push(`  store ${ty} zeroinitializer, ptr ${fieldPtr}`);
        }
        const uid = this.labelCounter++;
        const addr = `%${pattern.bindings[i].name}.${uid}.addr`;
        lines.push(`  ${addr} = alloca ${ty}`);
        lines.push(`  store ${ty} ${val}, ptr ${addr}`);
        this.locals.set(pattern.bindings[i].name, { type: ty, typeKind: fieldKind, mutable: false, isRef: false, addr });
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
        if (at === "%String") {
          // coerce String → ptr (extract data pointer) for printf
          const dataPtr = this.nextTemp();
          lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
          argVals.push({ val: dataPtr, type: "ptr" });
        } else {
          argVals.push({ val: av, type: at });
        }
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
      case "FloatLit": {
        // LLVM needs hex float for exact representation
        const buf = new ArrayBuffer(8);
        new Float64Array(buf)[0] = expr.value;
        const hex = [...new Uint8Array(buf)].reverse().map(b => b.toString(16).padStart(2, "0")).join("");
        return [lines, `0x${hex.toUpperCase()}`, lt];
      }
      case "BoolLit":
        return [lines, expr.value ? "1" : "0", "i1"];
      case "StringLit": {
        this.hasStringType = true;
        const { label, length } = this.addString(expr.value);
        const strLen = length - 1; // exclude null terminator
        const ptr = this.nextTemp();
        lines.push(`  ${ptr} = getelementptr [${length} x i8], ptr ${label}, i32 0, i32 0`);
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %String undef, ptr ${ptr}, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${strLen}, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %String ${s1}, i64 0, 2`);
        return [lines, s2, "%String"];
      }
      case "Ident": {
        const local = this.locals.get(expr.name);
        if (!local) {
          // named function used as value — generate trampoline with closure calling convention
          if (this.fnSigs.has(expr.name)) {
            const sig = this.fnSigs.get(expr.name)!;
            const trampolineName = `__trampoline_${expr.name}`;
            if (!this.fnSigs.has(trampolineName)) {
              const paramNames = sig.paramTypes.map((_, i) => `p${i}`);
              const trampolineParams = [`ptr %env`, ...sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`)].join(", ");
              const fwdArgs = sig.paramTypes.map((t, i) => `${t} %${paramNames[i]}`).join(", ");
              const body: string[] = [];
              body.push(`define ${sig.retType} @${trampolineName}(${trampolineParams}) {`);
              body.push("entry:");
              if (sig.retType === "void") {
                body.push(`  call void @${expr.name}(${fwdArgs})`);
                body.push("  ret void");
              } else {
                body.push(`  %r = call ${sig.retType} @${expr.name}(${fwdArgs})`);
                body.push(`  ret ${sig.retType} %r`);
              }
              body.push("}");
              this.closureBodies.push(body);
              this.fnSigs.set(trampolineName, sig);
            }
            const alloca = this.nextTemp();
            lines.push(`  ${alloca} = alloca { ptr, ptr }`);
            const fpSlot = this.nextTemp();
            lines.push(`  ${fpSlot} = getelementptr { ptr, ptr }, ptr ${alloca}, i32 0, i32 0`);
            lines.push(`  store ptr @${trampolineName}, ptr ${fpSlot}`);
            const envSlot = this.nextTemp();
            lines.push(`  ${envSlot} = getelementptr { ptr, ptr }, ptr ${alloca}, i32 0, i32 1`);
            lines.push(`  store ptr null, ptr ${envSlot}`);
            const val = this.nextTemp();
            lines.push(`  ${val} = load { ptr, ptr }, ptr ${alloca}`);
            return [lines, val, "{ ptr, ptr }"];
          }
          console.error(`error[codegen]: undefined variable '${expr.name}'`); process.exit(1);
        }
        if (local.isRef) {
          const ptr = this.nextTemp();
          lines.push(`  ${ptr} = load ptr, ptr ${this.localAddr(expr.name)}`);
          if (this.getStructName(local.type)) return [lines, ptr, local.type];
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${local.type}, ptr ${ptr}`);
          return [lines, val, local.type];
        }
        const addr = this.localAddr(expr.name);
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = load ${local.type}, ptr ${addr}`);
        if (expr.isMove && this.needsDropCg(local.typeKind)) {
          lines.push(`  store ${local.type} zeroinitializer, ptr ${addr}`);
        }
        return [lines, tmp, local.type];
      }
      case "CharLit": {
        return [lines, String(expr.value), "i8"];
      }
      case "BinOp": {
        if (expr.op === "&&" || expr.op === "||") {
          return this.genShortCircuit(expr, lines);
        }
        const [ll, lv, llt] = this.genExpr(expr.left);
        const [rl, rv] = this.genExpr(expr.right);
        lines.push(...ll, ...rl);

        if (llt === "%String") {
          if (expr.op === "+") return this.genStringConcat(lines, lv, rv);
          if (expr.op === "==" || expr.op === "!=") return this.genStringCmp(lines, lv, rv, expr.op === "==");
        }

        // enum equality: compare tag field only (checker rejects payload-bearing enums)
        if ((expr.op === "==" || expr.op === "!=") && llt.startsWith("%") && this.enumLayouts.has(llt.slice(1))) {
          const lTag = this.nextTemp();
          const rTag = this.nextTemp();
          const cmp = this.nextTemp();
          lines.push(`  ${lTag} = extractvalue ${llt} ${lv}, 0`);
          lines.push(`  ${rTag} = extractvalue ${llt} ${rv}, 0`);
          lines.push(`  ${cmp} = icmp ${expr.op === "==" ? "eq" : "ne"} i32 ${lTag}, ${rTag}`);
          return [lines, cmp, "i1"];
        }

        const tmp = this.nextTemp();
        const isFloat = llt === "float" || llt === "double";
        const unsigned = !isFloat && this.isUnsigned(expr.left.type);
        const intOps: Record<string, string> = unsigned
          ? { "+": "add", "-": "sub", "*": "mul", "/": "udiv", "%": "urem", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "lshr" }
          : { "+": "add", "-": "sub", "*": "mul", "/": "sdiv", "%": "srem", "&": "and", "|": "or", "^": "xor", "<<": "shl", ">>": "ashr" };
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
        if (expr.op === "~") { lines.push(`  ${tmp} = xor ${ot} ${ov}, -1`); return [lines, tmp, ot]; }
        console.error(`error[codegen]: unknown unary op '${expr.op}'`); process.exit(1);
      }
      case "Call": {
        if (Codegen.BUILTINS.has(expr.func) && !this.userDeclaredFns.has(expr.func)) {
          return this.genBuiltinCall(expr, lines);
        }
        const sig = this.fnSigs.get(expr.func);
        const argVals: { val: string; type: string }[] = [];
        for (let i = 0; i < expr.args.length; i++) {
          const arg = expr.args[i];
          if (arg.passByRef) {
            const [al, aPtr] = this.genLValueForArg(arg.expr);
            lines.push(...al);
            argVals.push({ val: aPtr, type: "ptr" });
          } else {
            // [T; N] → *T decay: pass the array's address as a ptr
            const argTk = arg.expr.type;
            const paramExpectsPtr = sig && i < sig.paramTypes.length && sig.paramTypes[i] === "ptr";
            if (argTk.tag === "array" && paramExpectsPtr) {
              const [al, aPtr] = this.genLValueForArg(arg.expr);
              lines.push(...al);
              argVals.push({ val: aPtr, type: "ptr" });
              continue;
            }
            const [al, av, at] = this.genExpr(arg.expr);
            lines.push(...al);
            // String → ptr coercion for extern/FFI calls (including variadic args)
            if (at === "%String" && sig && (i >= sig.paramTypes.length || sig.paramTypes[i] === "ptr")) {
              const dataPtr = this.nextTemp();
              lines.push(`  ${dataPtr} = extractvalue %String ${av}, 0`);
              argVals.push({ val: dataPtr, type: "ptr" });
            } else {
              argVals.push({ val: av, type: at });
            }
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
        const objType = expr.object.type;
        if (objType.tag === "array" && objType.size !== null) {
          return [lines, String(objType.size), "i32"];
        }
        return [lines, "0", "i32"];
      }
      case "StringLen": {
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
        return [lines, len, "i64"];
      }
      case "ArrayLit": {
        // Vec literal: `[a, b, c]` with Vec<T> type hint. Emit malloc + N stores, build %Vec struct.
        if (expr.type.tag === "vec") {
          this.hasVecType = true;
          const vecElemTy = this.llvmType(expr.type.element);
          const n = expr.elements.length;
          if (n === 0) {
            const s0 = this.nextTemp();
            lines.push(`  ${s0} = insertvalue %Vec undef, ptr null, 0`);
            const s1 = this.nextTemp();
            lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 0, 1`);
            const s2 = this.nextTemp();
            lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
            return [lines, s2, "%Vec"];
          }
          this.needsMalloc = true;
          const elemSize = this.typeSizeOf(expr.type.element);
          const bytes = n * elemSize;
          const buf = this.nextTemp();
          lines.push(`  ${buf} = call ptr @malloc(i64 ${bytes})`);
          for (let i = 0; i < n; i++) {
            const [el, ev] = this.genExpr(expr.elements[i]);
            lines.push(...el);
            const pi = this.nextTemp();
            lines.push(`  ${pi} = getelementptr ${vecElemTy}, ptr ${buf}, i64 ${i}`);
            lines.push(`  store ${vecElemTy} ${ev}, ptr ${pi}`);
          }
          const v0 = this.nextTemp();
          lines.push(`  ${v0} = insertvalue %Vec undef, ptr ${buf}, 0`);
          const v1 = this.nextTemp();
          lines.push(`  ${v1} = insertvalue %Vec ${v0}, i64 ${n}, 1`);
          const v2 = this.nextTemp();
          lines.push(`  ${v2} = insertvalue %Vec ${v1}, i64 ${n}, 2`);
          return [lines, v2, "%Vec"];
        }
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
      case "ArrayRepeat": {
        const elemTy = this.llvmType(expr.type.tag === "array" ? expr.type.element : { tag: "int", bits: 32, signed: true });
        const arrTy = `[${expr.count} x ${elemTy}]`;
        const [vl, vv] = this.genExpr(expr.value);
        lines.push(...vl);
        if (vv === "0" || vv === "0.0" || vv === "false") {
          return [lines, "zeroinitializer", arrTy];
        }
        const alloca = this.nextTemp();
        lines.push(`  ${alloca} = alloca ${arrTy}`);
        for (let i = 0; i < expr.count; i++) {
          const pi = this.nextTemp();
          lines.push(`  ${pi} = getelementptr ${arrTy}, ptr ${alloca}, i32 0, i32 ${i}`);
          lines.push(`  store ${elemTy} ${vv}, ptr ${pi}`);
        }
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${arrTy}, ptr ${alloca}`);
        return [lines, val, arrTy];
      }
      case "IndexAccess": {
        if (expr.object.type.tag === "string") {
          return this.genStringIndex(expr, lines);
        }
        if (expr.object.type.tag === "ptr") {
          const [objLines, objVal] = this.genExpr(expr.object);
          lines.push(...objLines);
          const [idxLines, idxVal] = this.genExpr(expr.index);
          lines.push(...idxLines);
          const elemTy = this.llvmType(expr.type);
          const gep = this.nextTemp();
          lines.push(`  ${gep} = getelementptr ${elemTy}, ptr ${objVal}, i64 ${idxVal}`);
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${elemTy}, ptr ${gep}`);
          return [lines, val, elemTy];
        }
        if (expr.object.type.tag === "vec") {
          const [ptrLines, ptr, elemTy] = this.genVecBoundsCheckedPtr(expr, lines);
          const val = this.nextTemp();
          lines.push(`  ${val} = load ${elemTy}, ptr ${ptr}`);
          if (expr.isMove && this.needsDropCg(expr.object.type.element)) {
            lines.push(`  store ${elemTy} zeroinitializer, ptr ${ptr}`);
          }
          return [lines, val, elemTy];
        }
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
      case "Unwrap":
        return this.genUnwrap(expr, lines);
      case "Propagate":
        return this.genPropagate(expr, lines);
      case "DefaultValue":
        return this.genDefaultValue(expr, lines);
      case "Cast":
        return this.genCast(expr, lines);
      case "BoxCreate": {
        this.needsMalloc = true;
        const [valLines, valVal, valTy] = this.genExpr(expr.value);
        lines.push(...valLines);
        const size = this.typeSizeOf(expr.value.type);
        const ptr = this.nextTemp();
        lines.push(`  ${ptr} = call ptr @malloc(i64 ${size})`);
        lines.push(`  store ${valTy} ${valVal}, ptr ${ptr}`);
        return [lines, ptr, "ptr"];
      }
      case "BoxDeref":
      case "PtrDeref": {
        const [ptrLines, ptrVal] = this.genExpr(expr.operand);
        lines.push(...ptrLines);
        const innerTy = this.llvmType(expr.type);
        const val = this.nextTemp();
        lines.push(`  ${val} = load ${innerTy}, ptr ${ptrVal}`);
        return [lines, val, innerTy];
      }
      case "VecNew": {
        this.hasVecType = true;
        const s0 = this.nextTemp();
        lines.push(`  ${s0} = insertvalue %Vec undef, ptr null, 0`);
        const s1 = this.nextTemp();
        lines.push(`  ${s1} = insertvalue %Vec ${s0}, i64 0, 1`);
        const s2 = this.nextTemp();
        lines.push(`  ${s2} = insertvalue %Vec ${s1}, i64 0, 2`);
        return [lines, s2, "%Vec"];
      }
      case "VecPush":
        return this.genVecPush(expr, lines);
      case "VecPop":
        return this.genVecPop(expr, lines);
      case "VecLen": {
        this.hasVecType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %Vec ${ov}, 1`);
        return [lines, len, "i64"];
      }
      case "HashMapNew":
        return this.genHashMapNew(expr, lines);
      case "HashMapInsert":
        return this.genHashMapInsert(expr, lines);
      case "HashMapGet":
        return this.genHashMapGet(expr, lines);
      case "HashMapContains":
        return this.genHashMapContains(expr, lines);
      case "HashMapRemove":
        return this.genHashMapRemove(expr, lines);
      case "HashMapLen": {
        this.hasHashMapType = true;
        const [ol, ov] = this.genExpr(expr.object);
        lines.push(...ol);
        const len = this.nextTemp();
        lines.push(`  ${len} = extractvalue %HashMap ${ov}, 1`);
        return [lines, len, "i64"];
      }
      case "StringPush":
        return this.genStringPush(expr, lines);
      case "StringSubstr":
        return this.genStringSubstr(expr, lines);
      case "StringParseF64":
        return this.genStringParseF64(expr, lines);
      case "StringClone":
        return this.genStringClone(expr, lines);
      case "NumberToString":
        return this.genNumberToString(expr, lines);
      case "JsonStringify":
        return this.genJsonStringify(expr, lines);
      case "Closure": {
        const closureName = `__closure_${this.closureCounter++}`;
        const captures = expr.captures;
        const retTy = this.llvmType(expr.retType);

        // build env struct type: { ptr, ptr, ... } — one ptr per capture
        const envStructTy = captures.length > 0
          ? `{ ${captures.map(() => "ptr").join(", ")} }`
          : "{}";

        // save codegen state
        const savedTemp = this.tempCounter;
        const savedLabel = this.labelCounter;
        const savedLocals = this.locals;
        const savedDroppable = this.droppableLocals;
        const savedLoopHeader = this.loopHeader;
        const savedLoopExit = this.loopExit;
        const savedEntryAllocas = this.entryAllocas;
        this.tempCounter = 0;
        this.labelCounter = 0;
        this.locals = new Map();
        this.droppableLocals = [];
        this.entryAllocas = [];
        this.loopHeader = null;
        this.loopExit = null;

        // generate closure function: @__closure_N(ptr %env, params...)
        const closureBody: string[] = [];
        const closureParams = [`ptr %env`, ...expr.params.map(p => `${this.llvmType(p.type)} %${p.name}`)].join(", ");
        closureBody.push(`define ${retTy} @${closureName}(${closureParams}) {`);
        closureBody.push("entry:");

        // load captures from env struct
        for (let i = 0; i < captures.length; i++) {
          const cap = captures[i];
          const capTy = this.llvmType(cap.type);
          const gepPtr = this.nextTemp();
          closureBody.push(`  ${gepPtr} = getelementptr ${envStructTy}, ptr %env, i32 0, i32 ${i}`);
          const loadedPtr = this.nextTemp();
          closureBody.push(`  ${loadedPtr} = load ptr, ptr ${gepPtr}`);
          // the capture is a pointer to the original variable's alloca
          this.locals.set(cap.name, { type: capTy, typeKind: cap.type, mutable: cap.mutable, isRef: true, addr: `${gepPtr}.ref` });
          closureBody.push(`  ${gepPtr}.ref = alloca ptr`);
          closureBody.push(`  store ptr ${loadedPtr}, ptr ${gepPtr}.ref`);
        }

        // set up params
        for (const p of expr.params) {
          const lt = this.llvmType(p.type);
          const isRefParam = p.type.tag === "ref";
          closureBody.push(`  %${p.name}.addr = alloca ${lt}`);
          closureBody.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
          this.locals.set(p.name, { type: lt, typeKind: p.type, mutable: false, isRef: isRefParam });
        }

        // generate body
        const closureAllocaInsertPoint = closureBody.length;
        let hasTerminator = false;
        for (const stmt of expr.body) {
          const [stmtLines, terminated] = this.genStmt(stmt);
          closureBody.push(...stmtLines);
          if (terminated) hasTerminator = true;
        }
        if (!hasTerminator) {
          if (retTy === "void") closureBody.push("  ret void");
          else closureBody.push(`  ret ${retTy} 0`);
        }
        if (this.entryAllocas.length > 0) {
          closureBody.splice(closureAllocaInsertPoint, 0, ...this.entryAllocas);
        }
        closureBody.push("}");
        this.closureBodies.push(closureBody);

        // restore codegen state
        this.tempCounter = savedTemp;
        this.labelCounter = savedLabel;
        this.locals = savedLocals;
        this.droppableLocals = savedDroppable;
        this.entryAllocas = savedEntryAllocas;
        this.loopHeader = savedLoopHeader;
        this.loopExit = savedLoopExit;

        // at the call site: build env struct and closure pair
        if (captures.length > 0) {
          const envAddr = this.nextTemp();
          lines.push(`  ${envAddr} = alloca ${envStructTy}`);
          for (let i = 0; i < captures.length; i++) {
            const cap = captures[i];
            const capAddr = this.localAddr(cap.name);
            const local = this.locals.get(cap.name);
            const gepSlot = this.nextTemp();
            lines.push(`  ${gepSlot} = getelementptr ${envStructTy}, ptr ${envAddr}, i32 0, i32 ${i}`);
            if (local?.isRef) {
              // variable is already a ref (ptr to ptr) — load the inner ptr
              const innerPtr = this.nextTemp();
              lines.push(`  ${innerPtr} = load ptr, ptr ${capAddr}`);
              lines.push(`  store ptr ${innerPtr}, ptr ${gepSlot}`);
            } else {
              // variable is a value — store pointer to its alloca
              lines.push(`  store ptr ${capAddr}, ptr ${gepSlot}`);
            }
          }
          // build { ptr fn_ptr, ptr env_ptr }
          const closurePair = this.nextTemp();
          lines.push(`  ${closurePair} = insertvalue { ptr, ptr } undef, ptr @${closureName}, 0`);
          const closurePair2 = this.nextTemp();
          lines.push(`  ${closurePair2} = insertvalue { ptr, ptr } ${closurePair}, ptr ${envAddr}, 1`);
          return [lines, closurePair2, "{ ptr, ptr }"];
        } else {
          const closurePair = this.nextTemp();
          lines.push(`  ${closurePair} = insertvalue { ptr, ptr } undef, ptr @${closureName}, 0`);
          const closurePair2 = this.nextTemp();
          lines.push(`  ${closurePair2} = insertvalue { ptr, ptr } ${closurePair}, ptr null, 1`);
          return [lines, closurePair2, "{ ptr, ptr }"];
        }
      }
      case "ClosureCall": {
        // load the { fn_ptr, env_ptr } pair from the callee
        const [calLines, calVal] = this.genExpr(expr.callee);
        lines.push(...calLines);
        const fnPtr = this.nextTemp();
        lines.push(`  ${fnPtr} = extractvalue { ptr, ptr } ${calVal}, 0`);
        const envPtr = this.nextTemp();
        lines.push(`  ${envPtr} = extractvalue { ptr, ptr } ${calVal}, 1`);

        // evaluate args
        const argVals: { val: string; type: string }[] = [{ val: envPtr, type: "ptr" }];
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
        const retTy = this.llvmType(expr.type);
        if (retTy === "void") {
          lines.push(`  call void ${fnPtr}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const result = this.nextTemp();
        lines.push(`  ${result} = call ${retTy} ${fnPtr}(${argsStr})`);
        return [lines, result, retTy];
      }
    }
  }

  private genUnwrap(expr: HIRExpr & { kind: "Unwrap" }, lines: string[]): [string[], string, string] {
    this.needsPrintf = true;
    this.needsExit = true;
    const [ol, ov, ot] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = this.enumLayouts.get(expr.enumName)!;
    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);

    // store enum value, extract tag
    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    // Some/Ok is always tag 0
    const okLabel = this.nextLabel("unwrap.ok");
    const panicLabel = this.nextLabel("unwrap.panic");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${okLabel}, label %${panicLabel}`);

    // panic branch
    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const errMsg = `unwrap failed at ${span?.line ?? 0}:${span?.col ?? 0}`;
    const { label: errLabel, length: errLen } = this.addString(errMsg);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    lines.push(`  call i32 @putchar(i32 10)`);
    this.needsPutchar = true;
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);

    // ok branch — extract payload
    lines.push(`${okLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    return [lines, result, resultTy];
  }

  private genPropagate(expr: HIRExpr & { kind: "Propagate" }, lines: string[]): [string[], string, string] {
    const [ol, ov, ot] = this.genExpr(expr.operand);
    lines.push(...ol);

    const layout = this.enumLayouts.get(expr.enumName)!;
    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);
    const retTy = this.llvmType(expr.retType);

    // store enum value, extract tag
    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    // Some/Ok is tag 0
    const okLabel = this.nextLabel("prop.ok");
    const errLabel = this.nextLabel("prop.err");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${okLabel}, label %${errLabel}`);

    // error branch — return the enum as-is (early return)
    lines.push(`${errLabel}:`);
    lines.push(`  ret ${retTy} ${ov}`);

    // ok branch — extract payload
    lines.push(`${okLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load ${resultTy}, ptr ${payloadPtr}`);
    return [lines, result, resultTy];
  }

  private genDefaultValue(expr: HIRExpr & { kind: "DefaultValue" }, lines: string[]): [string[], string, string] {
    const [ol, ov] = this.genExpr(expr.operand);
    lines.push(...ol);

    const enumTy = `%${expr.enumName}`;
    const resultTy = this.llvmType(expr.type);

    const enumAddr = this.nextTemp();
    lines.push(`  ${enumAddr} = alloca ${enumTy}`);
    lines.push(`  store ${enumTy} ${ov}, ptr ${enumAddr}`);
    const tagPtr = this.nextTemp();
    lines.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 0`);
    const tag = this.nextTemp();
    lines.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const someLabel = this.nextLabel("default.some");
    const noneLabel = this.nextLabel("default.none");
    const doneLabel = this.nextLabel("default.done");
    const cmp = this.nextTemp();
    lines.push(`  ${cmp} = icmp eq i32 ${tag}, 0`);
    lines.push(`  br i1 ${cmp}, label %${someLabel}, label %${noneLabel}`);

    // some branch — extract payload
    lines.push(`${someLabel}:`);
    const payloadPtr = this.nextTemp();
    lines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr ${enumAddr}, i32 0, i32 1`);
    const someVal = this.nextTemp();
    lines.push(`  ${someVal} = load ${resultTy}, ptr ${payloadPtr}`);
    lines.push(`  br label %${doneLabel}`);

    // none branch — use default
    lines.push(`${noneLabel}:`);
    const [dl, dv] = this.genExpr(expr.default);
    lines.push(...dl);
    lines.push(`  br label %${doneLabel}`);

    // merge with phi
    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${resultTy} [${someVal}, %${someLabel}], [${dv}, %${noneLabel}]`);
    return [lines, result, resultTy];
  }

  private genShortCircuit(expr: HIRExpr & { kind: "BinOp" }, lines: string[]): [string[], string, string] {
    const isAnd = expr.op === "&&";
    const resultAddr = this.nextTemp();
    lines.push(`  ${resultAddr} = alloca i1`);
    const [ll, lv] = this.genExpr(expr.left);
    lines.push(...ll);
    lines.push(`  store i1 ${lv}, ptr ${resultAddr}`);
    const rhsLabel = this.nextLabel(isAnd ? "and.rhs" : "or.rhs");
    const endLabel = this.nextLabel(isAnd ? "and.end" : "or.end");
    if (isAnd) {
      lines.push(`  br i1 ${lv}, label %${rhsLabel}, label %${endLabel}`);
    } else {
      lines.push(`  br i1 ${lv}, label %${endLabel}, label %${rhsLabel}`);
    }
    lines.push(`${rhsLabel}:`);
    const [rl, rv] = this.genExpr(expr.right);
    lines.push(...rl);
    lines.push(`  store i1 ${rv}, ptr ${resultAddr}`);
    lines.push(`  br label %${endLabel}`);
    lines.push(`${endLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = load i1, ptr ${resultAddr}`);
    return [lines, result, "i1"];
  }

  private genCast(expr: HIRExpr & { kind: "Cast" }, lines: string[]): [string[], string, string] {
    const fromKind = expr.operand.type;
    const toKind = expr.targetType;
    const toTy = this.llvmType(expr.targetType);
    // array → ptr: decay to pointer (use alloca address directly)
    if (fromKind.tag === "array" && toKind.tag === "ptr") {
      const [al, addr] = this.genLValue(expr.operand);
      lines.push(...al);
      return [lines, addr, toTy];
    }
    const [ol, ov, fromTy] = this.genExpr(expr.operand);
    lines.push(...ol);
    if (fromTy === toTy) return [lines, ov, toTy];
    const tmp = this.nextTemp();
    const fromFloat = fromKind.tag === "float";
    const toFloat = toKind.tag === "float";
    if (fromKind.tag === "ptr" && (toKind.tag === "int" || toKind.tag === "bool")) {
      lines.push(`  ${tmp} = ptrtoint ${fromTy} ${ov} to ${toTy}`);
    } else if ((fromKind.tag === "int" || fromKind.tag === "bool") && toKind.tag === "ptr") {
      lines.push(`  ${tmp} = inttoptr ${fromTy} ${ov} to ${toTy}`);
    } else if (fromFloat && toFloat) {
      const op = this.bitWidth(toKind) > this.bitWidth(fromKind) ? "fpext" : "fptrunc";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else if (fromFloat) {
      const op = toKind.tag === "int" && !toKind.signed ? "fptoui" : "fptosi";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else if (toFloat) {
      const op = fromKind.tag === "int" && !fromKind.signed ? "uitofp" : "sitofp";
      lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
    } else {
      const fromBits = this.bitWidth(fromKind);
      const toBits = this.bitWidth(toKind);
      if (toBits > fromBits) {
        const op = fromKind.tag === "bool" || (fromKind.tag === "int" && !fromKind.signed) ? "zext" : "sext";
        lines.push(`  ${tmp} = ${op} ${fromTy} ${ov} to ${toTy}`);
      } else {
        lines.push(`  ${tmp} = trunc ${fromTy} ${ov} to ${toTy}`);
      }
    }
    return [lines, tmp, toTy];
  }

  private bitWidth(t: TypeKind): number {
    if (t.tag === "int") return t.bits;
    if (t.tag === "float") return t.bits;
    if (t.tag === "bool") return 1;
    return 64;
  }

  private genStringConcat(lines: string[], lv: string, rv: string): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
    const aData = this.nextTemp();
    lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
    const aLen = this.nextTemp();
    lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
    const bData = this.nextTemp();
    lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
    const bLen = this.nextTemp();
    lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
    const total = this.nextTemp();
    lines.push(`  ${total} = add i64 ${aLen}, ${bLen}`);
    // +1 for null terminator
    const allocSz = this.nextTemp();
    lines.push(`  ${allocSz} = add i64 ${total}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocSz})`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${aData}, i64 ${aLen})`);
    const dst = this.nextTemp();
    lines.push(`  ${dst} = getelementptr i8, ptr ${buf}, i64 ${aLen}`);
    lines.push(`  call ptr @memcpy(ptr ${dst}, ptr ${bData}, i64 ${bLen})`);
    // null terminate
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${total}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${total}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
    return [lines, s2, "%String"];
  }

  private genStringCmp(lines: string[], lv: string, rv: string, isEq: boolean): [string[], string, string] {
    this.needsMemcmp = true;
    const aLen = this.nextTemp();
    lines.push(`  ${aLen} = extractvalue %String ${lv}, 1`);
    const bLen = this.nextTemp();
    lines.push(`  ${bLen} = extractvalue %String ${rv}, 1`);
    const lenEq = this.nextTemp();
    lines.push(`  ${lenEq} = icmp eq i64 ${aLen}, ${bLen}`);
    const cmpDataLabel = this.nextLabel("str.cmpdata");
    const cmpFalseLabel = this.nextLabel("str.short");
    const cmpDoneLabel = this.nextLabel("str.done");
    lines.push(`  br i1 ${lenEq}, label %${cmpDataLabel}, label %${cmpFalseLabel}`);
    lines.push(`${cmpDataLabel}:`);
    const aData = this.nextTemp();
    lines.push(`  ${aData} = extractvalue %String ${lv}, 0`);
    const bData = this.nextTemp();
    lines.push(`  ${bData} = extractvalue %String ${rv}, 0`);
    const cmpResult = this.nextTemp();
    lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${aLen})`);
    const dataEq = this.nextTemp();
    lines.push(`  ${dataEq} = icmp eq i32 ${cmpResult}, 0`);
    lines.push(`  br label %${cmpDoneLabel}`);
    lines.push(`${cmpFalseLabel}:`);
    lines.push(`  br label %${cmpDoneLabel}`);
    lines.push(`${cmpDoneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [${dataEq}, %${cmpDataLabel}], [false, %${cmpFalseLabel}]`);
    if (!isEq) {
      const negated = this.nextTemp();
      lines.push(`  ${negated} = xor i1 ${result}, 1`);
      return [lines, negated, "i1"];
    }
    return [lines, result, "i1"];
  }

  private genStringIndex(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsBoundsCheck = true;
    const [ol, ov] = this.genExpr(expr.object);
    lines.push(...ol);
    const [il, iv, idxTy] = this.genExpr(expr.index);
    lines.push(...il);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${ov}, 1`);
    const len32 = this.nextTemp();
    lines.push(`  ${len32} = trunc i64 ${len} to i32`);
    if (idxTy === "i64") {
      const idx32 = this.nextTemp();
      lines.push(`  ${idx32} = trunc i64 ${iv} to i32`);
      this.emitBoundsCheck(lines, idx32, len32);
    } else {
      this.emitBoundsCheck(lines, iv, len32);
    }
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${ov}, 0`);
    let idx64: string;
    if (idxTy === "i64") {
      idx64 = iv;
    } else {
      idx64 = this.nextTemp();
      lines.push(`  ${idx64} = sext ${idxTy} ${iv} to i64`);
    }
    const bytePtr = this.nextTemp();
    lines.push(`  ${bytePtr} = getelementptr i8, ptr ${data}, i64 ${idx64}`);
    const byte = this.nextTemp();
    lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
    return [lines, byte, "i8"];
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
        lines.push(`  ${tmp} = load ptr, ptr ${this.localAddr(expr.name)}`);
        return [lines, tmp];
      }
      return [[], this.localAddr(expr.name)];
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

  private genVecPush(expr: HIRExpr & { kind: "VecPush" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    const vecType = expr.vec.type;
    if (vecType.tag !== "vec") throw new Error("VecPush on non-vec type");
    const elemSize = this.typeSizeOf(vecType.element);
    const elemTy = this.llvmType(vecType.element);

    // get pointer to the vec struct
    const [vecPtrLines, vecPtr] = this.genLValue(expr.vec);
    lines.push(...vecPtrLines);

    // generate the value to push
    const [valLines, valVal, valTy] = this.genExpr(expr.value);
    lines.push(...valLines);

    // load len and cap
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    // check if len >= cap (need to grow)
    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp uge i64 ${len}, ${cap}`);
    const growLabel = this.nextLabel("vec.grow");
    const pushLabel = this.nextLabel("vec.push");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${pushLabel}`);

    // grow: new_cap = cap == 0 ? 8 : cap * 2
    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const newCap = this.nextTemp();
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 8, i64 ${doubled}`);
    const newBytes = this.nextTemp();
    lines.push(`  ${newBytes} = mul i64 ${newCap}, ${elemSize}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newBytes})`);

    // copy old data if any
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("vec.copy");
    const storeLabel = this.nextLabel("vec.store");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${storeLabel}`);

    lines.push(`${copyLabel}:`);
    const copyBytes = this.nextTemp();
    lines.push(`  ${copyBytes} = mul i64 ${len}, ${elemSize}`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${copyBytes})`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${storeLabel}`);

    // store new buf, cap
    lines.push(`${storeLabel}:`);
    const dataPtr2 = this.nextTemp();
    lines.push(`  ${dataPtr2} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr2}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${pushLabel}`);

    // push: store value at data[len], len++
    lines.push(`${pushLabel}:`);
    const curDataPtr = this.nextTemp();
    lines.push(`  ${curDataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${curDataPtr}`);
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${curData}, i64 ${curLen}`);
    lines.push(`  store ${valTy} ${valVal}, ptr ${elemPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, "void", "void"];
  }

  private genVecPop(expr: HIRExpr & { kind: "VecPop" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsPrintf = true;
    this.needsExit = true;
    this.needsPutchar = true;

    const vecType = expr.vec.type;
    if (vecType.tag !== "vec") throw new Error("VecPop on non-vec type");
    const elemTy = this.llvmType(vecType.element);
    const elemSize = this.typeSizeOf(vecType.element);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.vec);
    lines.push(...vecPtrLines);

    // load len
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);

    // panic if empty
    const isEmpty = this.nextTemp();
    lines.push(`  ${isEmpty} = icmp eq i64 ${len}, 0`);
    const panicLabel = this.nextLabel("vec.pop.panic");
    const okLabel = this.nextLabel("vec.pop.ok");
    lines.push(`  br i1 ${isEmpty}, label %${panicLabel}, label %${okLabel}`);

    lines.push(`${panicLabel}:`);
    const span = expr.span;
    const errMsg = `pop on empty Vec at ${span?.line ?? 0}:${span?.col ?? 0}`;
    const { label: errLabel, length: errLen } = this.addString(errMsg);
    const errPtr = this.nextTemp();
    lines.push(`  ${errPtr} = getelementptr [${errLen} x i8], ptr ${errLabel}, i32 0, i32 0`);
    lines.push(`  call i32 (ptr, ...) @printf(ptr ${errPtr})`);
    lines.push(`  call i32 @putchar(i32 10)`);
    lines.push(`  call void @exit(i32 1)`);
    lines.push(`  unreachable`);

    // ok: len--, load value at data[new_len]
    lines.push(`${okLabel}:`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${len}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${data}, i64 ${newLen}`);
    const val = this.nextTemp();
    lines.push(`  ${val} = load ${elemTy}, ptr ${elemPtr}`);

    return [lines, val, elemTy];
  }

  // String.push(u8) — same grow logic as Vec but element size is 1
  private genStringPush(expr: HIRExpr & { kind: "StringPush" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsMemcpy = true;

    const [strPtrLines, strPtr] = this.genLValue(expr.str);
    lines.push(...strPtrLines);
    const [byteLines, byteVal] = this.genExpr(expr.byte);
    lines.push(...byteLines);

    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);

    const needsGrow = this.nextTemp();
    lines.push(`  ${needsGrow} = icmp uge i64 ${len}, ${cap}`);
    const growLabel = this.nextLabel("str.grow");
    const pushLabel = this.nextLabel("str.push");
    lines.push(`  br i1 ${needsGrow}, label %${growLabel}, label %${pushLabel}`);

    lines.push(`${growLabel}:`);
    const isZero = this.nextTemp();
    lines.push(`  ${isZero} = icmp eq i64 ${cap}, 0`);
    const doubled = this.nextTemp();
    lines.push(`  ${doubled} = mul i64 ${cap}, 2`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = select i1 ${isZero}, i64 16, i64 ${doubled}`);
    const newBuf = this.nextTemp();
    lines.push(`  ${newBuf} = call ptr @malloc(i64 ${newCap})`);

    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const oldBuf = this.nextTemp();
    lines.push(`  ${oldBuf} = load ptr, ptr ${dataPtr}`);
    const hasData = this.nextTemp();
    lines.push(`  ${hasData} = icmp ne ptr ${oldBuf}, null`);
    const copyLabel = this.nextLabel("str.copy");
    const storeLabel = this.nextLabel("str.store");
    lines.push(`  br i1 ${hasData}, label %${copyLabel}, label %${storeLabel}`);

    lines.push(`${copyLabel}:`);
    lines.push(`  call ptr @memcpy(ptr ${newBuf}, ptr ${oldBuf}, i64 ${len})`);
    // only free if cap > 0 (cap == 0 means static/unowned buffer)
    const canFree = this.nextTemp();
    lines.push(`  ${canFree} = icmp ugt i64 ${cap}, 0`);
    const freeLabel = this.nextLabel("str.free");
    const skipFreeLabel = this.nextLabel("str.skipfree");
    lines.push(`  br i1 ${canFree}, label %${freeLabel}, label %${skipFreeLabel}`);
    lines.push(`${freeLabel}:`);
    lines.push(`  call void @free(ptr ${oldBuf})`);
    lines.push(`  br label %${skipFreeLabel}`);
    lines.push(`${skipFreeLabel}:`);
    lines.push(`  br label %${storeLabel}`);

    lines.push(`${storeLabel}:`);
    const dataPtr2 = this.nextTemp();
    lines.push(`  ${dataPtr2} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    lines.push(`  store ptr ${newBuf}, ptr ${dataPtr2}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${pushLabel}`);

    lines.push(`${pushLabel}:`);
    const curDataPtr = this.nextTemp();
    lines.push(`  ${curDataPtr} = getelementptr %String, ptr ${strPtr}, i32 0, i32 0`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${curDataPtr}`);
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const elemPtr = this.nextTemp();
    lines.push(`  ${elemPtr} = getelementptr i8, ptr ${curData}, i64 ${curLen}`);
    lines.push(`  store i8 ${byteVal}, ptr ${elemPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);

    return [lines, "void", "void"];
  }

  // String.substr(start, end) — allocate new string from s[start..end]
  private genStringSubstr(expr: HIRExpr & { kind: "StringSubstr" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;

    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const [startLines, startVal] = this.genExpr(expr.start);
    lines.push(...startLines);
    const [endLines, endVal] = this.genExpr(expr.end);
    lines.push(...endLines);

    const subLen = this.nextTemp();
    lines.push(`  ${subLen} = sub i64 ${endVal}, ${startVal}`);

    const buf = this.nextTemp();
    const allocLen = this.nextTemp();
    lines.push(`  ${allocLen} = add i64 ${subLen}, 1`);
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocLen})`);

    const srcPtr = this.nextTemp();
    lines.push(`  ${srcPtr} = extractvalue %String ${strVal}, 0`);
    const srcOff = this.nextTemp();
    lines.push(`  ${srcOff} = getelementptr i8, ptr ${srcPtr}, i64 ${startVal}`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${srcOff}, i64 ${subLen})`);

    // null-terminate
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${subLen}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${subLen}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocLen}, 2`);

    return [lines, s2, "%String"];
  }

  // n.to_string() / x.to_string() — snprintf into heap buffer, return owned %String
  private genNumberToString(expr: HIRExpr & { kind: "NumberToString" }, lines: string[]): [string[], string, string] {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.hasStringType = true;

    const [vLines, vVal] = this.genExpr(expr.value);
    lines.push(...vLines);

    const vt = expr.valueType;
    let fmtStr: string;
    let argType: string;
    let argVal = vVal;
    if (vt.tag === "int") {
      // widen narrow ints to i32 / i64 for snprintf
      if (vt.bits < 32) {
        const widened = this.nextTemp();
        lines.push(`  ${widened} = ${vt.signed ? "sext" : "zext"} i${vt.bits} ${vVal} to i32`);
        argVal = widened;
        argType = "i32";
        fmtStr = vt.signed ? "%d" : "%u";
      } else if (vt.bits === 32) {
        argType = "i32";
        fmtStr = vt.signed ? "%d" : "%u";
      } else {
        argType = "i64";
        fmtStr = vt.signed ? "%lld" : "%llu";
      }
    } else {
      // float — promote f32 to double
      if (vt.tag === "float" && vt.bits === 32) {
        const promoted = this.nextTemp();
        lines.push(`  ${promoted} = fpext float ${vVal} to double`);
        argVal = promoted;
      }
      argType = "double";
      fmtStr = "%g";
    }

    const fmt = this.addString(fmtStr);
    // size = snprintf(null, 0, fmt, val)
    const lenRes = this.nextTemp();
    lines.push(`  ${lenRes} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmt.label}, ${argType} ${argVal})`);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = sext i32 ${lenRes} to i64`);
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);
    lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${bufSize}, ptr ${fmt.label}, ${argType} ${argVal})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
    return [lines, s2, "%String"];
  }

  // s.clone() — deep copy of the underlying byte buffer; result is an owned %String
  private genStringClone(expr: HIRExpr & { kind: "StringClone" }, lines: string[]): [string[], string, string] {
    this.hasStringType = true;
    this.needsMalloc = true;
    this.needsMemcpy = true;
    const [sLines, sVal] = this.genExpr(expr.str);
    lines.push(...sLines);
    const data = this.nextTemp();
    lines.push(`  ${data} = extractvalue %String ${sVal}, 0`);
    const len = this.nextTemp();
    lines.push(`  ${len} = extractvalue %String ${sVal}, 1`);
    const allocSz = this.nextTemp();
    lines.push(`  ${allocSz} = add i64 ${len}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${allocSz})`);
    lines.push(`  call ptr @memcpy(ptr ${buf}, ptr ${data}, i64 ${len})`);
    const nullPtr = this.nextTemp();
    lines.push(`  ${nullPtr} = getelementptr i8, ptr ${buf}, i64 ${len}`);
    lines.push(`  store i8 0, ptr ${nullPtr}`);
    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${allocSz}, 2`);
    return [lines, s2, "%String"];
  }

  private genStringParseF64(expr: HIRExpr & { kind: "StringParseF64" }, lines: string[]): [string[], string, string] {
    this.needsStrtod = true;
    this.hasStringType = true;
    const [strLines, strVal] = this.genExpr(expr.str);
    lines.push(...strLines);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = extractvalue %String ${strVal}, 0`);
    const result = this.nextTemp();
    lines.push(`  ${result} = call double @strtod(ptr ${dataPtr}, ptr null)`);
    return [lines, result, "double"];
  }

  private genVecBoundsCheckedPtr(expr: HIRExpr & { kind: "IndexAccess" }, lines: string[]): [string[], string, string] {
    this.hasVecType = true;
    this.needsBoundsCheck = true;

    const vecType = expr.object.type;
    if (vecType.tag !== "vec") throw new Error("Vec index on non-vec type");
    const elemTy = this.llvmType(vecType.element);

    const [vecPtrLines, vecPtr] = this.genLValue(expr.object);
    lines.push(...vecPtrLines);
    const [idxLines, idxVal, idxTy] = this.genExpr(expr.index);
    lines.push(...idxLines);

    // load len for bounds check
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const len32 = this.nextTemp();
    lines.push(`  ${len32} = trunc i64 ${len} to i32`);

    // bounds check
    let idx32: string;
    if (idxTy === "i64") {
      idx32 = this.nextTemp();
      lines.push(`  ${idx32} = trunc i64 ${idxVal} to i32`);
    } else {
      idx32 = idxVal;
    }
    this.emitBoundsCheck(lines, idx32, len32);

    // load data pointer and GEP to element
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = getelementptr %Vec, ptr ${vecPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataPtr}`);
    let idx64: string;
    if (idxTy === "i64") {
      idx64 = idxVal;
    } else {
      idx64 = this.nextTemp();
      lines.push(`  ${idx64} = sext ${idxTy} ${idxVal} to i64`);
    }
    const ptr = this.nextTemp();
    lines.push(`  ${ptr} = getelementptr ${elemTy}, ptr ${data}, i64 ${idx64}`);

    return [lines, ptr, elemTy];
  }

  // ── HashMap codegen ──

  private hashMapEntryType(keyType: TypeKind, valueType: TypeKind): string {
    return `{ i8, ${this.llvmType(keyType)}, ${this.llvmType(valueType)} }`;
  }

  private emitFnvHash(lines: string[], keyVal: string, keyType: TypeKind, seedReg: string): string {
    // FNV-1a: hash = offset_basis ^ seed; for each byte: hash ^= byte; hash *= prime
    const offsetBasis = "14695981039346656037";
    const prime = "1099511628211";
    const h0 = this.nextTemp();
    lines.push(`  ${h0} = xor i64 ${offsetBasis}, ${seedReg}`);

    if (keyType.tag === "bool") {
      const byte = this.nextTemp();
      lines.push(`  ${byte} = zext i1 ${keyVal} to i64`);
      const x = this.nextTemp();
      lines.push(`  ${x} = xor i64 ${h0}, ${byte}`);
      const result = this.nextTemp();
      lines.push(`  ${result} = mul i64 ${x}, ${prime}`);
      return result;
    }

    if (keyType.tag === "int") {
      let val64: string;
      if (keyType.bits === 64) {
        val64 = keyVal;
      } else {
        val64 = this.nextTemp();
        if (keyType.signed) {
          lines.push(`  ${val64} = sext i${keyType.bits} ${keyVal} to i64`);
        } else {
          lines.push(`  ${val64} = zext i${keyType.bits} ${keyVal} to i64`);
        }
      }
      // unrolled 8-byte FNV-1a
      let hash = h0;
      for (let i = 0; i < 8; i++) {
        const shifted = this.nextTemp();
        lines.push(`  ${shifted} = lshr i64 ${val64}, ${i * 8}`);
        const byte = this.nextTemp();
        lines.push(`  ${byte} = and i64 ${shifted}, 255`);
        const xored = this.nextTemp();
        lines.push(`  ${xored} = xor i64 ${hash}, ${byte}`);
        hash = this.nextTemp();
        lines.push(`  ${hash} = mul i64 ${xored}, ${prime}`);
      }
      return hash;
    }

    if (keyType.tag === "string") {
      this.hasStringType = true;
      const strData = this.nextTemp();
      lines.push(`  ${strData} = extractvalue %String ${keyVal}, 0`);
      const strLen = this.nextTemp();
      lines.push(`  ${strLen} = extractvalue %String ${keyVal}, 1`);
      const iAddr = this.nextTemp();
      lines.push(`  ${iAddr} = alloca i64`);
      lines.push(`  store i64 0, ptr ${iAddr}`);
      const hAddr = this.nextTemp();
      lines.push(`  ${hAddr} = alloca i64`);
      lines.push(`  store i64 ${h0}, ptr ${hAddr}`);
      const condLabel = this.nextLabel("fnv.cond");
      const bodyLabel = this.nextLabel("fnv.body");
      const endLabel = this.nextLabel("fnv.end");
      lines.push(`  br label %${condLabel}`);
      lines.push(`${condLabel}:`);
      const iVal = this.nextTemp();
      lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
      const cmp = this.nextTemp();
      lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${strLen}`);
      lines.push(`  br i1 ${cmp}, label %${bodyLabel}, label %${endLabel}`);
      lines.push(`${bodyLabel}:`);
      const bytePtr = this.nextTemp();
      lines.push(`  ${bytePtr} = getelementptr i8, ptr ${strData}, i64 ${iVal}`);
      const byte = this.nextTemp();
      lines.push(`  ${byte} = load i8, ptr ${bytePtr}`);
      const byte64 = this.nextTemp();
      lines.push(`  ${byte64} = zext i8 ${byte} to i64`);
      const curH = this.nextTemp();
      lines.push(`  ${curH} = load i64, ptr ${hAddr}`);
      const xored = this.nextTemp();
      lines.push(`  ${xored} = xor i64 ${curH}, ${byte64}`);
      const newH = this.nextTemp();
      lines.push(`  ${newH} = mul i64 ${xored}, ${prime}`);
      lines.push(`  store i64 ${newH}, ptr ${hAddr}`);
      const nextI = this.nextTemp();
      lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
      lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
      lines.push(`  br label %${condLabel}`);
      lines.push(`${endLabel}:`);
      const result = this.nextTemp();
      lines.push(`  ${result} = load i64, ptr ${hAddr}`);
      return result;
    }

    throw new Error(`unhashable key type: ${keyType.tag}`);
  }

  private emitKeyCompare(lines: string[], k1: string, k2: string, keyType: TypeKind): string {
    if (keyType.tag === "int" || keyType.tag === "bool") {
      const result = this.nextTemp();
      lines.push(`  ${result} = icmp eq ${this.llvmType(keyType)} ${k1}, ${k2}`);
      return result;
    }
    if (keyType.tag === "string") {
      this.needsMemcmp = true;
      const aLen = this.nextTemp();
      lines.push(`  ${aLen} = extractvalue %String ${k1}, 1`);
      const bLen = this.nextTemp();
      lines.push(`  ${bLen} = extractvalue %String ${k2}, 1`);
      const lenEq = this.nextTemp();
      lines.push(`  ${lenEq} = icmp eq i64 ${aLen}, ${bLen}`);
      const cmpDataLabel = this.nextLabel("keycmp.data");
      const cmpFalseLabel = this.nextLabel("keycmp.ne");
      const cmpDoneLabel = this.nextLabel("keycmp.done");
      lines.push(`  br i1 ${lenEq}, label %${cmpDataLabel}, label %${cmpFalseLabel}`);
      lines.push(`${cmpDataLabel}:`);
      const aData = this.nextTemp();
      lines.push(`  ${aData} = extractvalue %String ${k1}, 0`);
      const bData = this.nextTemp();
      lines.push(`  ${bData} = extractvalue %String ${k2}, 0`);
      const cmpResult = this.nextTemp();
      lines.push(`  ${cmpResult} = call i32 @memcmp(ptr ${aData}, ptr ${bData}, i64 ${aLen})`);
      const dataEq = this.nextTemp();
      lines.push(`  ${dataEq} = icmp eq i32 ${cmpResult}, 0`);
      lines.push(`  br label %${cmpDoneLabel}`);
      lines.push(`${cmpFalseLabel}:`);
      lines.push(`  br label %${cmpDoneLabel}`);
      lines.push(`${cmpDoneLabel}:`);
      const result = this.nextTemp();
      lines.push(`  ${result} = phi i1 [${dataEq}, %${cmpDataLabel}], [false, %${cmpFalseLabel}]`);
      return result;
    }
    throw new Error(`uncomparable key type: ${keyType.tag}`);
  }

  private genHashMapNew(expr: HIRExpr & { kind: "HashMapNew" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    const entryTy = this.hashMapEntryType(expr.keyType, expr.valueType);
    // allocate initial 8 entries, zeroed
    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const totalSize = this.nextTemp();
    lines.push(`  ${totalSize} = mul i64 ${entrySizeI}, 8`);
    const dataPtr = this.nextTemp();
    lines.push(`  ${dataPtr} = call ptr @malloc(i64 ${totalSize})`);
    // zero the memory
    this.needsMemset = true;
    lines.push(`  call ptr @memset(ptr ${dataPtr}, i32 0, i64 ${totalSize})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %HashMap undef, ptr ${dataPtr}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %HashMap ${s0}, i64 0, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %HashMap ${s1}, i64 8, 2`);
    // seed = 0 (lazy init on first insert)
    const s3 = this.nextTemp();
    lines.push(`  ${s3} = insertvalue %HashMap ${s2}, i64 0, 3`);
    return [lines, s3, "%HashMap"];
  }

  private genHashMapInsert(expr: HIRExpr & { kind: "HashMapInsert" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    this.needsMalloc = true;
    this.needsFree = true;
    this.needsGetentropy = true;

    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapInsert on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    // get pointer to map
    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);

    // eval key and value
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);
    const [valLines, valVal] = this.genExpr(expr.value);
    lines.push(...valLines);

    // lazy seed init
    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const seedIsZero = this.nextTemp();
    lines.push(`  ${seedIsZero} = icmp eq i64 ${seed}, 0`);
    const initLabel = this.nextLabel("seed.init");
    const haveLabel = this.nextLabel("seed.have");
    const preLabel = this.nextLabel("seed.pre");
    lines.push(`  br label %${preLabel}`);
    lines.push(`${preLabel}:`);
    lines.push(`  br i1 ${seedIsZero}, label %${initLabel}, label %${haveLabel}`);
    lines.push(`${initLabel}:`);
    const seedBuf = this.nextTemp();
    lines.push(`  ${seedBuf} = alloca i64`);
    lines.push(`  call i32 @getentropy(ptr ${seedBuf}, i64 8)`);
    const newSeed = this.nextTemp();
    lines.push(`  ${newSeed} = load i64, ptr ${seedBuf}`);
    const isStillZero = this.nextTemp();
    lines.push(`  ${isStillZero} = icmp eq i64 ${newSeed}, 0`);
    const finalSeed = this.nextTemp();
    lines.push(`  ${finalSeed} = select i1 ${isStillZero}, i64 14695981039346656037, i64 ${newSeed}`);
    lines.push(`  store i64 ${finalSeed}, ptr ${seedPtr}`);
    lines.push(`  br label %${haveLabel}`);
    lines.push(`${haveLabel}:`);
    const activeSeed = this.nextTemp();
    lines.push(`  ${activeSeed} = phi i64 [${seed}, %${preLabel}], [${finalSeed}, %${initLabel}]`);

    // load cap and len
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 1`);
    const len = this.nextTemp();
    lines.push(`  ${len} = load i64, ptr ${lenPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);

    // resize check: (len + 1) * 4 >= cap * 3
    const lenPlus1 = this.nextTemp();
    lines.push(`  ${lenPlus1} = add i64 ${len}, 1`);
    const lhs = this.nextTemp();
    lines.push(`  ${lhs} = mul i64 ${lenPlus1}, 4`);
    const rhs = this.nextTemp();
    lines.push(`  ${rhs} = mul i64 ${cap}, 3`);
    const needResize = this.nextTemp();
    lines.push(`  ${needResize} = icmp uge i64 ${lhs}, ${rhs}`);
    const resizeLabel = this.nextLabel("hm.resize");
    const insertLabel = this.nextLabel("hm.insert");
    lines.push(`  br i1 ${needResize}, label %${resizeLabel}, label %${insertLabel}`);

    // resize block
    lines.push(`${resizeLabel}:`);
    const newCap = this.nextTemp();
    lines.push(`  ${newCap} = shl i64 ${cap}, 1`); // cap * 2
    const entrySize = this.nextTemp();
    lines.push(`  ${entrySize} = getelementptr ${entryTy}, ptr null, i32 1`);
    const entrySizeI = this.nextTemp();
    lines.push(`  ${entrySizeI} = ptrtoint ptr ${entrySize} to i64`);
    const newTotalSize = this.nextTemp();
    lines.push(`  ${newTotalSize} = mul i64 ${entrySizeI}, ${newCap}`);
    const newData = this.nextTemp();
    lines.push(`  ${newData} = call ptr @malloc(i64 ${newTotalSize})`);
    this.needsMemset = true;
    lines.push(`  call ptr @memset(ptr ${newData}, i32 0, i64 ${newTotalSize})`);
    // rehash all occupied entries from old data
    const oldData = this.nextTemp();
    lines.push(`  ${oldData} = load ptr, ptr ${dataFieldPtr}`);
    const rehashCond = this.nextLabel("rehash.cond");
    const rehashBody = this.nextLabel("rehash.body");
    const rehashEnd = this.nextLabel("rehash.end");
    const riAddr = this.nextTemp();
    lines.push(`  ${riAddr} = alloca i64`);
    lines.push(`  store i64 0, ptr ${riAddr}`);
    lines.push(`  br label %${rehashCond}`);
    lines.push(`${rehashCond}:`);
    const ri = this.nextTemp();
    lines.push(`  ${ri} = load i64, ptr ${riAddr}`);
    const riCmp = this.nextTemp();
    lines.push(`  ${riCmp} = icmp ult i64 ${ri}, ${cap}`);
    lines.push(`  br i1 ${riCmp}, label %${rehashBody}, label %${rehashEnd}`);
    lines.push(`${rehashBody}:`);
    const oldEntryPtr = this.nextTemp();
    lines.push(`  ${oldEntryPtr} = getelementptr ${entryTy}, ptr ${oldData}, i64 ${ri}`);
    const oldState = this.nextTemp();
    lines.push(`  ${oldState} = load i8, ptr ${oldEntryPtr}`);
    const isOccupied = this.nextTemp();
    lines.push(`  ${isOccupied} = icmp eq i8 ${oldState}, 1`);
    const rehashInsert = this.nextLabel("rehash.ins");
    const rehashNext = this.nextLabel("rehash.next");
    lines.push(`  br i1 ${isOccupied}, label %${rehashInsert}, label %${rehashNext}`);
    lines.push(`${rehashInsert}:`);
    // load key from old entry
    const oldKeyPtr = this.nextTemp();
    lines.push(`  ${oldKeyPtr} = getelementptr ${entryTy}, ptr ${oldEntryPtr}, i32 0, i32 1`);
    const oldKey = this.nextTemp();
    lines.push(`  ${oldKey} = load ${keyTy}, ptr ${oldKeyPtr}`);
    // load value from old entry
    const oldValPtr = this.nextTemp();
    lines.push(`  ${oldValPtr} = getelementptr ${entryTy}, ptr ${oldEntryPtr}, i32 0, i32 2`);
    const oldVal = this.nextTemp();
    lines.push(`  ${oldVal} = load ${valTy}, ptr ${oldValPtr}`);
    // hash key with new mask
    const rehashHash = this.emitFnvHash(lines, oldKey, keyType, activeSeed);
    const newMask = this.nextTemp();
    lines.push(`  ${newMask} = sub i64 ${newCap}, 1`);
    // probe in new array
    const rjAddr = this.nextTemp();
    lines.push(`  ${rjAddr} = alloca i64`);
    const rehashSlot0 = this.nextTemp();
    lines.push(`  ${rehashSlot0} = and i64 ${rehashHash}, ${newMask}`);
    lines.push(`  store i64 ${rehashSlot0}, ptr ${rjAddr}`);
    const rehashProbeCond = this.nextLabel("rehash.probe");
    lines.push(`  br label %${rehashProbeCond}`);
    lines.push(`${rehashProbeCond}:`);
    const rj = this.nextTemp();
    lines.push(`  ${rj} = load i64, ptr ${rjAddr}`);
    const newEntryPtr = this.nextTemp();
    lines.push(`  ${newEntryPtr} = getelementptr ${entryTy}, ptr ${newData}, i64 ${rj}`);
    const newState = this.nextTemp();
    lines.push(`  ${newState} = load i8, ptr ${newEntryPtr}`);
    const newEmpty = this.nextTemp();
    lines.push(`  ${newEmpty} = icmp eq i8 ${newState}, 0`);
    const rehashStore = this.nextLabel("rehash.store");
    const rehashProbeNext = this.nextLabel("rehash.pnext");
    lines.push(`  br i1 ${newEmpty}, label %${rehashStore}, label %${rehashProbeNext}`);
    lines.push(`${rehashStore}:`);
    lines.push(`  store i8 1, ptr ${newEntryPtr}`);
    const newKeyPtr = this.nextTemp();
    lines.push(`  ${newKeyPtr} = getelementptr ${entryTy}, ptr ${newEntryPtr}, i32 0, i32 1`);
    lines.push(`  store ${keyTy} ${oldKey}, ptr ${newKeyPtr}`);
    const newValPtr = this.nextTemp();
    lines.push(`  ${newValPtr} = getelementptr ${entryTy}, ptr ${newEntryPtr}, i32 0, i32 2`);
    lines.push(`  store ${valTy} ${oldVal}, ptr ${newValPtr}`);
    lines.push(`  br label %${rehashNext}`);
    lines.push(`${rehashProbeNext}:`);
    const rjNext = this.nextTemp();
    lines.push(`  ${rjNext} = add i64 ${rj}, 1`);
    const rjWrapped = this.nextTemp();
    lines.push(`  ${rjWrapped} = and i64 ${rjNext}, ${newMask}`);
    lines.push(`  store i64 ${rjWrapped}, ptr ${rjAddr}`);
    lines.push(`  br label %${rehashProbeCond}`);
    lines.push(`${rehashNext}:`);
    const riNext = this.nextTemp();
    lines.push(`  ${riNext} = add i64 ${ri}, 1`);
    lines.push(`  store i64 ${riNext}, ptr ${riAddr}`);
    lines.push(`  br label %${rehashCond}`);
    lines.push(`${rehashEnd}:`);
    // free old data, update map fields
    lines.push(`  call void @free(ptr ${oldData})`);
    lines.push(`  store ptr ${newData}, ptr ${dataFieldPtr}`);
    lines.push(`  store i64 ${newCap}, ptr ${capPtr}`);
    lines.push(`  br label %${insertLabel}`);

    // insert block — probe for slot
    lines.push(`${insertLabel}:`);
    const curCap = this.nextTemp();
    lines.push(`  ${curCap} = load i64, ptr ${capPtr}`);
    const curData = this.nextTemp();
    lines.push(`  ${curData} = load ptr, ptr ${dataFieldPtr}`);
    const curSeed = this.nextTemp();
    lines.push(`  ${curSeed} = load i64, ptr ${seedPtr}`);
    const hash = this.emitFnvHash(lines, keyVal, keyType, curSeed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${curCap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hm.probe");
    const probeOccupied = this.nextLabel("hm.occupied");
    const probeEmpty = this.nextLabel("hm.empty");
    const probeNext = this.nextLabel("hm.pnext");
    const insertDone = this.nextLabel("hm.done");

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${curData}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    // state == 1 (occupied) -> check key
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeEmpty}`);

    // occupied: compare keys
    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    const overwriteLabel = this.nextLabel("hm.overwrite");
    lines.push(`  br i1 ${keysMatch}, label %${overwriteLabel}, label %${probeNext}`);

    // overwrite existing value
    lines.push(`${overwriteLabel}:`);
    const existingValPtr = this.nextTemp();
    lines.push(`  ${existingValPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    // TODO(insert-return-value): return old value as Option<V>
    if (this.needsDropCg(valueType)) {
      this.emitDropValue(lines, existingValPtr, valueType);
    }
    lines.push(`  store ${valTy} ${valVal}, ptr ${existingValPtr}`);
    lines.push(`  br label %${insertDone}`);

    // empty or tombstone: insert here
    lines.push(`${probeEmpty}:`);
    lines.push(`  store i8 1, ptr ${entryPtr}`);
    const newKeySlotPtr = this.nextTemp();
    lines.push(`  ${newKeySlotPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    lines.push(`  store ${keyTy} ${keyVal}, ptr ${newKeySlotPtr}`);
    const newValSlotPtr = this.nextTemp();
    lines.push(`  ${newValSlotPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    lines.push(`  store ${valTy} ${valVal}, ptr ${newValSlotPtr}`);
    // increment len
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = add i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    lines.push(`  br label %${insertDone}`);

    // probe next slot
    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${insertDone}:`);
    return [lines, "0", "void"];
  }

  private genHashMapContains(expr: HIRExpr & { kind: "HashMapContains" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapContains on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmc.probe");
    const probeOccupied = this.nextLabel("hmc.occupied");
    const probeCheck = this.nextLabel("hmc.check");
    const foundLabel = this.nextLabel("hmc.found");
    const notFoundLabel = this.nextLabel("hmc.notfound");
    const probeNext = this.nextLabel("hmc.pnext");
    const doneLabel = this.nextLabel("hmc.done");

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    // state == 0 (empty) -> not found
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${notFoundLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${foundLabel}, label %${probeNext}`);

    lines.push(`${foundLabel}:`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${notFoundLabel}:`);
    lines.push(`  br label %${doneLabel}`);
    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi i1 [true, %${foundLabel}], [false, %${notFoundLabel}]`);
    return [lines, result, "i1"];
  }

  private genHashMapRemove(expr: HIRExpr & { kind: "HashMapRemove" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapRemove on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);
    const lenPtr = this.nextTemp();
    lines.push(`  ${lenPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 1`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmr.probe");
    const probeCheck = this.nextLabel("hmr.check");
    const probeOccupied = this.nextLabel("hmr.occupied");
    const removeLabel = this.nextLabel("hmr.remove");
    const probeNext = this.nextLabel("hmr.pnext");
    const doneLabel = this.nextLabel("hmr.done");

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${doneLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${removeLabel}, label %${probeNext}`);

    lines.push(`${removeLabel}:`);
    // set tombstone
    lines.push(`  store i8 2, ptr ${entryPtr}`);
    // drop key and value if needed
    if (this.needsDropCg(keyType)) {
      const kPtr = this.nextTemp();
      lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
      this.emitDropValue(lines, kPtr, keyType);
    }
    if (this.needsDropCg(valueType)) {
      const vPtr = this.nextTemp();
      lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
      this.emitDropValue(lines, vPtr, valueType);
    }
    // decrement len
    const curLen = this.nextTemp();
    lines.push(`  ${curLen} = load i64, ptr ${lenPtr}`);
    const newLen = this.nextTemp();
    lines.push(`  ${newLen} = sub i64 ${curLen}, 1`);
    lines.push(`  store i64 ${newLen}, ptr ${lenPtr}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    return [lines, "0", "void"];
  }

  private genHashMapGet(expr: HIRExpr & { kind: "HashMapGet" }, lines: string[]): [string[], string, string] {
    this.hasHashMapType = true;
    const mapType = expr.map.type;
    if (mapType.tag !== "hashmap") throw new Error("HashMapGet on non-hashmap");
    const keyType = mapType.key;
    const valueType = mapType.value;
    const keyTy = this.llvmType(keyType);
    const valTy = this.llvmType(valueType);
    const entryTy = this.hashMapEntryType(keyType, valueType);

    const optionEnumName = expr.optionEnumName;
    const optionLayout = this.enumLayouts.get(optionEnumName);
    if (!optionLayout) throw new Error(`no enum layout for ${optionEnumName}`);
    const optionTy = `%${optionEnumName}`;

    const [mapPtrLines, mapPtr] = this.genLValue(expr.map);
    lines.push(...mapPtrLines);
    const [keyLines, keyVal] = this.genExpr(expr.key);
    lines.push(...keyLines);

    const seedPtr = this.nextTemp();
    lines.push(`  ${seedPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 3`);
    const seed = this.nextTemp();
    lines.push(`  ${seed} = load i64, ptr ${seedPtr}`);
    const capPtr = this.nextTemp();
    lines.push(`  ${capPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 2`);
    const cap = this.nextTemp();
    lines.push(`  ${cap} = load i64, ptr ${capPtr}`);
    const dataFieldPtr = this.nextTemp();
    lines.push(`  ${dataFieldPtr} = getelementptr %HashMap, ptr ${mapPtr}, i32 0, i32 0`);
    const data = this.nextTemp();
    lines.push(`  ${data} = load ptr, ptr ${dataFieldPtr}`);

    const hash = this.emitFnvHash(lines, keyVal, keyType, seed);
    const mask = this.nextTemp();
    lines.push(`  ${mask} = sub i64 ${cap}, 1`);
    const slotAddr = this.nextTemp();
    lines.push(`  ${slotAddr} = alloca i64`);
    const slot0 = this.nextTemp();
    lines.push(`  ${slot0} = and i64 ${hash}, ${mask}`);
    lines.push(`  store i64 ${slot0}, ptr ${slotAddr}`);

    const probeCond = this.nextLabel("hmg.probe");
    const probeCheck = this.nextLabel("hmg.check");
    const probeOccupied = this.nextLabel("hmg.occupied");
    const foundLabel = this.nextLabel("hmg.found");
    const notFoundLabel = this.nextLabel("hmg.notfound");
    const probeNext = this.nextLabel("hmg.pnext");
    const doneLabel = this.nextLabel("hmg.done");

    lines.push(`  br label %${probeCond}`);
    lines.push(`${probeCond}:`);
    const slot = this.nextTemp();
    lines.push(`  ${slot} = load i64, ptr ${slotAddr}`);
    const entryPtr = this.nextTemp();
    lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${data}, i64 ${slot}`);
    const state = this.nextTemp();
    lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
    const stateIsEmpty = this.nextTemp();
    lines.push(`  ${stateIsEmpty} = icmp eq i8 ${state}, 0`);
    lines.push(`  br i1 ${stateIsEmpty}, label %${notFoundLabel}, label %${probeCheck}`);

    lines.push(`${probeCheck}:`);
    const stateIsOccupied = this.nextTemp();
    lines.push(`  ${stateIsOccupied} = icmp eq i8 ${state}, 1`);
    lines.push(`  br i1 ${stateIsOccupied}, label %${probeOccupied}, label %${probeNext}`);

    lines.push(`${probeOccupied}:`);
    const existingKeyPtr = this.nextTemp();
    lines.push(`  ${existingKeyPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
    const existingKey = this.nextTemp();
    lines.push(`  ${existingKey} = load ${keyTy}, ptr ${existingKeyPtr}`);
    const keysMatch = this.emitKeyCompare(lines, keyVal, existingKey, keyType);
    lines.push(`  br i1 ${keysMatch}, label %${foundLabel}, label %${probeNext}`);

    // found — construct Some(value)
    lines.push(`${foundLabel}:`);
    const valPtr = this.nextTemp();
    lines.push(`  ${valPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
    const foundVal = this.nextTemp();
    lines.push(`  ${foundVal} = load ${valTy}, ptr ${valPtr}`);
    // build Option::Some(val) — tag=0, payload=value
    const someAlloca = this.nextTemp();
    lines.push(`  ${someAlloca} = alloca ${optionTy}`);
    const someTagPtr = this.nextTemp();
    lines.push(`  ${someTagPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 0`);
    const someTag = optionLayout.variants.get("Some")!.tag;
    lines.push(`  store i32 ${someTag}, ptr ${someTagPtr}`);
    const somePayloadPtr = this.nextTemp();
    lines.push(`  ${somePayloadPtr} = getelementptr ${optionTy}, ptr ${someAlloca}, i32 0, i32 1`);
    lines.push(`  store ${valTy} ${foundVal}, ptr ${somePayloadPtr}`);
    const someVal = this.nextTemp();
    lines.push(`  ${someVal} = load ${optionTy}, ptr ${someAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    // not found — construct None
    lines.push(`${notFoundLabel}:`);
    const noneAlloca = this.nextTemp();
    lines.push(`  ${noneAlloca} = alloca ${optionTy}`);
    // zero it first to avoid garbage in payload
    this.needsMemset = true;
    const optionSize = this.nextTemp();
    lines.push(`  ${optionSize} = getelementptr ${optionTy}, ptr null, i32 1`);
    const optionSizeI = this.nextTemp();
    lines.push(`  ${optionSizeI} = ptrtoint ptr ${optionSize} to i64`);
    lines.push(`  call ptr @memset(ptr ${noneAlloca}, i32 0, i64 ${optionSizeI})`);
    const noneTagPtr = this.nextTemp();
    lines.push(`  ${noneTagPtr} = getelementptr ${optionTy}, ptr ${noneAlloca}, i32 0, i32 0`);
    const noneTag = optionLayout.variants.get("None")!.tag;
    lines.push(`  store i32 ${noneTag}, ptr ${noneTagPtr}`);
    const noneVal = this.nextTemp();
    lines.push(`  ${noneVal} = load ${optionTy}, ptr ${noneAlloca}`);
    lines.push(`  br label %${doneLabel}`);

    lines.push(`${probeNext}:`);
    const nextSlot = this.nextTemp();
    lines.push(`  ${nextSlot} = add i64 ${slot}, 1`);
    const wrappedSlot = this.nextTemp();
    lines.push(`  ${wrappedSlot} = and i64 ${nextSlot}, ${mask}`);
    lines.push(`  store i64 ${wrappedSlot}, ptr ${slotAddr}`);
    lines.push(`  br label %${probeCond}`);

    lines.push(`${doneLabel}:`);
    const result = this.nextTemp();
    lines.push(`  ${result} = phi ${optionTy} [${someVal}, %${foundLabel}], [${noneVal}, %${notFoundLabel}]`);
    return [lines, result, optionTy];
  }

  private needsMemset = false;
  private needsSnprintf = false;

  private genJsonStringify(expr: HIRExpr & { kind: "JsonStringify" }, lines: string[]): [string[], string, string] {
    this.needsSnprintf = true;
    this.needsMalloc = true;
    this.hasStringType = true;

    const valueType = expr.valueType;
    if (valueType.tag !== "struct") {
      throw new Error(`json_stringify: unsupported type '${valueType.tag}'`);
    }

    const layout = this.structLayouts.get(valueType.name)!;
    const [ptrLines, structPtr] = this.genLValueForArg(expr.value);
    lines.push(...ptrLines);

    const formatParts: string[] = ["{"];
    const snprintfArgs: { val: string; type: string }[] = [];

    for (let i = 0; i < layout.fields.length; i++) {
      const field = layout.fields[i];
      const fk = field.typeKind;
      if (i > 0) formatParts.push(",");

      const fieldPtr = this.nextTemp();
      lines.push(`  ${fieldPtr} = getelementptr %${valueType.name}, ptr ${structPtr}, i32 0, i32 ${i}`);
      const fieldVal = this.nextTemp();
      lines.push(`  ${fieldVal} = load ${field.type}, ptr ${fieldPtr}`);

      formatParts.push(`"${field.name}":`);

      if (fk.tag === "string") {
        const dataPtr = this.nextTemp();
        lines.push(`  ${dataPtr} = extractvalue %String ${fieldVal}, 0`);
        formatParts.push(`"%s"`);
        snprintfArgs.push({ val: dataPtr, type: "ptr" });
      } else if (fk.tag === "bool") {
        const trueStr = this.addString("true");
        const falseStr = this.addString("false");
        const boolStr = this.nextTemp();
        lines.push(`  ${boolStr} = select i1 ${fieldVal}, ptr ${trueStr.label}, ptr ${falseStr.label}`);
        formatParts.push("%s");
        snprintfArgs.push({ val: boolStr, type: "ptr" });
      } else if (fk.tag === "int") {
        let passVal = fieldVal;
        let passType = field.type;
        if (fk.bits < 32) {
          const widened = this.nextTemp();
          lines.push(`  ${widened} = ${fk.signed ? "sext" : "zext"} ${field.type} ${fieldVal} to i32`);
          passVal = widened;
          passType = "i32";
        }
        formatParts.push(fk.bits <= 32 ? (fk.signed ? "%d" : "%u") : (fk.signed ? "%lld" : "%llu"));
        snprintfArgs.push({ val: passVal, type: passType });
      } else if (fk.tag === "float") {
        if (fk.bits === 32) {
          const promoted = this.nextTemp();
          lines.push(`  ${promoted} = fpext float ${fieldVal} to double`);
          snprintfArgs.push({ val: promoted, type: "double" });
        } else {
          snprintfArgs.push({ val: fieldVal, type: "double" });
        }
        formatParts.push("%g");
      }
    }

    formatParts.push("}");
    const fmt = this.addString(formatParts.join(""));
    const argsStr = snprintfArgs.map(a => `, ${a.type} ${a.val}`).join("");

    // snprintf(null, 0, fmt, ...) to measure
    const lenResult = this.nextTemp();
    lines.push(`  ${lenResult} = call i32 (ptr, i64, ptr, ...) @snprintf(ptr null, i64 0, ptr ${fmt.label}${argsStr})`);
    const len64 = this.nextTemp();
    lines.push(`  ${len64} = sext i32 ${lenResult} to i64`);
    const bufSize = this.nextTemp();
    lines.push(`  ${bufSize} = add i64 ${len64}, 1`);
    const buf = this.nextTemp();
    lines.push(`  ${buf} = call ptr @malloc(i64 ${bufSize})`);

    // snprintf(buf, size, fmt, ...) to write
    lines.push(`  call i32 (ptr, i64, ptr, ...) @snprintf(ptr ${buf}, i64 ${bufSize}, ptr ${fmt.label}${argsStr})`);

    const s0 = this.nextTemp();
    lines.push(`  ${s0} = insertvalue %String undef, ptr ${buf}, 0`);
    const s1 = this.nextTemp();
    lines.push(`  ${s1} = insertvalue %String ${s0}, i64 ${len64}, 1`);
    const s2 = this.nextTemp();
    lines.push(`  ${s2} = insertvalue %String ${s1}, i64 ${bufSize}, 2`);
    return [lines, s2, "%String"];
  }

  private emitDropValue(lines: string[], allocaPtr: string, typeKind: TypeKind) {
    if (typeKind.tag === "string") {
      this.needsFree = true;
      const old = this.nextTemp();
      lines.push(`  ${old} = load %String, ptr ${allocaPtr}`);
      const cap = this.nextTemp();
      lines.push(`  ${cap} = extractvalue %String ${old}, 2`);
      const owned = this.nextTemp();
      lines.push(`  ${owned} = icmp ugt i64 ${cap}, 0`);
      const dropLabel = this.nextLabel("drop");
      const skipLabel = this.nextLabel("drop.skip");
      lines.push(`  br i1 ${owned}, label %${dropLabel}, label %${skipLabel}`);
      lines.push(`${dropLabel}:`);
      const ptr = this.nextTemp();
      lines.push(`  ${ptr} = extractvalue %String ${old}, 0`);
      lines.push(`  call void @free(ptr ${ptr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "vec") {
      this.needsFree = true;
      const vecVal = this.nextTemp();
      lines.push(`  ${vecVal} = load %Vec, ptr ${allocaPtr}`);
      const dataPtr = this.nextTemp();
      lines.push(`  ${dataPtr} = extractvalue %Vec ${vecVal}, 0`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${dataPtr}, null`);
      const dropLabel = this.nextLabel("vec.drop");
      const skipLabel = this.nextLabel("vec.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (this.needsDropCg(typeKind.element)) {
        // drop each element: for i in 0..len
        const vecLen = this.nextTemp();
        lines.push(`  ${vecLen} = extractvalue %Vec ${vecVal}, 1`);
        const elemTy = this.llvmType(typeKind.element);
        const loopCond = this.nextLabel("vec.drop.cond");
        const loopBody = this.nextLabel("vec.drop.body");
        const loopEnd = this.nextLabel("vec.drop.end");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopCond}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${vecLen}`);
        lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
        lines.push(`${loopBody}:`);
        const elemPtr = this.nextTemp();
        lines.push(`  ${elemPtr} = getelementptr ${elemTy}, ptr ${dataPtr}, i64 ${iVal}`);
        this.emitDropValue(lines, elemPtr, typeKind.element);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopEnd}:`);
      }
      lines.push(`  call void @free(ptr ${dataPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "box") {
      this.needsFree = true;
      const boxPtr = this.nextTemp();
      lines.push(`  ${boxPtr} = load ptr, ptr ${allocaPtr}`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${boxPtr}, null`);
      const dropLabel = this.nextLabel("box.drop");
      const skipLabel = this.nextLabel("box.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (this.needsDropCg(typeKind.inner)) {
        this.emitDropValue(lines, boxPtr, typeKind.inner);
      }
      lines.push(`  call void @free(ptr ${boxPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "hashmap") {
      this.needsFree = true;
      const hmVal = this.nextTemp();
      lines.push(`  ${hmVal} = load %HashMap, ptr ${allocaPtr}`);
      const hmDataPtr = this.nextTemp();
      lines.push(`  ${hmDataPtr} = extractvalue %HashMap ${hmVal}, 0`);
      const isNull = this.nextTemp();
      lines.push(`  ${isNull} = icmp eq ptr ${hmDataPtr}, null`);
      const dropLabel = this.nextLabel("hm.drop");
      const skipLabel = this.nextLabel("hm.skip");
      lines.push(`  br i1 ${isNull}, label %${skipLabel}, label %${dropLabel}`);
      lines.push(`${dropLabel}:`);
      if (this.needsDropCg(typeKind.key) || this.needsDropCg(typeKind.value)) {
        const hmCap = this.nextTemp();
        lines.push(`  ${hmCap} = extractvalue %HashMap ${hmVal}, 2`);
        const entryTy = this.hashMapEntryType(typeKind.key, typeKind.value);
        const loopCond = this.nextLabel("hm.drop.cond");
        const loopBody = this.nextLabel("hm.drop.body");
        const loopEnd = this.nextLabel("hm.drop.end");
        const iAddr = this.nextTemp();
        lines.push(`  ${iAddr} = alloca i64`);
        lines.push(`  store i64 0, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopCond}:`);
        const iVal = this.nextTemp();
        lines.push(`  ${iVal} = load i64, ptr ${iAddr}`);
        const cmp = this.nextTemp();
        lines.push(`  ${cmp} = icmp ult i64 ${iVal}, ${hmCap}`);
        lines.push(`  br i1 ${cmp}, label %${loopBody}, label %${loopEnd}`);
        lines.push(`${loopBody}:`);
        const entryPtr = this.nextTemp();
        lines.push(`  ${entryPtr} = getelementptr ${entryTy}, ptr ${hmDataPtr}, i64 ${iVal}`);
        const state = this.nextTemp();
        lines.push(`  ${state} = load i8, ptr ${entryPtr}`);
        const isOccupied = this.nextTemp();
        lines.push(`  ${isOccupied} = icmp eq i8 ${state}, 1`);
        const dropEntryLabel = this.nextLabel("hm.drop.entry");
        const skipEntryLabel = this.nextLabel("hm.drop.skip");
        lines.push(`  br i1 ${isOccupied}, label %${dropEntryLabel}, label %${skipEntryLabel}`);
        lines.push(`${dropEntryLabel}:`);
        if (this.needsDropCg(typeKind.key)) {
          const kPtr = this.nextTemp();
          lines.push(`  ${kPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 1`);
          this.emitDropValue(lines, kPtr, typeKind.key);
        }
        if (this.needsDropCg(typeKind.value)) {
          const vPtr = this.nextTemp();
          lines.push(`  ${vPtr} = getelementptr ${entryTy}, ptr ${entryPtr}, i32 0, i32 2`);
          this.emitDropValue(lines, vPtr, typeKind.value);
        }
        lines.push(`  br label %${skipEntryLabel}`);
        lines.push(`${skipEntryLabel}:`);
        const nextI = this.nextTemp();
        lines.push(`  ${nextI} = add i64 ${iVal}, 1`);
        lines.push(`  store i64 ${nextI}, ptr ${iAddr}`);
        lines.push(`  br label %${loopCond}`);
        lines.push(`${loopEnd}:`);
      }
      lines.push(`  call void @free(ptr ${hmDataPtr})`);
      lines.push(`  br label %${skipLabel}`);
      lines.push(`${skipLabel}:`);
    }
    if (typeKind.tag === "enum" && this.droppableEnums.has(typeKind.name)) {
      const helperName = `milo.drop.${typeKind.name}`;
      this.ensureDropHelper(typeKind.name);
      const val = this.nextTemp();
      lines.push(`  ${val} = load %${typeKind.name}, ptr ${allocaPtr}`);
      const tmp = this.nextTemp();
      lines.push(`  ${tmp} = alloca %${typeKind.name}`);
      lines.push(`  store %${typeKind.name} ${val}, ptr ${tmp}`);
      lines.push(`  call void @${helperName}(ptr ${tmp})`);
    }
    if (typeKind.tag === "struct" && this.structNeedsDrop(typeKind.name)) {
      const layout = this.structLayouts.get(typeKind.name);
      if (layout) {
        // guard: skip drop if struct has been zeroed (moved)
        const probe = this.nextTemp();
        lines.push(`  ${probe} = load i64, ptr ${allocaPtr}`);
        const isZero = this.nextTemp();
        lines.push(`  ${isZero} = icmp eq i64 ${probe}, 0`);
        const skipLabel = this.nextLabel("struct.drop.skip");
        const dropLabel = this.nextLabel("struct.drop");
        lines.push(`  br i1 ${isZero}, label %${skipLabel}, label %${dropLabel}`);
        lines.push(`${dropLabel}:`);
        // call user-defined drop first (can still use fields)
        if (this.dropImpls.has(typeKind.name)) {
          const mangledDrop = `${typeKind.name}$Drop$drop`;
          lines.push(`  call void @${mangledDrop}(ptr ${allocaPtr})`);
        }
        // then drop fields that need dropping (reverse order)
        for (let i = layout.fields.length - 1; i >= 0; i--) {
          const field = layout.fields[i];
          if (this.needsDropCg(field.typeKind)) {
            const fieldPtr = this.nextTemp();
            lines.push(`  ${fieldPtr} = getelementptr %${typeKind.name}, ptr ${allocaPtr}, i32 0, i32 ${i}`);
            this.emitDropValue(lines, fieldPtr, field.typeKind);
          }
        }
        lines.push(`  br label %${skipLabel}`);
        lines.push(`${skipLabel}:`);
      }
    }
  }

  private ensureDropHelper(enumName: string) {
    if (this.generatedDropHelpers.has(enumName)) return;
    this.generatedDropHelpers.add(enumName);

    const layout = this.enumLayouts.get(enumName)!;
    const enumTy = `%${enumName}`;
    const helperName = `milo.drop.${enumName}`;
    const savedTemp = this.tempCounter;
    const savedLabel = this.labelCounter;
    this.tempCounter = 0;
    this.labelCounter = 0;

    const body: string[] = [];
    body.push(`define void @${helperName}(ptr %self) {`);
    body.push("entry:");
    const tagPtr = this.nextTemp();
    body.push(`  ${tagPtr} = getelementptr ${enumTy}, ptr %self, i32 0, i32 0`);
    const tag = this.nextTemp();
    body.push(`  ${tag} = load i32, ptr ${tagPtr}`);

    const doneLabel = this.nextLabel("drop.done");
    const cases: string[] = [];
    const variantBodies: string[][] = [];

    for (const [vName, variant] of layout.variants) {
      const hasDroppable = variant.fieldTypeKinds.some(f => this.needsDropCg(f));
      if (!hasDroppable) continue;

      const label = this.nextLabel(`drop.${vName}`);
      cases.push(`    i32 ${variant.tag}, label %${label}`);

      const vLines: string[] = [];
      vLines.push(`${label}:`);
      const payloadPtr = this.nextTemp();
      vLines.push(`  ${payloadPtr} = getelementptr ${enumTy}, ptr %self, i32 0, i32 1`);

      if (variant.fieldTypes.length === 1) {
        if (this.needsDropCg(variant.fieldTypeKinds[0])) {
          this.emitDropValue(vLines, payloadPtr, variant.fieldTypeKinds[0]);
        }
      } else {
        const structTy = `{ ${variant.fieldTypes.join(", ")} }`;
        for (let i = 0; i < variant.fieldTypes.length; i++) {
          if (!this.needsDropCg(variant.fieldTypeKinds[i])) continue;
          const fieldPtr = this.nextTemp();
          vLines.push(`  ${fieldPtr} = getelementptr ${structTy}, ptr ${payloadPtr}, i32 0, i32 ${i}`);
          this.emitDropValue(vLines, fieldPtr, variant.fieldTypeKinds[i]);
        }
      }
      vLines.push(`  br label %${doneLabel}`);
      variantBodies.push(vLines);
    }

    if (cases.length > 0) {
      body.push(`  switch i32 ${tag}, label %${doneLabel} [`);
      for (const c of cases) body.push(c);
      body.push("  ]");
      for (const vb of variantBodies) body.push(...vb);
    }

    body.push(`${doneLabel}:`);
    body.push("  ret void");
    body.push("}");

    this.dropHelperBodies.push(body);
    this.tempCounter = savedTemp;
    this.labelCounter = savedLabel;
  }

  // emit drop glue for all droppable locals before a scope exit
  private emitDropGlue(lines: string[]) {
    for (const local of this.droppableLocals) {
      this.emitDropValue(lines, this.localAddr(local.name), local.typeKind);
    }
  }
}
