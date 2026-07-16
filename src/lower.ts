// AST + CheckResult → HIRModule lowering pass.
// Attaches resolved types from checker to every HIR node.

import type { Program, Function as AstFn, Stmt, Expr, Pattern } from "./ast";
import type { CheckResult, FnSig, EnumInfo } from "./checker";
import type { HIRModule, HIRFunction, HIRStmt, HIRExpr, HIRArg, HIRPattern, HIRStruct, HIREnum, HIRGlobal } from "./hir";
import type { TypeKind } from "./types";
import { typeFromAst } from "./types";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export function lower(program: Program, checked: CheckResult, sourceDir?: string): HIRModule {
  const ctx = new LowerCtx(checked, sourceDir ?? process.cwd());
  return ctx.lowerProgram(program);
}

class LowerCtx {
  private currentRetType: TypeKind = { tag: "void" };
  constructor(private c: CheckResult, private sourceDir: string) {}

  lowerProgram(program: Program): HIRModule {
    const structs: HIRStruct[] = [];
    const opaqueTypes: string[] = [];
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      const info = this.c.structs.get(s.name);
      if (!info) continue;
      if (info.isOpaque) { opaqueTypes.push(s.name); continue; }
      structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type })), isExtern: info.isExtern });
    }
    for (const s of this.c.monomorphizedStructs) {
      const info = this.c.structs.get(s.name);
      if (!info) continue;
      structs.push({ name: s.name, fields: info.fields.map(f => ({ name: f.name, type: f.type })), isExtern: info.isExtern });
    }
    for (const s of this.c.anonStructs) {
      structs.push({ name: s.name, fields: s.fields.map(f => ({ name: f.name, type: f.type })) });
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

    // collect itables for interface coercions
    const itableMap = new Map<string, { concreteType: string; ifaceName: string; methods: string[] }>();
    for (const [, coercion] of this.c.interfaceCoercions) {
      const key = `${coercion.fromType}.${coercion.ifaceName}`;
      if (itableMap.has(key)) continue;
      const iface = this.c.interfaces.get(coercion.ifaceName);
      if (!iface) continue;
      const methods: string[] = [];
      for (const [methodName] of iface.methods) {
        // resolve the concrete method — inherent first, then trait impls
        const inherent = this.c.functions.get(`${coercion.fromType}$${methodName}`);
        if (inherent) {
          methods.push(`${coercion.fromType}$${methodName}`);
        } else {
          // search trait impls for matching method
          let found = false;
          for (const [fnName] of this.c.functions) {
            if (fnName.startsWith(`${coercion.fromType}$`) && fnName.endsWith(`$${methodName}`)) {
              methods.push(fnName);
              found = true;
              break;
            }
          }
          if (!found) methods.push(`${coercion.fromType}$${methodName}`);
        }
      }
      itableMap.set(key, { concreteType: coercion.fromType, ifaceName: coercion.ifaceName, methods });
    }
    const itables = [...itableMap.values()];

    const globals: HIRGlobal[] = [];
    for (const g of program.globals) {
      const type = g.type ? this.c.globalTypes?.get(g.name) ?? typeFromAst(g.type) : this.c.globalTypes?.get(g.name) ?? { tag: "unknown" as const };
      globals.push({
        name: g.name,
        type,
        value: this.lowerExpr(g.value),
        mutable: g.mutable,
        threadLocal: g.threadLocal,
      });
    }

    return { structs, enums, functions, globals, dropImpls: this.c.dropImpls, itables, userFnNames: program.userFnNames, opaqueTypes };
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
    // invariants are attached to their while loops, not the function
    const contracts = fn.contracts
      .filter(c => c.kind !== "invariant")
      .map(c => ({ kind: c.kind, expr: this.lowerExpr(c.expr), span: c.span }));
    return {
      name: fn.name,
      params: fn.params.map((p, i) => this.lowerParam(p, sig, i)),
      retType,
      body: fn.body.map(s => this.lowerStmt(s, retType)),
      ...(contracts.length > 0 && { contracts }),
      isExtern: false,
      isVariadic: fn.isVariadic,
      ...(fn.sourceFile && { sourceFile: fn.sourceFile }),
      // AST fns carry no span; proxy the decl line with the first body stmt that has one
      ...((): { line: number } | {} => {
        const l = fn.body.map(s => s.span?.line).find(x => x !== undefined);
        return l !== undefined ? { line: l } : {};
      })(),
    };
  }

  private lowerStmt(stmt: Stmt, fnRetType: TypeKind): HIRStmt {
    switch (stmt.kind) {
      case "LetDecl":
      case "VarDecl": {
        const value = this.lowerExpr(stmt.value);
        // Use auto-wrapped type (Option<T>) when value was wrapped, otherwise expression type
        const valType = value.type ?? this.typeOf(stmt.value) ?? { tag: "unknown" as const };
        const rangeCheck = this.c.rangeCheckedExprs.get(stmt.value);
        return {
          kind: "Let",
          name: stmt.name,
          type: valType,
          value,
          mutable: stmt.kind === "VarDecl",
          ...(rangeCheck && { rangeCheck }),
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
      case "WhileStmt": {
        const invariants = stmt.invariants.map(c => ({ kind: c.kind, expr: this.lowerExpr(c.expr), span: c.span }));
        return {
          kind: "While",
          cond: this.lowerExpr(stmt.cond),
          body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
          ...(invariants.length > 0 && { invariants }),
          span: stmt.span,
        };
      }
      case "BreakStmt":
        return { kind: "Break", span: stmt.span };
      case "ContinueStmt":
        return { kind: "Continue", span: stmt.span };
      case "ExprStmt":
        return { kind: "ExprStmt", expr: this.lowerExpr(stmt.expr), span: stmt.span };
      case "IfLetStmt": {
        const subjType = this.typeOf(stmt.subject);
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        const arms = [
          {
            pattern: this.lowerPattern(stmt.pattern, enumInfo),
            body: stmt.thenBody.map(s => this.lowerStmt(s, fnRetType)),
          },
        ];
        if (stmt.elseBody) {
          arms.push({
            pattern: { kind: "WildcardPattern" as const },
            body: stmt.elseBody.map(s => this.lowerStmt(s, fnRetType)),
          });
        } else {
          arms.push({
            pattern: { kind: "WildcardPattern" as const },
            body: [],
          });
        }
        return { kind: "Match", subject: this.lowerExpr(stmt.subject), arms, enumName, span: stmt.span };
      }
      case "LetElseStmt": {
        // Desugar `let P(b) = v else { E }` into `let b = match v { P(b') => b', _ => E }`.
        // The match-expr's diverging wildcard arm (E always returns) already
        // type-checks and codegens, and the outer Let makes `b` escape into the
        // enclosing scope — exactly let-else's semantics. Rename the arm-internal
        // binding (b') so its alloca doesn't collide with the outer Let's `b`.
        let subjType = this.typeOf(stmt.value);
        if (subjType?.tag === "ref" && subjType.inner.tag === "enum") subjType = subjType.inner;
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        const binding = stmt.pattern.kind === "EnumPattern" ? (stmt.pattern.bindings[0] ?? "_") : "_";
        const hirPat = this.lowerPattern(stmt.pattern, enumInfo);
        const bindingType = hirPat.kind === "EnumPattern"
          ? (hirPat.bindings[0]?.type ?? { tag: "unknown" as const })
          : { tag: "unknown" as const };
        const innerName = `__letelse_${binding}`;
        if (hirPat.kind === "EnumPattern" && hirPat.bindings[0]) hirPat.bindings[0].name = innerName;
        const matchExpr: HIRExpr = {
          kind: "MatchExpr",
          subject: this.lowerExpr(stmt.value),
          arms: [
            { pattern: hirPat, body: [{ kind: "ExprStmt", expr: { kind: "Ident", name: innerName, type: bindingType, span: stmt.span }, span: stmt.span }] },
            { pattern: { kind: "WildcardPattern" }, body: stmt.elseBody.map(s => this.lowerStmt(s, fnRetType)) },
          ],
          enumName,
          type: bindingType,
          span: stmt.span,
        };
        return { kind: "Let", name: binding, type: bindingType, value: matchExpr, mutable: false, span: stmt.span };
      }
      case "MatchStmt": {
        let subjType = this.typeOf(stmt.subject);
        // Matching on a borrowed enum (`&Enum`): the checker already decided this
        // (reading a ref Ident auto-derefs, hiding the ref from typeOf here).
        const subjectIsRef = this.c.matchSubjectRef.has(stmt.subject);
        if (subjType?.tag === "ref" && subjType.inner.tag === "enum") subjType = subjType.inner;
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
          subjectIsRef,
          span: stmt.span,
        };
      }
      case "UnsafeBlock": {
        return {
          kind: "UnsafeBlock",
          body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
          span: stmt.span,
        };
      }
      case "ForInStmt": {
        if (stmt.iterable.kind === "RangeExpr") {
          const rangeType = this.typeOf(stmt.iterable) ?? { tag: "int" as const, bits: 64, signed: true };
          return {
            kind: "ForRange",
            varName: stmt.varName,
            varType: rangeType,
            start: this.lowerExpr(stmt.iterable.start),
            end: this.lowerExpr(stmt.iterable.end),
            body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
            span: stmt.span,
          };
        }
        const iterInfo = this.c.iteratorForIns?.get(stmt);
        if (iterInfo) {
          return {
            kind: "ForIterator",
            varName: stmt.varName,
            varType: iterInfo.elemType,
            iterable: this.lowerExpr(stmt.iterable),
            nextMethod: iterInfo.nextMethod,
            optionEnumName: iterInfo.optionEnumName,
            body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
            span: stmt.span,
          };
        }
        let iterType = this.typeOf(stmt.iterable);
        // slices (&[T]) and &Vec iterate like vecs — same non-owning %Vec layout
        if (iterType?.tag === "ref" && (iterType.inner.tag === "array" || iterType.inner.tag === "vec")) {
          iterType = iterType.inner;
        }
        if (iterType?.tag === "array" && iterType.size === null) {
          iterType = { tag: "vec", element: iterType.element };
        }
        let iterableKind: "vec" | "string" | "hashmap";
        let varType: TypeKind;
        let varType2: TypeKind | null = null;
        if (iterType?.tag === "vec") {
          iterableKind = "vec";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "ref", inner: iterType.element, mutable: false };
          } else {
            varType = { tag: "ref", inner: iterType.element, mutable: false };
          }
        } else if (iterType?.tag === "string") {
          iterableKind = "string";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "int", bits: 8, signed: false };
          } else {
            varType = { tag: "int", bits: 8, signed: false };
          }
        } else if (iterType?.tag === "hashmap") {
          iterableKind = "hashmap";
          varType = { tag: "ref", inner: iterType.key, mutable: false };
          varType2 = { tag: "ref", inner: iterType.value, mutable: false };
        } else if (iterType?.tag === "array") {
          iterableKind = "array";
          if (stmt.varName2) {
            varType = { tag: "int", bits: 64, signed: true };
            varType2 = { tag: "ref", inner: iterType.element, mutable: false };
          } else {
            varType = { tag: "ref", inner: iterType.element, mutable: false };
          }
        } else {
          iterableKind = "vec";
          varType = { tag: "unknown" };
        }
        return {
          kind: "ForEach",
          varName: stmt.varName,
          varName2: stmt.varName2,
          varType,
          varType2,
          iterable: this.lowerExpr(stmt.iterable),
          iterableKind,
          body: stmt.body.map(s => this.lowerStmt(s, fnRetType)),
          span: stmt.span,
        };
      }
    }
  }

  private lowerPattern(pattern: Pattern, enumInfo?: EnumInfo): HIRPattern {
    if (pattern.kind === "WildcardPattern") return { kind: "WildcardPattern" };
    if (pattern.kind === "LiteralPattern") {
      return { kind: "LiteralPattern", value: pattern.value, literalKind: pattern.literalKind };
    }
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

    // T → Option<T> auto-wrapping: wrap value in Some(value)
    const optionName = this.c.autoWrappedOption.get(expr);
    if (optionName) {
      const inner = this.lowerExprRaw(expr, type);
      const optionType: TypeKind = { tag: "enum", name: optionName };
      return { kind: "EnumLit", enumName: optionName, variant: "Some", args: [inner], type: optionType, span: expr.span };
    }

    // concrete → interface coercion: build fat pointer { data, itable }
    const ifaceCoercion = this.c.interfaceCoercions.get(expr);
    if (ifaceCoercion) {
      const inner = this.lowerExprRaw(expr, type);
      const ifaceInner: TypeKind = { tag: "interface", name: ifaceCoercion.ifaceName };
      // preserve Heap wrapper: Heap<T> → Heap<Interface> keeps Heap tag for drop semantics
      const coerceType: TypeKind = type.tag === "heap" ? { tag: "heap", inner: ifaceInner } : ifaceInner;
      return { kind: "InterfaceCoerce", value: inner, fromType: ifaceCoercion.fromType, ifaceName: ifaceCoercion.ifaceName, type: coerceType, span: expr.span };
    }

    return this.lowerExprRaw(expr, type);
  }

  private lowerExprRaw(expr: Expr, type: TypeKind): HIRExpr {
    switch (expr.kind) {
      case "IntLit":
        return { kind: "IntLit", value: expr.value, type, span: expr.span };
      case "FloatLit":
        return { kind: "FloatLit", value: expr.value, type, span: expr.span };
      case "BoolLit":
        return { kind: "BoolLit", value: expr.value, type, span: expr.span };
      case "CharLit":
        return { kind: "CharLit", value: expr.value, type, span: expr.span };
      case "StringLit":
        return { kind: "StringLit", value: expr.value, type, span: expr.span };
      case "Ident":
        return { kind: "Ident", name: expr.name, type, isMove: this.c.movedExprs.has(expr), span: expr.span };
      case "BinOp": {
        const resolvedOp = this.c.resolvedOperators.get(expr);
        if (resolvedOp) {
          const args: HIRArg[] = [expr.left, expr.right].map(a => ({
            expr: this.lowerExpr(a),
            passByRef: !!this.c.autoBorrowed.get(a),
            refMut: false,
          }));
          const call: HIRExpr = { kind: "Call", func: resolvedOp, args, type, variadic: false, span: expr.span };
          if (expr.op === "!=") {
            return { kind: "UnaryOp", op: "!", operand: call, type: { tag: "bool" }, span: expr.span };
          }
          return call;
        }
        return { kind: "BinOp", op: expr.op, left: this.lowerExpr(expr.left), right: this.lowerExpr(expr.right), type, span: expr.span };
      }
      case "UnaryOp":
        if (expr.op === "*") {
          const operandType = this.c.exprTypes.get(expr.operand);
          if (operandType?.tag === "ptr") return { kind: "PtrDeref", operand: this.lowerExpr(expr.operand), type, span: expr.span };
          return { kind: "HeapDeref", operand: this.lowerExpr(expr.operand), type, span: expr.span };
        }
        return { kind: "UnaryOp", op: expr.op, operand: this.lowerExpr(expr.operand), type, span: expr.span };
      case "Call": {
        if (expr.func === "sizeOf") {
          const sizeType = this.c.sizeOfTypes.get(expr);
          if (!sizeType) throw new Error("sizeOf: missing resolved type");
          return { kind: "SizeOf", sizeType, type, span: expr.span };
        }
        if (expr.func === "offsetOf") {
          const sizeType = this.c.sizeOfTypes.get(expr);
          if (!sizeType) throw new Error("offsetOf: missing resolved type");
          const fieldName = this.c.offsetOfFields.get(expr);
          if (!fieldName) throw new Error("offsetOf: missing field name");
          return { kind: "OffsetOf", sizeType, fieldName, type, span: expr.span };
        }
        if (expr.func === "zeroed") {
          const zeroType = this.c.sizeOfTypes.get(expr);
          if (!zeroType) throw new Error("zeroed: missing resolved type");
          return { kind: "Zeroed", zeroType, type: zeroType, span: expr.span };
        }
        if (expr.func === "Heap") {
          return { kind: "HeapCreate", value: this.lowerExpr(expr.args[0]), type, span: expr.span };
        }
        if (expr.func === "embedFile") {
          const path = (expr.args[0] as { value: string }).value;
          const absPath = resolve(this.sourceDir, path);
          if (!existsSync(absPath)) {
            throw new Error(`error[embed]: ${expr.span?.line}:${expr.span?.col}: cannot open '${path}'`);
          }
          const contents = readFileSync(absPath, "utf-8");
          return { kind: "StringLit", value: contents, type: { tag: "string" as const }, span: expr.span };
        }
        if (expr.func === "jsonStringify") {
          const argType = this.typeOf(expr.args[0]) ?? { tag: "unknown" as const };
          return { kind: "JsonStringify", value: this.lowerExpr(expr.args[0]), valueType: argType, type, span: expr.span };
        }
        const closureFnType = this.c.closureCalls.get(expr);
        if (closureFnType) {
          const args: HIRArg[] = expr.args.map(arg => {
            const borrowed = this.c.autoBorrowed.get(arg);
            return {
              expr: this.lowerExpr(arg),
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false,
            };
          });
          return {
            kind: "ClosureCall",
            callee: { kind: "Ident", name: expr.func, type: closureFnType, span: expr.span },
            args,
            type,
            span: expr.span,
          };
        }
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
        const rawObjType = this.typeOf(expr.object);
        // auto-deref `&T` so .len works on slices
        const objType = rawObjType?.tag === "ref" ? rawObjType.inner : rawObjType;
        if (objType?.tag === "array" && expr.field === "len") {
          return { kind: "ArrayLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "string" && expr.field === "len") {
          return { kind: "StringLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "vec" && expr.field === "len") {
          return { kind: "VecLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "hashmap" && expr.field === "len") {
          return { kind: "HashMapLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        return { kind: "FieldAccess", object: this.lowerExpr(expr.object), field: expr.field, type, isMove: this.c.movedExprs.has(expr), span: expr.span };
      }
      case "ArrayLit":
        if (this.c.arrayToVecCoercions.has(expr)) {
          const vecType: TypeKind = { tag: "vec", element: type.tag === "array" ? type.element : type };
          return { kind: "ArrayLit", elements: expr.elements.map(e => this.lowerExpr(e)), type: vecType, span: expr.span };
        }
        return { kind: "ArrayLit", elements: expr.elements.map(e => this.lowerExpr(e)), type, span: expr.span };
      case "ArrayRepeat":
        return { kind: "ArrayRepeat", value: this.lowerExpr(expr.value), count: expr.count, type, span: expr.span };
      case "IndexAccess":
        return { kind: "IndexAccess", object: this.lowerExpr(expr.object), index: this.lowerExpr(expr.index), type, isMove: this.c.movedExprs.has(expr), isBorrowed: this.c.borrowedExprs.has(expr), span: expr.span };
      case "EnumLit": {
        if (expr.enumName === "String" && expr.variant === "withCapacity") {
          return { kind: "StringWithCapacity", capacity: this.lowerExpr(expr.args[0]), type: { tag: "string" }, span: expr.span };
        }
        if (expr.enumName === "Vec" && expr.variant === "new" && type.tag === "vec") {
          return { kind: "VecNew", elementType: type.element, type, span: expr.span };
        }
        if (expr.enumName === "Vec" && expr.variant === "withCapacity" && type.tag === "vec") {
          return { kind: "VecWithCapacity", capacity: this.lowerExpr(expr.args[0]), elementType: type.element, type, span: expr.span };
        }
        if (expr.enumName === "Vec" && expr.variant === "filled" && type.tag === "vec") {
          return { kind: "VecFilled", count: this.lowerExpr(expr.args[0]), value: this.lowerExpr(expr.args[1]), elementType: type.element, type, span: expr.span };
        }
        if (expr.enumName === "HashMap" && expr.variant === "new" && type.tag === "hashmap") {
          return { kind: "HashMapNew", keyType: type.key, valueType: type.value, type, span: expr.span };
        }
        const rewrittenCall = this.c.rewrittenCalls.get(expr as any);
        if (rewrittenCall) {
          const sig = this.c.functions.get(rewrittenCall);
          const args: HIRArg[] = expr.args.map((arg, i) => {
            const borrowed = this.c.autoBorrowed.get(arg);
            return {
              expr: this.lowerExpr(arg),
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false,
            };
          });
          return { kind: "Call", func: rewrittenCall, args, type, variadic: sig?.variadic ?? false, span: expr.span };
        }
        const staticMangled = this.c.staticCalls.get(expr);
        if (staticMangled) {
          const sig = this.c.functions.get(staticMangled);
          const args: HIRArg[] = expr.args.map((arg, i) => {
            const borrowed = this.c.autoBorrowed.get(arg);
            return {
              expr: this.lowerExpr(arg),
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false,
            };
          });
          return { kind: "Call", func: staticMangled, args, type, variadic: sig?.variadic ?? false, span: expr.span };
        }
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
        const fromConversion = this.c.propagateConversions.get(expr);
        return {
          kind: "Propagate",
          operand: this.lowerExpr(expr.operand),
          enumName: operandType?.tag === "enum" ? operandType.name : "",
          retType: fnRetType,
          fromConversion,
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
      case "CastExpr":
        return {
          kind: "Cast",
          operand: this.lowerExpr(expr.operand),
          targetType: type,
          type,
          span: expr.span,
        };
      case "MethodCall": {
        const rawObjType = this.typeOf(expr.object);
        // auto-deref `&T` so methods (.substr, .len, .clone, etc.) dispatch through slices
        const objType = rawObjType?.tag === "ref" ? rawObjType.inner : rawObjType;
        // x.addrOf() → the same address-of the old `&x` emitted, so codegen and
        // hence the selfhost output are byte-identical for migrated sites.
        if (expr.method === "addrOf") {
          return { kind: "UnaryOp", op: "&", operand: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "vec" && expr.method === "ptr") {
          return { kind: "VecPtr", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if ((objType?.tag === "int" || objType?.tag === "float") && expr.method === "toString") {
          return { kind: "NumberToString", value: this.lowerExpr(expr.object), valueType: objType, type, span: expr.span };
        }
        if (objType?.tag === "bool" && expr.method === "toString") {
          return { kind: "BoolToString", value: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "enum" && this.c.enums.get(objType.name)?.baseName === "Option"
            && (expr.method === "isSome" || expr.method === "isNone" || expr.method === "unwrapOr")) {
          return {
            kind: "OptionOp", op: expr.method, value: this.lowerExpr(expr.object),
            default: expr.method === "unwrapOr" ? this.lowerExpr(expr.args[0]) : undefined,
            enumName: objType.name, type, span: expr.span,
          };
        }
        // Result isOk/isErr/unwrapOr reuse OptionOp — Ok is tag 0 like Some, so
        // isOk maps to the isSome (tag==0) test and isErr to isNone.
        if (objType?.tag === "enum" && this.c.enums.get(objType.name)?.baseName === "Result"
            && (expr.method === "isOk" || expr.method === "isErr" || expr.method === "unwrapOr")) {
          const op = expr.method === "isOk" ? "isSome" : expr.method === "isErr" ? "isNone" : "unwrapOr";
          return {
            kind: "OptionOp", op, value: this.lowerExpr(expr.object),
            default: expr.method === "unwrapOr" ? this.lowerExpr(expr.args[0]) : undefined,
            enumName: objType.name, type, span: expr.span,
          };
        }
        if (objType?.tag === "int") {
          const bitIntrinsics: Record<string, string> = {
            countOnes: "ctpop", leadingZeros: "ctlz", trailingZeros: "cttz", reverseBits: "bitreverse",
          };
          if (bitIntrinsics[expr.method]) {
            return { kind: "BitIntrinsic", intrinsic: bitIntrinsics[expr.method], value: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "rotateLeft" || expr.method === "rotateRight") {
            return { kind: "BitIntrinsic", intrinsic: expr.method === "rotateLeft" ? "fshl" : "fshr", value: this.lowerExpr(expr.object), amount: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          // x.wrappingNeg() / x.checkedNeg() → wrapping/checked sub(0, x)
          if (expr.method === "wrappingNeg" || expr.method === "checkedNeg") {
            const right = this.lowerExpr(expr.object);
            const zero: import("./hir").HIRExpr = { kind: "IntLit", value: 0n, type: objType, span: expr.span };
            if (expr.method === "wrappingNeg") {
              return { kind: "WrappingArith", op: "sub", left: zero, right, type, span: expr.span };
            }
            const optName = type.tag === "enum" ? type.name : "Option_" + (objType.signed ? "i" : "u") + objType.bits;
            return { kind: "CheckedArith", op: "sub", left: zero, right, optionEnumName: optName, type, span: expr.span };
          }
          const opMap: Record<string, string> = {
            wrappingAdd: "add", wrappingSub: "sub", wrappingMul: "mul",
            saturatingAdd: "add", saturatingSub: "sub", saturatingMul: "mul",
            checkedAdd: "add", checkedSub: "sub", checkedMul: "mul",
            checkedDiv: "div", checkedRem: "rem",
          };
          const op = opMap[expr.method];
          if (op) {
            const left = this.lowerExpr(expr.object);
            const right = this.lowerExpr(expr.args[0]);
            if (expr.method.startsWith("wrapping")) {
              return { kind: "WrappingArith", op, left, right, type, span: expr.span };
            }
            if (expr.method.startsWith("saturating")) {
              return { kind: "SaturatingArith", op, left, right, type, span: expr.span };
            }
            if (expr.method.startsWith("checked")) {
              const optName = type.tag === "enum" ? type.name : "Option_" + (objType.signed ? "i" : "u") + objType.bits;
              return { kind: "CheckedArith", op, left, right, optionEnumName: optName, type, span: expr.span };
            }
          }
        }
        // slice creation (v[a..b] desugar) and slice methods — slices are arrays
        // with size null whose runtime rep is a non-owning %Vec
        if ((objType?.tag === "vec" || objType?.tag === "array") && expr.method === "slice") {
          const elementType = objType.element;
          return { kind: "VecSlice", vec: this.lowerExpr(expr.object), start: this.lowerExpr(expr.args[0]), end: this.lowerExpr(expr.args[1]), elementType, type, span: expr.span };
        }
        if (objType?.tag === "array" && objType.size === null && expr.method === "len") {
          return { kind: "ArrayLen", object: this.lowerExpr(expr.object), type, span: expr.span };
        }
        if (objType?.tag === "vec") {
          if (expr.method === "push") {
            return { kind: "VecPush", vec: this.lowerExpr(expr.object), value: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "pop") {
            return { kind: "VecPop", vec: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "map") {
            const resultElem = type.tag === "vec" ? type.element : { tag: "unknown" as const };
            return { kind: "VecMap", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, resultElementType: resultElem, type, span: expr.span };
          }
          if (expr.method === "filter") {
            return { kind: "VecFilter", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "each") {
            return { kind: "VecEach", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "enumerate") {
            return { kind: "VecEnumerate", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "find") {
            const optionEnumName = type.tag === "enum" ? type.name : "";
            return { kind: "VecFind", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, optionEnumName, type, span: expr.span };
          }
          if (expr.method === "any") {
            return { kind: "VecAny", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "all") {
            return { kind: "VecAll", vec: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "join") {
            const args: HIRArg[] = [
              { expr: this.lowerExpr(expr.object), passByRef: true, refMut: false },
              { expr: this.lowerExpr(expr.args[0]), passByRef: true, refMut: false },
            ];
            return { kind: "Call", func: "vecJoin", args, type, variadic: false, span: expr.span };
          }
          if (expr.method === "isEmpty") {
            return { kind: "VecIsEmpty", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "contains") {
            return { kind: "VecContains", vec: this.lowerExpr(expr.object), value: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "reverse") {
            return { kind: "VecReverse", object: this.lowerExpr(expr.object), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "swap") {
            return { kind: "VecSwap", object: this.lowerExpr(expr.object), indexA: this.lowerExpr(expr.args[0]), indexB: this.lowerExpr(expr.args[1]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "insert") {
            return { kind: "VecInsert", object: this.lowerExpr(expr.object), index: this.lowerExpr(expr.args[0]), value: this.lowerExpr(expr.args[1]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "remove") {
            return { kind: "VecRemove", object: this.lowerExpr(expr.object), index: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "sort") {
            return { kind: "VecSort", object: this.lowerExpr(expr.object), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "sortBy") {
            return { kind: "VecSortBy", object: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, type, span: expr.span };
          }
          if (expr.method === "sortByKey") {
            const cbType = this.c.exprTypes.get(expr.args[0]);
            const keyType: TypeKind = cbType?.tag === "fn" ? cbType.ret : { tag: "unknown" };
            return { kind: "VecSortByKey", object: this.lowerExpr(expr.object), callback: this.lowerExpr(expr.args[0]), elementType: objType.element, keyType, type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "VecLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
        }
        if (objType?.tag === "hashmap") {
          if (expr.method === "insert") {
            return { kind: "HashMapInsert", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), value: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "get") {
            const optionEnumName = type.tag === "enum" ? type.name : "";
            return { kind: "HashMapGet", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), optionEnumName, type, span: expr.span };
          }
          if (expr.method === "getOrDefault") {
            return { kind: "HashMapGetOrDefault", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), default: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "contains") {
            return { kind: "HashMapContains", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "remove") {
            return { kind: "HashMapRemove", map: this.lowerExpr(expr.object), key: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "HashMapLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
        }
        if (objType?.tag === "string") {
          if (expr.method === "push") {
            return { kind: "StringPush", str: this.lowerExpr(expr.object), byte: this.lowerExpr(expr.args[0]), type, span: expr.span };
          }
          if (expr.method === "substr") {
            return { kind: "StringSubstr", str: this.lowerExpr(expr.object), start: this.lowerExpr(expr.args[0]), end: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "slice") {
            return { kind: "StringSlice", str: this.lowerExpr(expr.object), start: this.lowerExpr(expr.args[0]), end: this.lowerExpr(expr.args[1]), type, span: expr.span };
          }
          if (expr.method === "parseF64") {
            return { kind: "StringParseF64", str: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "clone") {
            return { kind: "StringClone", str: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "len") {
            return { kind: "StringLen", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
          if (expr.method === "cstr") {
            return { kind: "StringCstr", object: this.lowerExpr(expr.object), type, span: expr.span };
          }
          // methods delegated to std/string runtime functions
          const strMethodMap: Record<string, string> = {
            "contains": "strContains", "startsWith": "strStartsWith", "endsWith": "strEndsWith",
            "indexOf": "strIndexOf", "lastIndexOf": "strLastIndexOf", "split": "strSplit", "trim": "strTrim",
            "trimStart": "strTrimStart", "trimEnd": "strTrimEnd",
            "toLower": "strToLower", "toUpper": "strToUpper", "reverse": "strReverse",
            "replace": "strReplace", "replaceFirst": "strReplaceFirst",
            "repeat": "strRepeat", "padStart": "strPadStart", "padEnd": "strPadEnd",
            "isEmpty": "strIsEmpty", "charAt": "strCharAt", "parseInt": "strParseInt",
            "splitWords": "strSplitWords", "splitWhitespace": "strSplitWhitespace",
          };
          const fnName = strMethodMap[expr.method];
          if (fnName) {
            const args: HIRArg[] = [
              { expr: this.lowerExpr(expr.object), passByRef: true, refMut: false },
              ...expr.args.map(a => ({ expr: this.lowerExpr(a), passByRef: true, refMut: false })),
            ];
            // methods with i64 params: pass by value, not by ref
            if ((expr.method === "repeat" || expr.method === "padStart" || expr.method === "padEnd" || expr.method === "charAt") && args.length > 1) {
              args[1] = { ...args[1], passByRef: false };
            }
            return { kind: "Call", func: fnName, args, type, variadic: false, span: expr.span };
          }
        }
        // interface virtual method call
        const ifaceCall = this.c.interfaceMethodCalls.get(expr);
        if (ifaceCall) {
          const args: HIRArg[] = expr.args.map(a => {
            const borrowed = this.c.autoBorrowed.get(a);
            return { expr: this.lowerExpr(a), passByRef: !!borrowed, refMut: borrowed?.mutable ?? false };
          });
          return {
            kind: "InterfaceMethodCall",
            object: this.lowerExpr(expr.object),
            ifaceName: ifaceCall.ifaceName,
            methodIndex: ifaceCall.methodIndex,
            args,
            type,
            span: expr.span,
          };
        }
        // user-defined method (trait or inherent)
        const resolved = this.c.resolvedMethods.get(expr);
        if (resolved) {
          const sig = this.c.functions.get(resolved)!;
          const heapRecv = this.c.heapMethodReceivers.has(expr);
          const allExprs = [expr.object, ...expr.args];
          const args: HIRArg[] = allExprs.map((a, i) => {
            const borrowed = this.c.autoBorrowed.get(a);
            const jsonType = this.c.autoJsonStringify.get(a);
            let lowered = this.lowerExpr(a);
            if (jsonType) {
              lowered = { kind: "JsonStringify", value: lowered, valueType: jsonType, type: { tag: "string" }, span: a.span };
            }
            // `h.m()` on a `Heap<T>` receiver means `(*h).m()`; make the deref
            // explicit so codegen passes the pointee, not the Heap slot's address.
            if (i === 0 && heapRecv) {
              const ht = this.typeOf(expr.object);
              const inner = ht && ht.tag === "heap" ? ht.inner
                : ht && ht.tag === "ref" && ht.inner.tag === "heap" ? ht.inner.inner
                : lowered.type;
              lowered = { kind: "HeapDeref", operand: lowered, type: inner, span: a.span };
            }
            return {
              expr: lowered,
              passByRef: !!borrowed,
              refMut: borrowed?.mutable ?? false,
            };
          });
          return { kind: "Call", func: resolved, args, type, variadic: false, span: expr.span };
        }
        // fn-typed struct field call: h.apply(args) → ClosureCall(FieldAccess(h, "apply"), args)
        if (this.c.fnFieldCalls.has(expr)) {
          const callee: HIRExpr = {
            kind: "FieldAccess",
            object: this.lowerExpr(expr.object),
            field: expr.method,
            type: { tag: "fn" as const, params: [], ret: type },
          };
          const fnType = this.typeOf(expr);
          const objFnType = this.c.exprTypes.get(expr);
          const args: HIRArg[] = expr.args.map((a, i) => {
            const borrowed = this.c.autoBorrowed.get(a);
            return { expr: this.lowerExpr(a), passByRef: !!borrowed, refMut: borrowed?.mutable ?? false };
          });
          return { kind: "ClosureCall", callee, args, type, span: expr.span };
        }
        throw new Error(`unsupported method call: ${expr.method}`);
      }
      case "Closure": {
        const captures = this.c.closureCaptures.get(expr) ?? [];
        const retType = type.tag === "fn" ? type.ret : { tag: "void" as const };
        return {
          kind: "Closure",
          params: expr.params.map(p => {
            const pType = this.c.exprTypes.get(expr);
            const resolvedType = pType?.tag === "fn" ? pType.params[expr.params.indexOf(p)] : { tag: "unknown" as const };
            return { name: p.name, type: resolvedType };
          }),
          body: expr.body.map(s => this.lowerStmt(s, retType)),
          captures,
          retType,
          type,
          isMove: (expr as any).isMove,
          span: expr.span,
        };
      }
      case "RangeExpr":
        throw new Error("RangeExpr should not appear in lowerExprRaw — handled by ForInStmt");
      case "IsExpr": {
        const operand = this.lowerExpr(expr.operand);
        const opType = this.typeOf(expr.operand);
        let tag = -1;
        if (expr.pattern.kind === "EnumPattern" && opType?.tag === "enum") {
          const enumInfo = this.c.enums.get(opType.name);
          if (enumInfo) {
            const variant = enumInfo.variants.get(expr.pattern.variant);
            if (variant) tag = variant.tag;
          }
        }
        return { kind: "IsCheck", operand, tag, type: { tag: "bool" }, span: expr.span };
      }
      case "IfExpr": {
        const fnRetType = this.currentRetType;
        return {
          kind: "IfExpr",
          cond: this.lowerExpr(expr.cond),
          thenBody: expr.thenBody.map(s => this.lowerStmt(s, fnRetType)),
          elseBody: expr.elseBody.map(s => this.lowerStmt(s, fnRetType)),
          type,
          span: expr.span,
        };
      }
      case "MatchExpr": {
        const fnRetType = this.currentRetType;
        let subjType = this.typeOf(expr.subject);
        const subjectIsRef = this.c.matchSubjectRef.has(expr.subject);
        if (subjType?.tag === "ref" && subjType.inner.tag === "enum") subjType = subjType.inner;
        const enumName = subjType?.tag === "enum" ? subjType.name : "";
        const enumInfo = this.c.enums.get(enumName);
        return {
          kind: "MatchExpr",
          subject: this.lowerExpr(expr.subject),
          arms: expr.arms.map(arm => ({
            pattern: this.lowerPattern(arm.pattern, enumInfo),
            body: arm.body.map(s => this.lowerStmt(s, fnRetType)),
          })),
          enumName,
          subjectIsRef,
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
