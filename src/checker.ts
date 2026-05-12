import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern, Span } from "./ast";
import { TypeKind, typeFromAst, typeEq, typeName, isNumeric, isCopy } from "./types";
import type { Diagnostic } from "./diagnostics";

interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
}

export interface FnSig {
  params: { type: TypeKind; name: string }[];
  ret: TypeKind;
  variadic: boolean;
}

export interface StructInfo {
  fields: { name: string; type: TypeKind }[];
}

export interface EnumInfo {
  baseName?: string;
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  exprTypes: Map<Expr, TypeKind>;
  autoBorrowed: Map<Expr, { mutable: boolean }>;
  rewrittenCalls: Map<Expr, string>;
  rewrittenEnums: Map<Expr, string>;
  rewrittenStructLits: Map<Expr, string>;
  movedExprs: Set<Expr>;
  functions: Map<string, FnSig>;
  structs: Map<string, StructInfo>;
  enums: Map<string, EnumInfo>;
  monomorphizedFns: Function[];
  monomorphizedEnums: import("./ast").EnumDecl[];
  monomorphizedStructs: StructDecl[];
}

interface GenericEnumInfo {
  typeParams: string[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  decl: import("./ast").EnumDecl;
}

interface GenericStructInfo {
  typeParams: string[];
  fields: { name: string; type: TypeKind }[];
  decl: StructDecl;
}

interface GenericFnInfo {
  typeParams: string[];
  decl: Function;
}

export class TypeChecker {
  private diagnostics: Diagnostic[] = [];
  private functions = new Map<string, FnSig>();
  private genericFns = new Map<string, GenericFnInfo>();
  private structs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private genericEnums = new Map<string, GenericEnumInfo>();
  private genericStructs = new Map<string, GenericStructInfo>();
  private monomorphizedDecls: import("./ast").EnumDecl[] = [];
  private monomorphizedStructDecls: StructDecl[] = [];
  private monomorphizedFns: Function[] = [];
  private scopes: Map<string, VarInfo>[] = [];
  private exprTypes = new Map<Expr, TypeKind>();
  private autoBorrowed = new Map<Expr, { mutable: boolean }>();
  private rewrittenCalls = new Map<Expr, string>();
  private rewrittenEnums = new Map<Expr, string>();
  private rewrittenStructLits = new Map<Expr, string>();
  private movedExprs = new Set<Expr>();
  private currentFnRetType: TypeKind = { tag: "void" };
  private loopDepth = 0;

  private error(msg: string, span?: Span, hint?: string) {
    this.diagnostics.push({ severity: "error", span, message: msg, hint });
  }

  private resolve(ty: MiloType): TypeKind {
    const typeArgs = ty.typeArgs ?? [];
    if (typeArgs.length > 0) {
      const resolvedArgs = typeArgs.map(a => this.resolve(a));
      const ge = this.genericEnums.get(ty.name);
      if (ge) {
        if (resolvedArgs.length !== ge.typeParams.length) {
          this.error(`'${ty.name}' expects ${ge.typeParams.length} type args, got ${resolvedArgs.length}`);
          return { tag: "unknown" };
        }
        return { tag: "enum", name: this.monomorphizeEnum(ty.name, resolvedArgs) };
      }
      const gs = this.genericStructs.get(ty.name);
      if (gs) {
        if (resolvedArgs.length !== gs.typeParams.length) {
          this.error(`'${ty.name}' expects ${gs.typeParams.length} type args, got ${resolvedArgs.length}`);
          return { tag: "unknown" };
        }
        return { tag: "struct", name: this.monomorphizeStruct(ty.name, resolvedArgs) };
      }
      this.error(`'${ty.name}' is not a generic type`);
      return { tag: "unknown" };
    }
    const base = typeFromAst(ty);
    if (base.tag === "struct" && this.enums.has(base.name)) {
      return { tag: "enum", name: base.name };
    }
    return base;
  }

  private mangleTypeName(t: TypeKind): string {
    switch (t.tag) {
      case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
      case "float": return `f${t.bits}`;
      case "bool": return "bool";
      case "void": return "void";
      case "string": return "String";
      case "struct": return t.name;
      case "enum": return t.name;
      case "ptr": return `ptr_${this.mangleTypeName(t.inner)}`;
      case "array": return `arr_${this.mangleTypeName(t.element)}_${t.size}`;
      case "ref": return `ref_${this.mangleTypeName(t.inner)}`;
      case "unknown": return "unknown";
    }
  }

  private monomorphizeEnum(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.enums.has(mangled)) return mangled;

    const generic = this.genericEnums.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
    for (const [vName, vInfo] of generic.variants) {
      variants.set(vName, {
        tag: vInfo.tag,
        fields: vInfo.fields.map(f => this.substituteTypeKind(f, typeMap)),
      });
    }
    this.enums.set(mangled, { baseName, variants });

    const decl: import("./ast").EnumDecl = {
      kind: "EnumDecl",
      name: mangled,
      typeParams: [],
      variants: generic.decl.variants.map(v => ({
        name: v.name,
        fields: v.fields.map(f => this.substituteMiloType(f, generic.typeParams, typeArgs)),
      })),
    };
    this.monomorphizedDecls.push(decl);
    return mangled;
  }

  private monomorphizeStruct(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.structs.has(mangled)) return mangled;

    const generic = this.genericStructs.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    const fields = generic.fields.map(f => ({
      name: f.name,
      type: this.substituteTypeKind(f.type, typeMap),
    }));
    this.structs.set(mangled, { fields });

    const decl: StructDecl = {
      kind: "StructDecl",
      name: mangled,
      typeParams: [],
      fields: generic.decl.fields.map(f => ({
        name: f.name,
        type: this.substituteMiloType(f.type, generic.typeParams, typeArgs),
      })),
    };
    this.monomorphizedStructDecls.push(decl);
    return mangled;
  }

  private substituteTypeKind(t: TypeKind, typeMap: Map<string, TypeKind>): TypeKind {
    if (t.tag === "struct" && typeMap.has(t.name)) return typeMap.get(t.name)!;
    if (t.tag === "array") return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
    if (t.tag === "ref") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    if (t.tag === "ptr") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
    return t;
  }

  private substituteMiloType(ty: MiloType, typeParams: string[], typeArgs: TypeKind[]): MiloType {
    const idx = typeParams.indexOf(ty.name);
    if (idx !== -1 && !ty.isPtr && !ty.isRef && !ty.isRefMut && !ty.isArray) {
      return { ...ty, name: typeName(typeArgs[idx]) };
    }
    return ty;
  }

  private monomorphizeFn(baseName: string, typeArgs: TypeKind[]): string {
    const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
    if (this.functions.has(mangled)) return mangled;

    const generic = this.genericFns.get(baseName)!;
    const typeMap = new Map<string, TypeKind>();
    generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

    // Build concrete param types
    const params = generic.decl.params.map(p => ({
      type: this.substituteTypeKind(this.resolve(p.type), typeMap),
      name: p.name,
    }));
    const ret = this.substituteTypeKind(this.resolve(generic.decl.retType), typeMap);

    // Register the concrete sig so recursive calls and the rest of checking works
    this.functions.set(mangled, { params, ret, variadic: false });

    // Create concrete AST node for codegen
    const concreteDecl: Function = {
      kind: "Function",
      name: mangled,
      typeParams: [],
      params: generic.decl.params.map(p => ({
        name: p.name,
        type: this.substituteMiloType(p.type, generic.typeParams, typeArgs),
      })),
      retType: this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs),
      body: this.substituteBody(generic.decl.body, generic.typeParams, typeArgs),
      isExtern: false,
      isVariadic: false,
    };
    this.monomorphizedFns.push(concreteDecl);

    // Type-check the monomorphized instance
    this.checkFunction(concreteDecl);

    return mangled;
  }

  private substituteBody(stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[]): Stmt[] {
    // Deep clone body with type substitution
    return JSON.parse(JSON.stringify(stmts), (key, value) => {
      if (key === "type" && value && typeof value === "object" && "name" in value) {
        const idx = typeParams.indexOf(value.name);
        if (idx !== -1) return { ...value, name: typeName(typeArgs[idx]) };
      }
      return value;
    });
  }

  private pushScope() { this.scopes.push(new Map()); }
  private popScope() { this.scopes.pop(); }

  private declare(name: string, info: VarInfo) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) { this.error(`variable '${name}' already declared in this scope`); return; }
    scope.set(name, info);
  }

  private lookup(name: string): VarInfo | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const info = this.scopes[i].get(name);
      if (info) return info;
    }
    return null;
  }

  check(program: Program): CheckResult {
    // register built-in functions
    const ptrU8: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
    const i32t: TypeKind = { tag: "int", bits: 32, signed: true };
    this.functions.set("print", { params: [{ type: ptrU8, name: "fmt" }], ret: { tag: "void" }, variadic: true });
    this.functions.set("println", { params: [{ type: ptrU8, name: "fmt" }], ret: { tag: "void" }, variadic: true });
    this.functions.set("exit", { params: [{ type: i32t, name: "code" }], ret: { tag: "void" }, variadic: false });

    // register structs
    for (const s of program.structs) {
      if (s.typeParams.length > 0) {
        const fields = s.fields.map(f => ({ name: f.name, type: typeFromAst(f.type) }));
        this.genericStructs.set(s.name, { typeParams: s.typeParams, fields, decl: s });
      } else {
        const fields = s.fields.map(f => ({ name: f.name, type: this.resolve(f.type) }));
        for (const f of fields) {
          if (f.type.tag === "ref") {
            this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`, undefined, `references are second-class — use an owned type instead`);
          }
        }
        this.structs.set(s.name, { fields });
      }
    }

    // register enums
    for (const e of program.enums) {
      if (e.typeParams.length > 0) {
        const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
        e.variants.forEach((v, i) => {
          variants.set(v.name, { tag: i, fields: v.fields.map(f => typeFromAst(f)) });
        });
        this.genericEnums.set(e.name, { typeParams: e.typeParams, variants, decl: e });
      } else {
        const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
        e.variants.forEach((v, i) => {
          variants.set(v.name, { tag: i, fields: v.fields.map(f => this.resolve(f)) });
        });
        this.enums.set(e.name, { variants });
      }
    }

    // register functions
    for (const fn of program.functions) {
      if (fn.typeParams.length > 0) {
        this.genericFns.set(fn.name, { typeParams: fn.typeParams, decl: fn });
        continue;
      }
      const params = fn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
      const ret = this.resolve(fn.retType);
      if (ret.tag === "ref") {
        this.error(`function '${fn.name}': cannot return a reference`, undefined, `references are second-class — return an owned value instead`);
      }
      this.functions.set(fn.name, { params, ret, variadic: fn.isVariadic });
    }

    for (const fn of program.functions) {
      if (!fn.isExtern && fn.typeParams.length === 0) this.checkFunction(fn);
    }

    return {
      diagnostics: this.diagnostics,
      exprTypes: this.exprTypes,
      autoBorrowed: this.autoBorrowed,
      rewrittenCalls: this.rewrittenCalls,
      rewrittenEnums: this.rewrittenEnums,
      rewrittenStructLits: this.rewrittenStructLits,
      movedExprs: this.movedExprs,
      functions: this.functions,
      structs: this.structs,
      enums: this.enums,
      monomorphizedFns: this.monomorphizedFns,
      monomorphizedEnums: this.monomorphizedDecls,
      monomorphizedStructs: this.monomorphizedStructDecls,
    };
  }

  private checkFunction(fn: Function) {
    this.pushScope();
    const retType = this.resolve(fn.retType);
    this.currentFnRetType = retType;

    for (const p of fn.params) {
      const pType = this.resolve(p.type);
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false });
    }

    for (const stmt of fn.body) this.checkStmt(stmt, retType);
    this.popScope();
  }

  private checkStmt(stmt: Stmt, fnRetType: TypeKind) {
    const sp = stmt.span;
    switch (stmt.kind) {
      case "LetDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        if (hint?.tag === "ref") {
          this.error(`cannot store a reference in variable '${stmt.name}'`, sp);
        }
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: false, moved: false });
        this.tryMove(stmt.value);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        if (hint?.tag === "ref") {
          this.error(`cannot store a reference in variable '${stmt.name}'`, sp);
        }
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`, sp);
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: true, moved: false });
        this.tryMove(stmt.value);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo) break;
        if (!targetInfo.mutable) {
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`, sp, `declare with 'var' instead of 'let' to make it mutable`);
          break;
        }
        const valType = this.checkExprWithHint(stmt.value, targetInfo.type);
        if (!typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: cannot assign ${typeName(valType)} to ${typeName(targetInfo.type)}`, sp);
        }
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          if (info) info.moved = false;
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void") this.error(`return without value in function returning ${typeName(fnRetType)}`, sp);
        } else {
          const valType = this.checkExprWithHint(stmt.value, fnRetType);
          if (!typeEq(fnRetType, valType) && valType.tag !== "unknown") {
            this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`, sp);
          }
          this.tryMove(stmt.value);
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${typeName(condType)}`, sp);
        }
        this.pushScope();
        for (const s of stmt.thenBody) this.checkStmt(s, fnRetType);
        this.popScope();
        if (stmt.elseBody) {
          this.pushScope();
          for (const s of stmt.elseBody) this.checkStmt(s, fnRetType);
          this.popScope();
        }
        break;
      }
      case "WhileStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`while condition must be bool, got ${typeName(condType)}`, sp);
        }
        this.pushScope();
        this.loopDepth++;
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.loopDepth--;
        this.popScope();
        break;
      }
      case "BreakStmt":
        if (this.loopDepth === 0) this.error("'break' outside of loop", sp);
        break;
      case "ContinueStmt":
        if (this.loopDepth === 0) this.error("'continue' outside of loop", sp);
        break;
      case "ExprStmt":
        this.checkExpr(stmt.expr);
        break;
      case "MatchStmt": {
        const subjType = this.checkExpr(stmt.subject);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`match subject must be an enum, got ${typeName(subjType)}`, sp);
          break;
        }
        if (subjType.tag === "enum") {
          const enumInfo = this.enums.get(subjType.name)!;
          const covered = new Set<string>();
          let hasWildcard = false;
          for (const arm of stmt.arms) {
            if (arm.pattern.kind === "WildcardPattern") {
              hasWildcard = true;
            } else {
              const ps = arm.pattern.span;
              if (arm.pattern.enumName !== subjType.name && enumInfo.baseName !== arm.pattern.enumName) {
                this.error(`pattern enum '${arm.pattern.enumName}' does not match subject type '${subjType.name}'`, ps);
              }
              const variant = enumInfo.variants.get(arm.pattern.variant);
              if (!variant) {
                this.error(`enum '${subjType.name}' has no variant '${arm.pattern.variant}'`, ps);
                continue;
              }
              if (covered.has(arm.pattern.variant)) {
                this.error(`duplicate match arm for '${arm.pattern.variant}'`, ps);
              }
              covered.add(arm.pattern.variant);
              if (arm.pattern.bindings.length !== variant.fields.length) {
                this.error(`variant '${arm.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${arm.pattern.bindings.length} bindings`, ps);
              }
            }
            this.pushScope();
            if (arm.pattern.kind === "EnumPattern") {
              const variant = enumInfo.variants.get(arm.pattern.variant);
              if (variant) {
                for (let i = 0; i < Math.min(arm.pattern.bindings.length, variant.fields.length); i++) {
                  this.declare(arm.pattern.bindings[i], { type: variant.fields[i], mutable: false, moved: false });
                }
              }
            }
            for (const s of arm.body) this.checkStmt(s, fnRetType);
            this.popScope();
          }
          if (!hasWildcard) {
            for (const [name] of enumInfo.variants) {
              if (!covered.has(name)) {
                this.error(`non-exhaustive match: missing variant '${name}'`, sp);
              }
            }
          }
        }
        this.tryMove(stmt.subject);
        break;
      }
    }
  }

  // mark a value as moved if it's a non-copy variable
  // auto-deref: &T → T, &mut T → T
  private deref(t: TypeKind): TypeKind {
    if (t.tag === "ref") return t.inner;
    return t;
  }

  private tryMove(expr: Expr) {
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (info && !isCopy(info.type)) {
        info.moved = true;
        this.movedExprs.add(expr);
      }
    }
  }

  private resolveAssignTarget(expr: Expr): { type: TypeKind; mutable: boolean } | null {
    const sp = expr.span;
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) { this.error(`undefined variable '${expr.name}'`, sp); return null; }
      if (info.type.tag === "ref" && info.type.mutable) {
        this.setType(expr, info.type.inner);
        return { type: info.type.inner, mutable: true };
      }
      const t = this.deref(info.type);
      this.setType(expr, t);
      return { type: t, mutable: info.mutable };
    }
    if (expr.kind === "FieldAccess") {
      const objType = this.checkExpr(expr.object);
      if (objType.tag === "struct") {
        const info = this.structs.get(objType.name);
        if (!info) { this.error(`unknown struct '${objType.name}'`, sp); return null; }
        const field = info.fields.find(f => f.name === expr.field);
        if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp); return null; }
        this.setType(expr, field.type);
        const rootMut = this.isRootMutable(expr.object);
        return { type: field.type, mutable: rootMut };
      }
      this.error(`cannot access field on non-struct type ${typeName(objType)}`, sp);
      return null;
    }
    if (expr.kind === "IndexAccess") {
      const objType = this.checkExpr(expr.object);
      this.checkExpr(expr.index);
      if (objType.tag === "array") {
        this.setType(expr, objType.element);
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      this.error(`cannot index non-array type ${typeName(objType)}`, sp);
      return null;
    }
    this.error("invalid assignment target", sp);
    return null;
  }

  private isRootMutable(expr: Expr): boolean {
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      return info?.mutable ?? false;
    }
    if (expr.kind === "FieldAccess") return this.isRootMutable(expr.object);
    if (expr.kind === "IndexAccess") return this.isRootMutable(expr.object);
    return false;
  }

  private describeExpr(expr: Expr): string {
    if (expr.kind === "Ident") return expr.name;
    if (expr.kind === "FieldAccess") return `${this.describeExpr(expr.object)}.${expr.field}`;
    if (expr.kind === "IndexAccess") return `${this.describeExpr(expr.object)}[...]`;
    return "<expr>";
  }

  private checkExprWithHint(expr: Expr, hint: TypeKind | null): TypeKind {
    if (hint && (expr.kind === "IntLit" || expr.kind === "CharLit") && hint.tag === "int") {
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (hint && expr.kind === "FloatLit" && hint.tag === "float") {
      this.exprTypes.set(expr, hint);
      return hint;
    }
    if (expr.kind === "EnumLit" && hint?.tag === "enum") {
      const sp = expr.span;
      const hintEnum = this.enums.get(hint.name);
      if (hintEnum && (hintEnum.baseName === expr.enumName || hint.name === expr.enumName)) {
        const variant = hintEnum.variants.get(expr.variant);
        if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return { tag: "unknown" }; }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
        }
        for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, sp);
          }
        }
        this.rewrittenEnums.set(expr, hint.name);
        this.exprTypes.set(expr, hint);
        return hint;
      }
    }
    return this.checkExpr(expr);
  }

  private setType(expr: Expr, type: TypeKind): TypeKind {
    this.exprTypes.set(expr, type);
    return type;
  }

  private checkExpr(expr: Expr): TypeKind {
    const sp = expr.span;
    switch (expr.kind) {
      case "IntLit":
        return this.setType(expr, { tag: "int", bits: 32, signed: true });
      case "FloatLit":
        return this.setType(expr, { tag: "float", bits: 64 });
      case "BoolLit":
        return this.setType(expr, { tag: "bool" });
      case "CharLit":
        return this.setType(expr, { tag: "int", bits: 8, signed: false });
      case "StringLit":
        return this.setType(expr, { tag: "string" });
      case "Ident": {
        const info = this.lookup(expr.name);
        if (!info) { this.error(`undefined variable '${expr.name}'`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (info.moved) {
          this.error(`use of moved variable '${expr.name}'`, sp, `'${expr.name}' was moved to a new owner and can no longer be used here`);
          return this.setType(expr, this.deref(info.type));
        }
        return this.setType(expr, this.deref(info.type));
      }
      case "BinOp": {
        if (expr.op === "&&" || expr.op === "||") {
          const lt = this.checkExpr(expr.left);
          const rt = this.checkExpr(expr.right);
          if (lt.tag !== "bool" && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(lt)}`, sp);
          if (rt.tag !== "bool" && rt.tag !== "unknown") this.error(`operator '${expr.op}' requires bool, got ${typeName(rt)}`, sp);
          return this.setType(expr, { tag: "bool" });
        }
        let lt = this.checkExpr(expr.left);
        let rt = this.checkExpr(expr.right);
        // Integer literal coercion: widen IntLit to match the other operand's int type
        if (lt.tag === "int" && (expr.right.kind === "IntLit" || expr.right.kind === "CharLit") && !typeEq(lt, rt)) {
          rt = this.checkExprWithHint(expr.right, lt);
        } else if (rt.tag === "int" && (expr.left.kind === "IntLit" || expr.left.kind === "CharLit") && !typeEq(lt, rt)) {
          lt = this.checkExprWithHint(expr.left, rt);
        }
        const arithOps = ["+", "-", "*", "/", "%"];
        const cmpOps = ["==", "!=", "<", ">", "<=", ">="];
        if (expr.op === "+" && lt.tag === "string" && rt.tag === "string") {
          return this.setType(expr, { tag: "string" });
        }
        if ((expr.op === "==" || expr.op === "!=") && lt.tag === "string" && rt.tag === "string") {
          return this.setType(expr, { tag: "bool" });
        }
        if (arithOps.includes(expr.op)) {
          if (!isNumeric(lt) && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`, sp);
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp);
          return this.setType(expr, lt);
        }
        if (cmpOps.includes(expr.op)) {
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`, sp);
          return this.setType(expr, { tag: "bool" });
        }
        this.error(`unknown operator '${expr.op}'`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      case "UnaryOp": {
        const ot = this.checkExpr(expr.operand);
        if (expr.op === "-") {
          if (!isNumeric(ot) && ot.tag !== "unknown") this.error(`unary '-' requires numeric type, got ${typeName(ot)}`, sp);
          return this.setType(expr, ot);
        }
        if (expr.op === "!") {
          if (ot.tag !== "bool" && ot.tag !== "unknown") this.error(`unary '!' requires bool, got ${typeName(ot)}`, sp);
          return this.setType(expr, { tag: "bool" });
        }
        return this.setType(expr, { tag: "unknown" });
      }
      case "Call": {
        // Generic function — infer type params from args, monomorphize
        const genericFn = this.genericFns.get(expr.func);
        if (genericFn) {
          const argTypes: TypeKind[] = [];
          for (const arg of expr.args) argTypes.push(this.checkExpr(arg));

          if (expr.args.length !== genericFn.decl.params.length) {
            this.error(`function '${expr.func}' expects ${genericFn.decl.params.length} args, got ${expr.args.length}`, sp);
            return this.setType(expr, { tag: "unknown" });
          }

          const typeMap = new Map<string, TypeKind>();
          for (let i = 0; i < argTypes.length; i++) {
            const paramTy = genericFn.decl.params[i].type;
            if (genericFn.typeParams.includes(paramTy.name)) {
              const existing = typeMap.get(paramTy.name);
              if (existing && !typeEq(existing, argTypes[i])) {
                this.error(`conflicting inference for type parameter '${paramTy.name}'`, sp);
              } else {
                typeMap.set(paramTy.name, argTypes[i]);
              }
            }
          }

          const missing = genericFn.typeParams.filter(p => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.func}`, sp);
            return this.setType(expr, { tag: "unknown" });
          }

          const typeArgs = genericFn.typeParams.map(p => typeMap.get(p)!);
          const mangled = this.monomorphizeFn(expr.func, typeArgs);
          this.rewrittenCalls.set(expr, mangled);

          for (let i = 0; i < expr.args.length; i++) this.tryMove(expr.args[i]);
          return this.setType(expr, this.functions.get(mangled)!.ret);
        }

        const sig = this.functions.get(expr.func);
        if (!sig) { this.error(`undefined function '${expr.func}'`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (sig.variadic) {
          if (expr.args.length < sig.params.length) this.error(`function '${expr.func}' expects at least ${sig.params.length} args, got ${expr.args.length}`, sp);
        } else if (expr.args.length !== sig.params.length) {
          this.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`, sp);
        }
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          const paramType = sig.params[i].type;
          const hint = paramType.tag === "ref" ? paramType.inner : paramType;
          const argType = this.checkExprWithHint(expr.args[i], hint);
          if (paramType.tag === "ref") {
            this.autoBorrowed.set(expr.args[i], { mutable: paramType.mutable });
            if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
            // String auto-coerces to *u8 for FFI/builtins
            const isStringToPtr = argType.tag === "string" && paramType.tag === "ptr" && paramType.inner.tag === "int" && paramType.inner.bits === 8;
            if (!isStringToPtr) {
              this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          }
        }
        for (let i = sig.params.length; i < expr.args.length; i++) this.checkExpr(expr.args[i]);
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          if (sig.params[i].type.tag === "ref") continue;
          // String→*u8 auto-coercion borrows the ptr, doesn't move the String
          const argType = this.exprTypes.get(expr.args[i]);
          const paramType = sig.params[i].type;
          if (argType?.tag === "string" && paramType.tag === "ptr") continue;
          this.tryMove(expr.args[i]);
        }
        return this.setType(expr, sig.ret);
      }
      case "StructLit": {
        const genericInfo = this.genericStructs.get(expr.name);
        if (genericInfo) {
          const typeMap = new Map<string, TypeKind>();
          for (const f of expr.fields) {
            const fieldDef = genericInfo.fields.find(d => d.name === f.name);
            if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp); continue; }
            const valType = this.checkExpr(f.value);
            if (fieldDef.type.tag === "struct" && genericInfo.typeParams.includes(fieldDef.type.name)) {
              const existing = typeMap.get(fieldDef.type.name);
              if (existing && !typeEq(existing, valType)) {
                this.error(`conflicting inference for type parameter '${fieldDef.type.name}'`, sp);
              } else {
                typeMap.set(fieldDef.type.name, valType);
              }
            }
          }
          const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for struct '${expr.name}'`, sp);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeArgs = genericInfo.typeParams.map(p => typeMap.get(p)!);
          const mangled = this.monomorphizeStruct(expr.name, typeArgs);
          this.rewrittenStructLits.set(expr, mangled);
          const info = this.structs.get(mangled)!;
          for (const f of expr.fields) {
            const fieldDef = info.fields.find(d => d.name === f.name);
            if (!fieldDef) continue;
            const valType = this.exprTypes.get(f.value)!;
            if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
              this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp);
            }
          }
          for (const d of info.fields) {
            if (!expr.fields.find(f => f.name === d.name)) {
              this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
            }
          }
          return this.setType(expr, { tag: "struct", name: mangled });
        }
        const info = this.structs.get(expr.name);
        if (!info) { this.error(`unknown struct '${expr.name}'`, sp); return this.setType(expr, { tag: "unknown" }); }
        for (const f of expr.fields) {
          const fieldDef = info.fields.find(d => d.name === f.name);
          if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`, sp); continue; }
          const valType = this.checkExprWithHint(f.value, fieldDef.type);
          if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
            this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`, sp);
          }
        }
        for (const d of info.fields) {
          if (!expr.fields.find(f => f.name === d.name)) {
            this.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
          }
        }
        return this.setType(expr, { tag: "struct", name: expr.name });
      }
      case "FieldAccess": {
        const objType = this.checkExpr(expr.object);
        if (objType.tag === "struct") {
          const info = this.structs.get(objType.name);
          if (!info) { this.error(`unknown struct '${objType.name}'`, sp); return this.setType(expr, { tag: "unknown" }); }
          const field = info.fields.find(f => f.name === expr.field);
          if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`, sp); return this.setType(expr, { tag: "unknown" }); }
          return this.setType(expr, field.type);
        }
        if (objType.tag === "enum") {
          this.error(`cannot access field on enum '${objType.name}' — use match to extract values`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (objType.tag === "array" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 32, signed: true });
        }
        if (objType.tag === "string" && expr.field === "len") {
          return this.setType(expr, { tag: "int", bits: 64, signed: true });
        }
        this.error(`cannot access field '${expr.field}' on type ${typeName(objType)}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      case "ArrayLit": {
        if (expr.elements.length === 0) {
          this.error("cannot infer type of empty array literal", sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const elemType = this.checkExpr(expr.elements[0]);
        for (let i = 1; i < expr.elements.length; i++) {
          const t = this.checkExpr(expr.elements[i]);
          if (!typeEq(elemType, t) && t.tag !== "unknown") {
            this.error(`array element ${i}: expected ${typeName(elemType)}, got ${typeName(t)}`, expr.elements[i].span);
          }
        }
        return this.setType(expr, { tag: "array", element: elemType, size: expr.elements.length });
      }
      case "IndexAccess": {
        const objType = this.checkExpr(expr.object);
        const idxType = this.checkExpr(expr.index);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") {
          this.error(`array index must be integer, got ${typeName(idxType)}`, sp);
        }
        if (objType.tag === "array") return this.setType(expr, objType.element);
        if (objType.tag === "string") return this.setType(expr, { tag: "int", bits: 8, signed: false });
        this.error(`cannot index type ${typeName(objType)}`, sp);
        return this.setType(expr, { tag: "unknown" });
      }
      case "EnumLit": {
        const genericInfo = this.genericEnums.get(expr.enumName);
        if (genericInfo) {
          const variant = genericInfo.variants.get(expr.variant);
          if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return this.setType(expr, { tag: "unknown" }); }
          if (expr.args.length !== variant.fields.length) {
            this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
          }
          const typeMap = new Map<string, TypeKind>();
          for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
            const argType = this.checkExpr(expr.args[i]);
            const field = variant.fields[i];
            if (field.tag === "struct" && genericInfo.typeParams.includes(field.name)) {
              const existing = typeMap.get(field.name);
              if (existing && !typeEq(existing, argType)) {
                this.error(`conflicting inference for type parameter '${field.name}'`, sp);
              } else {
                typeMap.set(field.name, argType);
              }
            } else if (!typeEq(field, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(field)}, got ${typeName(argType)}`, expr.args[i].span);
            }
          }
          const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.enumName}::${expr.variant}`, sp);
            return this.setType(expr, { tag: "unknown" });
          }
          const typeArgs = genericInfo.typeParams.map(p => typeMap.get(p)!);
          const mangled = this.monomorphizeEnum(expr.enumName, typeArgs);
          this.rewrittenEnums.set(expr, mangled);
          return this.setType(expr, { tag: "enum", name: mangled });
        }
        const info = this.enums.get(expr.enumName);
        if (!info) { this.error(`unknown enum '${expr.enumName}'`, sp); return this.setType(expr, { tag: "unknown" }); }
        const variant = info.variants.get(expr.variant);
        if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return this.setType(expr, { tag: "unknown" }); }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
        }
        for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`, expr.args[i].span);
          }
        }
        return this.setType(expr, { tag: "enum", name: expr.enumName });
      }
      case "Unwrap": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'!' requires Option or Result type, got ${typeName(operandType)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        return this.setType(expr, inner);
      }
      case "Propagate": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'?' requires Option or Result type, got ${typeName(operandType)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        if (!typeEq(this.currentFnRetType, operandType)) {
          this.error(`'?' requires function to return ${typeName(operandType)}, but returns ${typeName(this.currentFnRetType)}`, sp);
        }
        return this.setType(expr, inner);
      }
      case "DefaultValue": {
        const operandType = this.checkExpr(expr.operand);
        const inner = this.unwrapableInner(operandType);
        if (!inner) {
          this.error(`'??' requires Option or Result type, got ${typeName(operandType)}`, sp);
          return this.setType(expr, { tag: "unknown" });
        }
        const defaultType = this.checkExprWithHint(expr.default, inner);
        if (!typeEq(inner, defaultType) && defaultType.tag !== "unknown") {
          this.error(`'??' default type mismatch: expected ${typeName(inner)}, got ${typeName(defaultType)}`, sp);
        }
        return this.setType(expr, inner);
      }
      case "CastExpr": {
        const fromType = this.checkExpr(expr.operand);
        const toType = this.resolve(expr.targetType);
        if (!isNumeric(fromType) && fromType.tag !== "unknown") {
          this.error(`cannot cast from ${typeName(fromType)}`, sp);
        }
        if (!isNumeric(toType)) {
          this.error(`cannot cast to ${typeName(toType)}`, sp);
        }
        return this.setType(expr, toType);
      }
    }
  }

  // extract T from Option-like (Some(T)/None) or Result-like (Ok(T)/Err(E)) enums
  private unwrapableInner(t: TypeKind): TypeKind | null {
    if (t.tag !== "enum") return null;
    const info = this.enums.get(t.name);
    if (!info) return null;
    // Option-like: has Some(T) and None
    const some = info.variants.get("Some");
    const none = info.variants.get("None");
    if (some && none && some.fields.length === 1 && none.fields.length === 0) {
      return some.fields[0];
    }
    // Result-like: has Ok(T) and Err(E)
    const ok = info.variants.get("Ok");
    const err = info.variants.get("Err");
    if (ok && err && ok.fields.length === 1) {
      return ok.fields[0];
    }
    return null;
  }
}
