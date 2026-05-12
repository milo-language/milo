import type { MiloType, Expr, Stmt, Function, Program } from "./ast";

const MILO_TO_LLVM: Record<string, string> = {
  i8: "i8", i16: "i16", i32: "i32", i64: "i64",
  u8: "i8", u16: "i16", u32: "i32", u64: "i64",
  f32: "float", f64: "double",
  bool: "i1", void: "void",
};

export class Codegen {
  private output: string[] = [];
  private strings: { label: string; escaped: string; length: number }[] = [];
  private strCounter = 0;
  private tempCounter = 0;
  private labelCounter = 0;
  private locals = new Map<string, { type: string; mutable: boolean }>();
  private fnRetTypes = new Map<string, string>();

  private nextTemp(): string { return `%t${this.tempCounter++}`; }
  private nextLabel(prefix = "L"): string { return `${prefix}${this.labelCounter++}`; }
  private emit(line: string) { this.output.push(line); }

  private llvmType(ty: MiloType): string {
    if (ty.isPtr) return "ptr";
    return MILO_TO_LLVM[ty.name] ?? ty.name;
  }

  private addString(value: string): { label: string; length: number } {
    const label = `@.str.${this.strCounter++}`;
    const escaped = value
      .replace(/\\/g, "\\5C")
      .replace(/\n/g, "\\0A")
      .replace(/\t/g, "\\09")
      .replace(/\0/g, "\\00")
      .replace(/"/g, "\\22");
    const length = value.length + 1; // null terminator
    this.strings.push({ label, escaped, length });
    return { label, length };
  }

  generate(program: Program): string {
    // build return type table
    for (const fn of program.functions) {
      this.fnRetTypes.set(fn.name, this.llvmType(fn.retType));
    }

    this.emit(`target triple = "arm64-apple-darwin25.3.0"`);
    this.emit("");

    const externs = program.functions.filter(f => f.isExtern);
    const functions = program.functions.filter(f => !f.isExtern);

    // generate function bodies first (collects string constants)
    const fnBodies: string[][] = [];
    for (const fn of functions) {
      fnBodies.push(this.genFunction(fn));
    }

    // insert string constants after target triple
    for (let i = this.strings.length - 1; i >= 0; i--) {
      const { label, escaped, length } = this.strings[i];
      this.output.splice(1, 0, `${label} = private unnamed_addr constant [${length} x i8] c"${escaped}\\00"`);
    }
    if (this.strings.length > 0) this.output.splice(1, 0, "");

    // insert extern declarations
    for (const ext of externs) {
      const params = ext.params.map(p => this.llvmType(p.type)).join(", ");
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

    // alloca for params
    for (const p of fn.params) {
      const lt = this.llvmType(p.type);
      lines.push(`  %${p.name}.addr = alloca ${lt}`);
      lines.push(`  store ${lt} %${p.name}, ptr %${p.name}.addr`);
      this.locals.set(p.name, { type: lt, mutable: false });
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
      case "LetDecl": {
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        this.locals.set(stmt.name, { type: valTy, mutable: false });
        lines.push(`  %${stmt.name}.addr = alloca ${valTy}`);
        lines.push(`  store ${valTy} ${val}, ptr %${stmt.name}.addr`);
        return [lines, false];
      }
      case "VarDecl": {
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        this.locals.set(stmt.name, { type: valTy, mutable: true });
        lines.push(`  %${stmt.name}.addr = alloca ${valTy}`);
        lines.push(`  store ${valTy} ${val}, ptr %${stmt.name}.addr`);
        return [lines, false];
      }
      case "Assign": {
        const local = this.locals.get(stmt.name);
        if (!local) { console.error(`error[codegen]: undefined variable '${stmt.name}'`); process.exit(1); }
        if (!local.mutable) { console.error(`error[codegen]: cannot assign to immutable variable '${stmt.name}'`); process.exit(1); }
        const [exprLines, val] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        lines.push(`  store ${local.type} ${val}, ptr %${stmt.name}.addr`);
        return [lines, false];
      }
      case "Return": {
        if (!stmt.value) {
          lines.push("  ret void");
          return [lines, true];
        }
        const [exprLines, val, valTy] = this.genExpr(stmt.value);
        lines.push(...exprLines);
        lines.push(`  ret ${valTy} ${val}`);
        return [lines, true];
      }
      case "IfStmt":
        return this.genIf(stmt);
      case "WhileStmt":
        return this.genWhile(stmt);
      case "ExprStmt": {
        const [exprLines] = this.genExpr(stmt.expr);
        lines.push(...exprLines);
        return [lines, false];
      }
    }
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
    for (const s of stmt.thenBody) {
      const [sl, t] = this.genStmt(s);
      lines.push(...sl);
      if (t) thenTerminated = true;
    }
    if (!thenTerminated) lines.push(`  br label %${endLabel}`);

    lines.push(`${elseLabel}:`);
    let elseTerminated = false;
    if (stmt.elseBody) {
      for (const s of stmt.elseBody) {
        const [sl, t] = this.genStmt(s);
        lines.push(...sl);
        if (t) elseTerminated = true;
      }
    }
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
    for (const s of stmt.body) {
      const [sl] = this.genStmt(s);
      lines.push(...sl);
    }
    lines.push(`  br label %${condLabel}`);

    lines.push(`${endLabel}:`);
    return [lines, false];
  }

  private genExpr(expr: Expr): [string[], string, string] {
    const lines: string[] = [];

    switch (expr.kind) {
      case "IntLit":
        return [lines, String(expr.value), "i32"];
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
          if (isFloat) {
            lines.push(`  ${tmp} = fcmp ${floatCmps[expr.op]} ${lt} ${lv}, ${rv}`);
          } else {
            lines.push(`  ${tmp} = icmp ${intCmps[expr.op]} ${lt} ${lv}, ${rv}`);
          }
          return [lines, tmp, "i1"];
        }
        console.error(`error[codegen]: unknown binary op '${expr.op}'`);
        process.exit(1);
      }
      case "UnaryOp": {
        const [ol, ov, ot] = this.genExpr(expr.operand);
        lines.push(...ol);
        const tmp = this.nextTemp();
        if (expr.op === "-") {
          if (ot === "float" || ot === "double") {
            lines.push(`  ${tmp} = fneg ${ot} ${ov}`);
          } else {
            lines.push(`  ${tmp} = sub ${ot} 0, ${ov}`);
          }
          return [lines, tmp, ot];
        }
        if (expr.op === "!") {
          lines.push(`  ${tmp} = xor i1 ${ov}, 1`);
          return [lines, tmp, "i1"];
        }
        console.error(`error[codegen]: unknown unary op '${expr.op}'`);
        process.exit(1);
      }
      case "Call": {
        const argVals: { val: string; type: string }[] = [];
        for (const arg of expr.args) {
          const [al, av, at] = this.genExpr(arg);
          lines.push(...al);
          argVals.push({ val: av, type: at });
        }
        const argsStr = argVals.map(a => `${a.type} ${a.val}`).join(", ");
        const retTy = this.fnRetTypes.get(expr.func) ?? "i32";
        if (retTy === "void") {
          lines.push(`  call void @${expr.func}(${argsStr})`);
          return [lines, "void", "void"];
        }
        const tmp = this.nextTemp();
        lines.push(`  ${tmp} = call ${retTy} @${expr.func}(${argsStr})`);
        return [lines, tmp, retTy];
      }
    }
  }
}
