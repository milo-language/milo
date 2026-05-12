// AST + CheckResult → HIRModule lowering pass.
// Attaches resolved types from checker to every HIR node.

import type { Program, Function as AstFn, Stmt, Expr, Pattern } from "./ast";
import type { CheckResult, FnSig, EnumInfo } from "./checker";
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern, HIRStruct, HIREnum } from "./hir";
import type { TypeKind } from "./types";
import { typeFromAst } from "./types";

export function lower(program: Program, checked: CheckResult): HIRModule {
  const ctx = new LowerCtx(checked);
  return ctx.lowerProgram(program);
}

class LowerCtx {
  private currentRetType: TypeKind = { tag: "void" };
  constructor(private c: CheckResult) {}

  lowerProgram(program: Program): HIRModule {
    const structs: HIRStruct[] = [];
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      const info = this.c.structs.get(s.name);
      if (!info) continue;
      structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type })) });
    }
    for (const s of this.c.monomorphizedStructs) {
      const info = this.c.structs.get(s.name);
      if (!info) continue;
      structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type })) });
    }

    const enums: HIREnum[] = [];
    for (const [name, info] of this.c.enums) {
      const variants: HIREnum["variants"] = [];
      for (const [vName, v] of info.variants) {
        variants.push({ name: vName, tag: v.tag, fields: v.fields });
      }
      enums.push({ name, variants });
    }

    const functions: HIRFunction[] = [];
    for (const fn of program.functions) {
      if (fn.isExtern) {
        functions.push(this.lowerExtern(fn));
        continue;
      }
      if (fn.typeParams.length > 0) continue;
      functions.push(this.lowerFn(fn));
    }
    for (const fn of this.c.monomorphizedFns) {
      functions.push(this.lowerFn(fn));
    }

    return { structs, enums, functions };
  }

  private lowerParam(p: { name: string; type: import("./ast").MiloType }, sig: import("./checker").FnSig | undefined, i: number) {
    const resolved = sig?.params[i]?.type ?? typeFromAst(p.type);
    // For ref params, store the inner type — isRef/isRefMut flags handle the indirection
    const innerType = resolved.tag === "ref" ? resolved.inner : resolved;
    return {
      name: p.name,
      type: innerType,
      isRef: p.type.isRef,
      isRefMut: p.type.isRefMut,
    };
  }

  private lowerExtern(fn: AstFn): HIRFunction {
    const sig = this.c.functions.get(fn.name);
    return {
      name: fn.name,
      params: fn.params.map((p, i) => this.lowerParam(p, sig, i)),
      retType: sig?.ret ?? typeFromAst(fn.retType),
      body: [],
      isExtern: true,
      isVariadic: fn.isVariadic,
    };
  }

  private lowerFn(fn: AstFn): HIRFunction {
    const sig = this.c.functions.get(fn.name);
    const retType = sig?.ret ?? typeFromAst(fn.retType);
    this.currentRetType = retType;
    return {
      name: fn.name,
      params: fn.params.map((p, i) => this.lowerParam(p, sig, i)),
      retType,
      body: fn.body.map(s => this.lowerStmt(s, retType)),
      isExtern: false,
      isVariadic: fn.isVariadic,
    };
  }

  private lowerStmt(stmt: Stmt, fnRetType: TypeKind): HIRStmt {
    switch (stmt.kind) {
      case "LetDecl":
      case "VarDecl": {
        // Value's exprType is already hint-resolved (checker propagated the declared type)
        const valType = this.typeOf(stmt.value) ?? { tag: "unknown" as const };
        return {
          kind: "Let",
          name: stmt.name,
          type: valType,
          value: this.lowerExpr(stmt.value),
          mutable: stmt.kind === "VarDecl",
          span: stmt.span,
        };
      }
      case "Assign":
        return { kind: "Assign", target: this.lowerExpr(stmt.target), value: this.lowerExpr(stmt.value), span: stmt.span };
      case "Return":
        return { kind: "Return", value: stmt.value ? this.lowerExpr(stmt.value) : null, retType: fnRetType, span: stmt.span };
      case "IfStmt":
        return {
          kind: "If",
          cond: this.lowerExpr(stmt.cond),
          thenBody: stmt.thenBody.map(s => this.lowerStmt(s, fnRetType)),
          elseBody: stmt.elseBody ? stmt.elseBody.map(s => this.lowerStmt(s, fnRetType)) : null,
          span: stmt.span,
        };
      case "WhileStmt":
        return {
          kind: "While",
          cond: this.lowerExpr(stmt.cond),
          body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
          span: stmt.span,
        };
      case "ExprStmt":
        return { kind: "ExprStmt", expr: this.lowerExpr(stmt.expr), span: stmt.span };
      case "MatchStmt": {
        const subjType = this.typeOf(stmt.subject);
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        return {
          kind: "Match",
          subject: this.lowerExpr(stmt.subject),
          arms: stmt.arms.map(arm => ({
            pattern: this.lowerPattern(arm.pattern, enumInfo),
            body: arm.body.map(s => this.lowerStmt(s, fnRetType)),
          })),
          enumName,
          span: stmt.span,
        };
      }
    }
  }

  private lowerPattern(pattern: Pattern, enumInfo?: EnumInfo): HIRPattern {
    if (pattern.kind === "WildcardPattern") return { kind: "WildcardPattern" };
    const variant = enumInfo?.variants.get(pattern.variant);
    return {
      kind: "EnumPattern",
      variant: pattern.variant,
      bindings: pattern.bindings.map((name, i) => ({
        name,
        type: variant?.fields[i] ?? { tag: "unknown" as const },
      })),
      tag: variant?.tag ?? 0,
    };
  }

  private lowerExpr(expr: Expr): HIRExpr {
    const type = this.typeOf(expr) ?? { tag: "unknown" as const };

    switch (expr.kind) {
      case "IntLit":
        return { kind: "IntLit", value: expr.value, type, span: expr.span };
      case "FloatLit":
        return { kind: "FloatLit", value: expr.value, type, span: expr.span };
      case "BoolLit":
        return { kind: "BoolLit", value: expr.value, type, span: expr.span };
      case "StringLit":
        return { kind: "StringLit", value: expr.value, type, span: expr.span };
      case "Ident":
        return { kind: "Ident", name: expr.name, type, span: expr.span };
      case "BinOp":
        return { kind: "BinOp", op: expr.op, left: this.lowerExpr(expr.left), right: this.lowerExpr(expr.right), type, span: expr.span };
      case "UnaryOp":
        return { kind: "UnaryOp", op: expr.op, operand: this.lowerExpr(expr.operand), type, span: expr.span };
      case "Call": {
        const funcName = this.c.rewrittenCalls.get(expr) ?? expr.func;
        const sig = this.c.functions.get(funcName);
        const args: HIRArg[] = expr.args.map((arg, i) => {
          const borrowed = this.c.autoBorrowed.get(arg);
          return {
            expr: this.lowerExpr(arg),
            passByRef: !!borrowed,
            refMut: borrowed?.mutable ?? false,
          };
        });
        return { kind: "Call", func: funcName, args, type, variadic: sig?.variadic ?? false, span: expr.span };
      }
      case "StructLit": {
        const structName = this.c.rewrittenStructLits.get(expr) ?? expr.name;
        return {
          kind: "StructLit",
          name: structName,
          fields: expr.fields.map(f => ({ name: f.name, value: this.lowerExpr(f.value) })),
          type: { tag: "struct", name: structName },
          span: expr.span,
        };
      }
      case "FieldAccess": {
        const objType = this.typeOf(expr.object);
        if (objType?.tag === "array" && expr.field === "len") {
          return { kind: "ArrayLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "string" && expr.field === "len") {
          return { kind: "StringLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        return { kind: "FieldAccess", object: this.lowerExpr(expr.object), field: expr.field, type, span: expr.span };
      }
      case "ArrayLit":
        return { kind: "ArrayLit", elements: expr.elements.map(e => this.lowerExpr(e)), type, span: expr.span };
      case "IndexAccess":
        return { kind: "IndexAccess", object: this.lowerExpr(expr.object), index: this.lowerExpr(expr.index), type, span: expr.span };
      case "EnumLit": {
        const enumName = this.c.rewrittenEnums.get(expr) ?? expr.enumName;
        return {
          kind: "EnumLit",
          enumName,
          variant: expr.variant,
          args: expr.args.map(a => this.lowerExpr(a)),
          type: { tag: "enum", name: enumName },
          span: expr.span,
        };
      }
      case "Unwrap": {
        const operandType = this.typeOf(expr.operand);
        return {
          kind: "Unwrap",
          operand: this.lowerExpr(expr.operand),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          type,
          span: expr.span,
        };
      }
      case "Propagate": {
        const operandType = this.typeOf(expr.operand);
        const fnRetType = this.currentRetType;
        return {
          kind: "Propagate",
          operand: this.lowerExpr(expr.operand),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          retType: fnRetType,
          type,
          span: expr.span,
        };
      }
      case "DefaultValue": {
        const operandType = this.typeOf(expr.operand);
        return {
          kind: "DefaultValue",
          operand: this.lowerExpr(expr.operand),
          default: this.lowerExpr(expr.default),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          type,
          span: expr.span,
        };
      }
    }
  }

  private typeOf(expr: Expr): TypeKind | undefined {
    return this.c.exprTypes.get(expr);
  }
}
