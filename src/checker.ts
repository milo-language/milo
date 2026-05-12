import type { Program, Function, Stmt, Expr, MiloType, StructDecl, Pattern } from "./ast";
import { TypeKind, typeFromAst, typeEq, typeName, isNumeric, isCopy } from "./types";

interface VarInfo {
  type: TypeKind;
  mutable: boolean;
  moved: boolean;
}

interface FnSig {
  params: { type: TypeKind; name: string }[];
  ret: TypeKind;
  variadic: boolean;
}

interface StructInfo {
  fields: { name: string; type: TypeKind }[];
}

interface EnumInfo {
  baseName?: string;
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
}

interface GenericEnumInfo {
  typeParams: string[];
  variants: Map<string, { tag: number; fields: TypeKind[] }>;
  decl: import("./ast").EnumDecl;
}

export class TypeChecker {
  private errors: string[] = [];
  private functions = new Map<string, FnSig>();
  private structs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private genericEnums = new Map<string, GenericEnumInfo>();
  private monomorphizedDecls: import("./ast").EnumDecl[] = [];
  private scopes: Map<string, VarInfo>[] = [];

  private error(msg: string) { this.errors.push(msg); }

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

  check(program: Program): string[] {
    // register structs
    for (const s of program.structs) {
      const fields = s.fields.map(f => ({ name: f.name, type: this.resolve(f.type) }));
      // reject references in struct fields
      for (const f of fields) {
        if (f.type.tag === "ref") {
          this.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`);
        }
      }
      this.structs.set(s.name, { fields });
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
      const params = fn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
      const ret = this.resolve(fn.retType);
      // second-class refs: reject ref return types
      if (ret.tag === "ref") {
        this.error(`function '${fn.name}': cannot return a reference`);
      }
      this.functions.set(fn.name, { params, ret, variadic: fn.isVariadic });
    }

    for (const fn of program.functions) {
      if (!fn.isExtern) this.checkFunction(fn);
    }

    // add monomorphized enum declarations for codegen
    for (const decl of this.monomorphizedDecls) {
      program.enums.push(decl);
    }

    return this.errors;
  }

  private checkFunction(fn: Function) {
    this.pushScope();
    const retType = this.resolve(fn.retType);

    for (const p of fn.params) {
      const pType = this.resolve(p.type);
      this.declare(p.name, { type: pType, mutable: pType.tag === "ref" && pType.mutable, moved: false });
    }

    for (const stmt of fn.body) this.checkStmt(stmt, retType);
    this.popScope();
  }

  private checkStmt(stmt: Stmt, fnRetType: TypeKind) {
    switch (stmt.kind) {
      case "LetDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        if (hint?.tag === "ref") {
          this.error(`cannot store a reference in variable '${stmt.name}'`);
        }
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`);
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: false, moved: false });
        this.tryMove(stmt.value);
        break;
      }
      case "VarDecl": {
        const hint = stmt.type ? this.resolve(stmt.type) : null;
        if (hint?.tag === "ref") {
          this.error(`cannot store a reference in variable '${stmt.name}'`);
        }
        const valType = this.checkExprWithHint(stmt.value, hint);
        if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: '${stmt.name}' declared as ${typeName(hint)} but got ${typeName(valType)}`);
        }
        this.declare(stmt.name, { type: hint ?? valType, mutable: true, moved: false });
        this.tryMove(stmt.value);
        break;
      }
      case "Assign": {
        const targetInfo = this.resolveAssignTarget(stmt.target);
        if (!targetInfo) break;
        if (!targetInfo.mutable) {
          this.error(`cannot assign to immutable variable '${this.describeExpr(stmt.target)}'`);
          break;
        }
        const valType = this.checkExpr(stmt.value);
        if (!typeEq(targetInfo.type, valType) && valType.tag !== "unknown") {
          this.error(`type mismatch: cannot assign ${typeName(valType)} to ${typeName(targetInfo.type)}`);
        }
        // reassignment un-moves the root variable
        if (stmt.target.kind === "Ident") {
          const info = this.lookup(stmt.target.name);
          if (info) info.moved = false;
        }
        this.tryMove(stmt.value);
        break;
      }
      case "Return": {
        if (!stmt.value) {
          if (fnRetType.tag !== "void") this.error(`return without value in function returning ${typeName(fnRetType)}`);
        } else {
          const valType = this.checkExpr(stmt.value);
          if (!typeEq(fnRetType, valType) && valType.tag !== "unknown") {
            this.error(`return type mismatch: expected ${typeName(fnRetType)}, got ${typeName(valType)}`);
          }
          this.tryMove(stmt.value);
        }
        break;
      }
      case "IfStmt": {
        const condType = this.checkExpr(stmt.cond);
        if (condType.tag !== "bool" && condType.tag !== "unknown") {
          this.error(`if condition must be bool, got ${typeName(condType)}`);
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
          this.error(`while condition must be bool, got ${typeName(condType)}`);
        }
        this.pushScope();
        for (const s of stmt.body) this.checkStmt(s, fnRetType);
        this.popScope();
        break;
      }
      case "ExprStmt":
        this.checkExpr(stmt.expr);
        break;
      case "MatchStmt": {
        const subjType = this.checkExpr(stmt.subject);
        if (subjType.tag !== "enum" && subjType.tag !== "unknown") {
          this.error(`match subject must be an enum, got ${typeName(subjType)}`);
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
              if (arm.pattern.enumName !== subjType.name && enumInfo.baseName !== arm.pattern.enumName) {
                this.error(`pattern enum '${arm.pattern.enumName}' does not match subject type '${subjType.name}'`);
              }
              const variant = enumInfo.variants.get(arm.pattern.variant);
              if (!variant) {
                this.error(`enum '${subjType.name}' has no variant '${arm.pattern.variant}'`);
                continue;
              }
              if (covered.has(arm.pattern.variant)) {
                this.error(`duplicate match arm for '${arm.pattern.variant}'`);
              }
              covered.add(arm.pattern.variant);
              if (arm.pattern.bindings.length !== variant.fields.length) {
                this.error(`variant '${arm.pattern.variant}' has ${variant.fields.length} fields, but pattern has ${arm.pattern.bindings.length} bindings`);
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
                this.error(`non-exhaustive match: missing variant '${name}'`);
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
      }
    }
  }

  private resolveAssignTarget(expr: Expr): { type: TypeKind; mutable: boolean } | null {
    if (expr.kind === "Ident") {
      const info = this.lookup(expr.name);
      if (!info) { this.error(`undefined variable '${expr.name}'`); return null; }
      // &mut T refs are assignable through, deref the type
      if (info.type.tag === "ref" && info.type.mutable) {
        return { type: info.type.inner, mutable: true };
      }
      return { type: this.deref(info.type), mutable: info.mutable };
    }
    if (expr.kind === "FieldAccess") {
      const objType = this.checkExpr(expr.object);
      if (objType.tag === "struct") {
        const info = this.structs.get(objType.name);
        if (!info) { this.error(`unknown struct '${objType.name}'`); return null; }
        const field = info.fields.find(f => f.name === expr.field);
        if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`); return null; }
        // mutable if root variable is mutable
        const rootMut = this.isRootMutable(expr.object);
        return { type: field.type, mutable: rootMut };
      }
      this.error(`cannot access field on non-struct type ${typeName(objType)}`);
      return null;
    }
    if (expr.kind === "IndexAccess") {
      const objType = this.checkExpr(expr.object);
      if (objType.tag === "array") {
        const rootMut = this.isRootMutable(expr.object);
        return { type: objType.element, mutable: rootMut };
      }
      this.error(`cannot index non-array type ${typeName(objType)}`);
      return null;
    }
    this.error("invalid assignment target");
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
    if (expr.kind === "EnumLit" && hint?.tag === "enum") {
      const hintEnum = this.enums.get(hint.name);
      if (hintEnum && (hintEnum.baseName === expr.enumName || hint.name === expr.enumName)) {
        const variant = hintEnum.variants.get(expr.variant);
        if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`); return { tag: "unknown" }; }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`);
        }
        for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`);
          }
        }
        (expr as any).enumName = hint.name;
        return hint;
      }
    }
    return this.checkExpr(expr);
  }

  private checkExpr(expr: Expr): TypeKind {
    switch (expr.kind) {
      case "IntLit":
        return { tag: "int", bits: 32, signed: true };
      case "FloatLit":
        return { tag: "float", bits: 64 };
      case "BoolLit":
        return { tag: "bool" };
      case "StringLit":
        return { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
      case "Ident": {
        const info = this.lookup(expr.name);
        if (!info) { this.error(`undefined variable '${expr.name}'`); return { tag: "unknown" }; }
        if (info.moved) {
          this.error(`use of moved variable '${expr.name}'`);
          return this.deref(info.type);
        }
        return this.deref(info.type);
      }
      case "BinOp": {
        const lt = this.checkExpr(expr.left);
        const rt = this.checkExpr(expr.right);
        const arithOps = ["+", "-", "*", "/", "%"];
        const cmpOps = ["==", "!=", "<", ">", "<=", ">="];
        if (arithOps.includes(expr.op)) {
          if (!isNumeric(lt) && lt.tag !== "unknown") this.error(`operator '${expr.op}' requires numeric type, got ${typeName(lt)}`);
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`);
          return lt;
        }
        if (cmpOps.includes(expr.op)) {
          if (!typeEq(lt, rt) && lt.tag !== "unknown" && rt.tag !== "unknown") this.error(`type mismatch in '${expr.op}': ${typeName(lt)} vs ${typeName(rt)}`);
          return { tag: "bool" };
        }
        this.error(`unknown operator '${expr.op}'`);
        return { tag: "unknown" };
      }
      case "UnaryOp": {
        const ot = this.checkExpr(expr.operand);
        if (expr.op === "-") {
          if (!isNumeric(ot) && ot.tag !== "unknown") this.error(`unary '-' requires numeric type, got ${typeName(ot)}`);
          return ot;
        }
        if (expr.op === "!") {
          if (ot.tag !== "bool" && ot.tag !== "unknown") this.error(`unary '!' requires bool, got ${typeName(ot)}`);
          return { tag: "bool" };
        }
        return { tag: "unknown" };
      }
      case "Call": {
        const sig = this.functions.get(expr.func);
        if (!sig) { this.error(`undefined function '${expr.func}'`); return { tag: "unknown" }; }
        if (sig.variadic) {
          if (expr.args.length < sig.params.length) this.error(`function '${expr.func}' expects at least ${sig.params.length} args, got ${expr.args.length}`);
        } else if (expr.args.length !== sig.params.length) {
          this.error(`function '${expr.func}' expects ${sig.params.length} args, got ${expr.args.length}`);
        }
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          const paramType = sig.params[i].type;
          // passing value to &T param: auto-borrow
          if (paramType.tag === "ref") {
            if (!typeEq(paramType.inner, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`);
            }
          } else if (!typeEq(paramType, argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.func}': expected ${typeName(paramType)}, got ${typeName(argType)}`);
          }
        }
        for (let i = sig.params.length; i < expr.args.length; i++) this.checkExpr(expr.args[i]);
        // move non-ref args
        for (let i = 0; i < Math.min(expr.args.length, sig.params.length); i++) {
          if (sig.params[i].type.tag !== "ref") this.tryMove(expr.args[i]);
        }
        return sig.ret;
      }
      case "StructLit": {
        const info = this.structs.get(expr.name);
        if (!info) { this.error(`unknown struct '${expr.name}'`); return { tag: "unknown" }; }
        for (const f of expr.fields) {
          const fieldDef = info.fields.find(d => d.name === f.name);
          if (!fieldDef) { this.error(`struct '${expr.name}' has no field '${f.name}'`); continue; }
          const valType = this.checkExpr(f.value);
          if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
            this.error(`field '${f.name}' of '${expr.name}': expected ${typeName(fieldDef.type)}, got ${typeName(valType)}`);
          }
        }
        // check all fields provided
        for (const d of info.fields) {
          if (!expr.fields.find(f => f.name === d.name)) {
            this.error(`missing field '${d.name}' in struct '${expr.name}'`);
          }
        }
        return { tag: "struct", name: expr.name };
      }
      case "FieldAccess": {
        const objType = this.checkExpr(expr.object);
        if (objType.tag === "struct") {
          const info = this.structs.get(objType.name);
          if (!info) { this.error(`unknown struct '${objType.name}'`); return { tag: "unknown" }; }
          const field = info.fields.find(f => f.name === expr.field);
          if (!field) { this.error(`struct '${objType.name}' has no field '${expr.field}'`); return { tag: "unknown" }; }
          return field.type;
        }
        if (objType.tag === "enum") {
          this.error(`cannot access field on enum '${objType.name}' — use match to extract values`);
          return { tag: "unknown" };
        }
        // array.len
        if (objType.tag === "array" && expr.field === "len") {
          return { tag: "int", bits: 32, signed: true };
        }
        this.error(`cannot access field '${expr.field}' on type ${typeName(objType)}`);
        return { tag: "unknown" };
      }
      case "ArrayLit": {
        if (expr.elements.length === 0) {
          this.error("cannot infer type of empty array literal");
          return { tag: "unknown" };
        }
        const elemType = this.checkExpr(expr.elements[0]);
        for (let i = 1; i < expr.elements.length; i++) {
          const t = this.checkExpr(expr.elements[i]);
          if (!typeEq(elemType, t) && t.tag !== "unknown") {
            this.error(`array element ${i}: expected ${typeName(elemType)}, got ${typeName(t)}`);
          }
        }
        return { tag: "array", element: elemType, size: expr.elements.length };
      }
      case "IndexAccess": {
        const objType = this.checkExpr(expr.object);
        const idxType = this.checkExpr(expr.index);
        if (idxType.tag !== "int" && idxType.tag !== "unknown") {
          this.error(`array index must be integer, got ${typeName(idxType)}`);
        }
        if (objType.tag === "array") return objType.element;
        this.error(`cannot index type ${typeName(objType)}`);
        return { tag: "unknown" };
      }
      case "EnumLit": {
        // generic enum — infer type params from args
        const genericInfo = this.genericEnums.get(expr.enumName);
        if (genericInfo) {
          const variant = genericInfo.variants.get(expr.variant);
          if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`); return { tag: "unknown" }; }
          if (expr.args.length !== variant.fields.length) {
            this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`);
          }
          const typeMap = new Map<string, TypeKind>();
          for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
            const argType = this.checkExpr(expr.args[i]);
            const field = variant.fields[i];
            if (field.tag === "struct" && genericInfo.typeParams.includes(field.name)) {
              const existing = typeMap.get(field.name);
              if (existing && !typeEq(existing, argType)) {
                this.error(`conflicting inference for type parameter '${field.name}'`);
              } else {
                typeMap.set(field.name, argType);
              }
            } else if (!typeEq(field, argType) && argType.tag !== "unknown") {
              this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(field)}, got ${typeName(argType)}`);
            }
          }
          const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
          if (missing.length > 0) {
            this.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.enumName}::${expr.variant}`);
            return { tag: "unknown" };
          }
          const typeArgs = genericInfo.typeParams.map(p => typeMap.get(p)!);
          const mangled = this.monomorphizeEnum(expr.enumName, typeArgs);
          expr.enumName = mangled;
          return { tag: "enum", name: mangled };
        }
        // concrete enum
        const info = this.enums.get(expr.enumName);
        if (!info) { this.error(`unknown enum '${expr.enumName}'`); return { tag: "unknown" }; }
        const variant = info.variants.get(expr.variant);
        if (!variant) { this.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`); return { tag: "unknown" }; }
        if (expr.args.length !== variant.fields.length) {
          this.error(`variant '${expr.enumName}::${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`);
        }
        for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
          const argType = this.checkExpr(expr.args[i]);
          if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
            this.error(`argument ${i + 1} of '${expr.enumName}::${expr.variant}': expected ${typeName(variant.fields[i])}, got ${typeName(argType)}`);
          }
        }
        return { tag: "enum", name: expr.enumName };
      }
    }
  }
}
