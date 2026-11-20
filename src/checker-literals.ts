// Struct and enum literal expressions: field checking, defaults, base expressions, prelude variants.
import { TypeChecker } from "./checker";
import type { Expr, Span, Call, DefaultValue, EnumLit, StructLit } from "./ast";
import type { TypeKind } from "./types";
import { must } from "./must";
import { typeEq } from "./types";
import { displayPath } from "./checker-util";
import { memberHint } from "./suggest";
import { declaredType } from "./ast";

// The node to check from here on: `expr`, or its EnumLit replacement (recorded in `rewrites`).
export function canonicalizePreludeVariant(c: TypeChecker, expr: Expr): Expr {
  const next = c.preludeVariantNode(expr);
  if (next) { c.rewrites.set(expr, next); return next; }
  return expr;
}

// The EnumLit `expr` canonicalizes to, or null. Separate from the replacement so that `expr` is
// never narrowed where it is replaced.
export function preludeVariantNode(c: TypeChecker, expr: Expr): Expr | null {
  let variant = "";
  let args: Expr[] = [];
  let typeArgs: Call["typeArgs"] = undefined;
  let aliasable = false;
  if (expr.kind === "Call") { aliasable = !expr.sigil; variant = expr.func; args = expr.args; typeArgs = expr.typeArgs; }
  if (expr.kind === "Ident") { aliasable = true; variant = expr.name; }
  const enumName = TypeChecker.PRELUDE_VARIANTS.get(variant);
  if (aliasable && enumName !== undefined && !c.nameIsDefined(variant)) {
    return { kind: "EnumLit", enumName, variant, args, typeArgs, span: expr.span };
  }
  return null;
}

// Copy each omitted field's default into the literal. A name the default reads must
// still mean the global here, so a local shadowing it is an error, not a silent rebind.
// Returns the literal to go on with: `expr` itself when nothing was added, else its replacement (recorded
// in `rewrites`), which the caller re-checks from the top.
export function fillFieldDefaults(c: TypeChecker, expr: StructLit, declName: string): StructLit {
  if (expr.base || c.defaultsFilled.has(expr)) return expr;
  c.defaultsFilled.add(expr);
  const defs = c.structDefaults.get(declName);
  if (!defs) return expr;
  const added: StructLit["fields"] = [];
  for (const [name, def] of defs) {
    if (expr.fields.some(f => f.name === name)) continue;
    const value = structuredClone(def);
    const shadowed = c.shadowedDefaultName(value);
    if (shadowed) {
      c.error(`the default for field '${name}' reads the global '${shadowed}', but a local '${shadowed}' shadows it here`, expr.span,
        `rename the local, or write '${name}: ...' in this literal`);
    }
    added.push({ name, value, fromDefault: true });
  }
  if (added.length === 0) return expr;
  const filled: StructLit = { ...expr, fields: [...expr.fields, ...added] };
  c.defaultsFilled.add(filled);
  c.rewrites.set(expr, filled);
  return filled;
}

export function shadowedDefaultName(c: TypeChecker, e: Expr): string | null {
  if (e.kind === "Ident") {
    for (let i = c.scopes.length - 1; i >= 0; i--) {
      const sc = c.scopes[i];
      if (sc === c.globalScope) return null;
      if (sc.has(e.name)) return e.name;
    }
    return null;
  }
  const kids: Expr[] = e.kind === "ArrayLit" ? e.elements : e.kind === "EnumLit" || e.kind === "Call" ? e.args
    : e.kind === "StructLit" ? e.fields.map(f => f.value) : e.kind === "CastExpr" || e.kind === "UnaryOp" ? [e.operand] : [];
  for (const k of kids) { const n = c.shadowedDefaultName(k); if (n) return n; }
  return null;
}

export function checkStructLitAsInstance(c: TypeChecker, expr: StructLit, hint: Extract<TypeKind, { tag: "struct" }>, baseType?: TypeKind): TypeKind {
  const sp = expr.span;
  const hintInfo = must(c.structs, hint.name, "struct instance");
  const shown = expr.name || c.show(hint);
  const filled = c.fillFieldDefaults(expr, hintInfo.baseName ?? hint.name);
  if (filled !== expr) return c.checkStructLitAsInstance(filled, hint, baseType);
  const namesOk = c.checkStructLitFieldNames(expr, hint.name, hintInfo.fields.map(d => d.name));
  for (const f of expr.fields) {
    const fieldDef = hintInfo.fields.find(d => d.name === f.name);
    if (!fieldDef) continue;
    let valType = c.checkExpr(f.value, fieldDef.type);
    if (fieldDef.type.tag === "int" && valType.tag === "int" && !typeEq(fieldDef.type, valType) && c.isConstIntExpr(f.value)) {
      c.retypeConstInt(f.value, fieldDef.type);
      valType = fieldDef.type;
    }
    if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown" && !c.tryInterfaceCoercion(f.value, valType, fieldDef.type)) {
      c.error(`field '${f.name}' of '${shown}': expected ${c.show(fieldDef.type)}, got ${c.show(valType)}`, sp);
    }
    if (fieldDef.type.tag === "int") c.enforceRangeInto(f.value, valType, fieldDef.type, f.value.span);
    c.tryMove(f.value);
  }
  c.checkStructLitBase(expr, hint, baseType);
  for (const d of hintInfo.fields) {
    if (namesOk && !expr.base && !expr.fields.find(f => f.name === d.name) && !c.badDefaults.has(`${hintInfo.baseName ?? hint.name}.${d.name}`)) {
      c.error(`missing field '${d.name}' in struct '${shown}'`, sp);
    }
  }
  c.rewrittenStructLits.set(expr, hint.name);
  return c.setType(expr, hint);
}

// Struct update `S { a: 1, ..base }`. Called after the listed fields are checked, which
// is also the order they run in. The base is consumed whole, through tryMove, so a
// borrowed base gets the ordinary move-out-of-borrow error and its `.clone()` hint, and
// an owned local is moved (a later use is use-after-move). `baseType` is passed when the
// base was already checked to find the literal's type (the inferred forms).
export function checkStructLitBase(c: TypeChecker, expr: StructLit, result: Extract<TypeKind, { tag: "struct" }>, baseType?: TypeKind): void {
  const base = expr.base;
  if (!base) return;
  const bt = baseType ?? c.checkExpr(base, result);
  if (bt.tag === "unknown" || c.isPoisoned(bt)) return;
  // A `&S` base is the right type behind a borrow: tryMove names that problem better
  // than a type mismatch would.
  const owned = bt.tag === "ref" ? bt.inner : bt;
  if (!typeEq(owned, result)) {
    c.error(`struct update base has type ${c.show(bt)}, but the literal builds ${c.show(result)}`, base.span ?? expr.span,
      `'..base' fills the unlisted fields, so it must be a ${c.show(result)} itself`);
    return;
  }
  // Rust's E0509: the unlisted fields are moved out of the base, and a Drop impl runs
  // against the whole value, so its destructor would then see emptied fields.
  if (c.dropImpls.has(result.name)) {
    c.error(`cannot use '..' struct update with '${c.show(result)}', which implements Drop`, base.span ?? expr.span,
      `the unlisted fields would be moved out of the base, leaving its destructor reading empty fields: list every field instead`);
    return;
  }
  c.tryMove(base);
}

export function checkStructLitExpr(c: TypeChecker, expr: StructLit): TypeKind {
  const sp = expr.span;
  // `{ a: 1, ..base }`: the base names the struct, so this is that struct's literal,
  // not a fresh anonymous one.
  if (expr.name === "" && expr.base) {
    const bt = c.checkExpr(expr.base);
    const owned = bt.tag === "ref" ? bt.inner : bt;
    if (owned.tag === "struct" && c.structs.has(owned.name)) return c.checkStructLitAsInstance(expr, owned, bt);
    if (bt.tag !== "unknown" && !c.isPoisoned(bt)) {
      c.error(`struct update base must be a struct, got ${c.show(bt)}`, expr.base.span ?? sp);
    }
    for (const f of expr.fields) c.checkExpr(f.value);
    return c.setType(expr, { tag: "unknown" });
  }
  // anonymous struct literal: { field: value, ... }
  if (expr.name === "") {
    if (expr.fields.length === 0) { c.error(`anonymous struct literal must have at least one field`, sp); return c.setType(expr, { tag: "unknown" }); }
    const fields: { name: string; type: TypeKind }[] = [];
    for (const f of expr.fields) {
      const valType = c.checkExpr(f.value);
      fields.push({ name: f.name, type: valType });
      c.tryMove(f.value);
    }
    const anonName = `__Anon${c.anonStructCounter++}`;
    c.structs.set(anonName, { fields });
    c.anonStructs.push({ name: anonName, fields });
    c.rewrittenStructLits.set(expr, anonName);
    return c.setType(expr, { tag: "struct", name: anonName });
  }
  const genericInfo = c.genericStructs.get(expr.name);
  // `Pair<i64, string> { … }`: the instance is spelled, so the fields are checked
  // against it rather than inferring it from them (backlog #40).
  if (expr.typeArgs && expr.typeArgs.length > 0) {
    if (!genericInfo) {
      c.error(`'${expr.name}' is not generic, so '${expr.name}<...> { … }' has no type arguments to take`, sp,
        `write '${expr.name} { … }'`);
      return c.setType(expr, { tag: "unknown" });
    }
    if (expr.typeArgs.length !== genericInfo.typeParams.length) {
      c.error(`'${expr.name}' takes ${genericInfo.typeParams.length} type argument(s), got ${expr.typeArgs.length}`, sp,
        `'${expr.name}<${genericInfo.typeParams.join(", ")}>'`);
      return c.setType(expr, { tag: "unknown" });
    }
    const mangled = c.monomorphizeStruct(expr.name, expr.typeArgs.map(t => c.resolve(t)), sp);
    return c.checkStructLitAsInstance(expr, { tag: "struct", name: mangled });
  }
  // `Pair { a: 1, ..p }`: the base fixes the instance, including the type parameters
  // no listed field mentions.
  if (genericInfo && expr.base) {
    const bt = c.checkExpr(expr.base);
    const owned = bt.tag === "ref" ? bt.inner : bt;
    if (owned.tag === "struct" && c.structs.get(owned.name)?.baseName === expr.name) {
      return c.checkStructLitAsInstance(expr, owned, bt);
    }
    if (bt.tag !== "unknown" && !c.isPoisoned(bt)) {
      c.error(`struct update base has type ${c.show(bt)}, but the literal builds a '${expr.name}'`, expr.base.span ?? sp,
        `'..base' fills the unlisted fields, so it must be a '${expr.name}' itself`);
    }
    for (const f of expr.fields) c.checkExpr(f.value);
    return c.setType(expr, { tag: "unknown" });
  }
  if (genericInfo) {
    const typeMap = new Map<string, TypeKind>();
    const filled = c.fillFieldDefaults(expr, expr.name);
    if (filled !== expr) return c.checkStructLitExpr(filled);
    const namesOk = c.checkStructLitFieldNames(expr, expr.name, genericInfo.decl.fields.map(d => d.name));
    for (const f of expr.fields) {
      const declField = genericInfo.decl.fields.find(d => d.name === f.name);
      // A default fixes no type parameter: it is checked against the instance below.
      if (!declField || f.fromDefault) continue;
      const valType = c.checkExpr(f.value);
      // Infer type params from the field's declared (unsubstituted) type against the
      // argument's concrete type — recursively, so `Vec<T>`/`[T]`/nested generics
      // resolve, not just a bare `T` field.
      c.inferTypeParamsFromHint(declField.type, valType, genericInfo.typeParams, typeMap);
    }
    const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
    if (missing.length > 0) {
      const spelled = `${expr.name}<${genericInfo.typeParams.join(", ")}>`;
      c.error(`cannot infer type parameter(s) '${missing.join("', '")}' for struct '${expr.name}'`, sp,
        `no field fixes ${missing.length === 1 ? "it" : "them"}: spell the type arguments, '${spelled} { … }', or annotate the binding, 'let x: ${spelled} = ${expr.name} { … }'`);
      return c.setType(expr, { tag: "unknown" });
    }
    const typeArgs = genericInfo.typeParams.map(p => must(typeMap, p, "type map"));
    const mangled = c.monomorphizeStruct(expr.name, typeArgs);
    c.rewrittenStructLits.set(expr, mangled);
    const info = must(c.structs, mangled, "structs");
    for (const f of expr.fields) {
      const fieldDef = info.fields.find(d => d.name === f.name);
      if (!fieldDef) continue;
      const valType = f.fromDefault ? c.checkExpr(f.value, fieldDef.type) : must(c.exprTypes, f.value, "expr types");
      if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown") {
        c.error(`field '${f.name}' of '${expr.name}': expected ${c.show(fieldDef.type)}, got ${c.show(valType)}`, sp);
      }
      if (fieldDef.type.tag === "int") c.enforceRangeInto(f.value, valType, fieldDef.type, f.value.span);
      // Record the move of the field value out of its source. Without this a non-Copy
      // value (Vec/String/…) moved into a *generic* struct field was never marked moved,
      // so its source kept its alive-flag and was dropped again at scope exit — a
      // double-free. The non-generic and anonymous branches already do this.
      c.tryMove(f.value);
    }
    for (const d of info.fields) {
      if (namesOk && !expr.fields.find(f => f.name === d.name) && !c.badDefaults.has(`${expr.name}.${d.name}`)) {
        c.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
      }
    }
    return c.setType(expr, { tag: "struct", name: mangled });
  }
  const info = c.structs.get(expr.name);
  if (!info) { c.error(`unknown struct '${expr.name}'`, sp); return c.setType(expr, { tag: "unknown" }); }
  const filled = c.fillFieldDefaults(expr, info.baseName ?? expr.name);
  if (filled !== expr) return c.checkStructLitExpr(filled);
  const namesOk = c.checkStructLitFieldNames(expr, expr.name, info.fields.map(d => d.name));
  for (const f of expr.fields) {
    const fieldDef = info.fields.find(d => d.name === f.name);
    if (!fieldDef) continue;
    // A poisoned field gives no type to infer `[]` from; that is the field's error again.
    if (c.isPoisoned(fieldDef.type) && f.value.kind === "ArrayLit" && f.value.elements.length === 0) {
      c.setType(f.value, { tag: "unknown" });
      continue;
    }
    let valType = c.checkExpr(f.value, fieldDef.type);
    if (fieldDef.type.tag === "int" && valType.tag === "int" && !typeEq(fieldDef.type, valType) && c.isConstIntExpr(f.value)) {
      c.retypeConstInt(f.value, fieldDef.type);
      valType = fieldDef.type;
    }
    const cfnField = fieldDef.type.tag === "cfn" ? fieldDef.type : null;
    if (cfnField) {
      if (valType.tag !== "unknown" && !c.checkCFnStore(f.value, cfnField, valType, `field '${f.name}' of '${expr.name}'`, sp)) {
        c.error(`field '${f.name}' of '${expr.name}': expected ${c.show(fieldDef.type)}, got ${c.show(valType)}`, sp);
      }
    } else if (!typeEq(fieldDef.type, valType) && valType.tag !== "unknown" && !c.tryInterfaceCoercion(f.value, valType, fieldDef.type)) {
      c.error(`field '${f.name}' of '${expr.name}': expected ${c.show(fieldDef.type)}, got ${c.show(valType)}`, sp);
    }
    if (fieldDef.type.tag === "int") c.enforceRangeInto(f.value, valType, fieldDef.type, f.value.span);
    c.tryMove(f.value);
  }
  c.checkStructLitBase(expr, { tag: "struct", name: expr.name });
  for (const d of info.fields) {
    if (namesOk && !expr.base && !expr.fields.find(f => f.name === d.name) && !c.badDefaults.has(`${info.baseName ?? expr.name}.${d.name}`)) {
      c.error(`missing field '${d.name}' in struct '${expr.name}'`, sp);
    }
  }
  return c.setType(expr, { tag: "struct", name: expr.name });
}

// Per-field privacy: a field named with a leading `_` is reachable only from the file
// that declares its struct. The referencing file is the enclosing fn's origin (so a
// derived method counts as the struct's file) and falls back to the expression's own
// span outside any fn (a global initializer). Fn and method names are not covered:
// `_sendFrame` is an ordinary name. Called from every read, write and literal site.
export function checkFieldPrivacy(c: TypeChecker, structName: string, field: string, refSpan?: Span): boolean {
  const declFile = c.privateFieldOwner(structName, field, refSpan);
  if (!declFile) return true;
  const shown = c.structs.get(structName)?.baseName ?? structName;
  c.diagnostics.push({
    severity: "error",
    span: refSpan,
    message: `field '${field}' of '${shown}' is private to '${displayPath(declFile)}'`,
    hint: `a field named with a leading '_' is visible only in the file that declares the struct; add an accessor or constructor there`,
    code: "private-field",
  });
  return false;
}

// The declaring file when `field` is private to a file other than the referencing one.
export function privateFieldOwner(c: TypeChecker, structName: string, field: string, refSpan?: Span): string | null {
  if (!field.startsWith("_")) return null;
  // A generic literal names the base struct before it is instantiated.
  const declFile = c.structs.get(structName)?.file ?? c.genericStructs.get(structName)?.decl.span?.file;
  const refFile = c.currentFnFile ?? refSpan?.file;
  // Compared as absolute paths: the entry file is parsed under the path the CLI was
  // given, and the same file reached again through an import is parsed under its
  // absolute one (a std module checked directly is the everyday case).
  if (!declFile || !refFile || c.absFile(declFile) === c.absFile(refFile)) return null;
  return declFile;
}

// Field-name diagnostics for one struct literal; false when any name was wrong. Once a
// name is wrong the "missing field" list is that mistake's echo (spelling `pid` also
// leaves `_pid` missing), so callers drop it. A literal of a struct with a `_` field,
// written outside the struct's file, cannot compile however it is spelled: it is one
// mistake, so only its first name error is reported.
export function checkStructLitFieldNames(c: TypeChecker, expr: StructLit, privacyName: string, declared: string[]): boolean {
  const unbuildableHere = declared.some(n => c.privateFieldOwner(privacyName, n, expr.span) !== null);
  let ok = true;
  for (const f of expr.fields) {
    if (!ok && unbuildableHere) break;
    if (!declared.includes(f.name)) {
      c.error(`struct '${expr.name}' has no field '${f.name}'`, expr.span, memberHint(f.name, declared));
      ok = false;
    } else if (!c.checkFieldPrivacy(privacyName, f.name, expr.span)) {
      ok = false;
    }
  }
  return ok;
}

export function checkEnumLitExpr(c: TypeChecker, expr: EnumLit, expected: TypeKind | null): TypeKind {
  const sp = expr.span;
  // Promise.all(args) / Promise.race(args) → promiseAll(args) / promiseRace(args)
  if (expr.enumName === "Promise" && (expr.variant === "all" || expr.variant === "race")) {
    const fnName = expr.variant === "all" ? "promiseAll" : "promiseRace";
    const genericFn = c.genericFns.get(fnName);
    if (genericFn && expr.args.length === 1) {
      const argType = c.checkExpr(expr.args[0]);
      const typeMap = new Map<string, TypeKind>();
      for (let i = 0; i < Math.min(1, genericFn.decl.params.length); i++) {
        const paramTy = declaredType(genericFn.decl.params[i]);
        if (paramTy.typeArgs) {
          let argResolved = argType;
          if (argResolved.tag === "ref") argResolved = argResolved.inner;
          if (argResolved.tag === "vec" && argResolved.element.tag === "struct") {
            const info = c.structs.get(argResolved.element.name);
            if (info?.typeArgs && info.typeArgs.length > 0) {
              typeMap.set(genericFn.typeParams[0], info.typeArgs[0]);
            }
          }
        }
      }
      if (typeMap.size > 0) {
        const typeArgs = genericFn.typeParams.map(p => must(typeMap, p, "type map"));
        const mangled = c.monomorphizeFn(fnName, typeArgs);
        c.rewrittenCalls.set(expr as any, mangled);
        const concreteSig = must(c.functions, mangled, "functions");
        if (concreteSig.params[0]?.type.tag === "ref") {
          c.autoBorrow(expr.args[0], { mutable: false });
        } else {
          c.tryMove(expr.args[0]);
        }
        return c.setType(expr, concreteSig.ret);
      }
    }
  }
  // `Kind.tryFrom(n)` on a repr'd enum → Option<Kind>. The partial reverse of `k as i32`;
  // most integers are not a variant, so the honest signature is Option, not a trap.
  {
    const reprInfo = c.enums.get(expr.enumName);
    if (expr.variant === "tryFrom" && reprInfo?.reprType) {
      if (expr.args.length !== 1) { c.error(`'${expr.enumName}.tryFrom' expects 1 argument, got ${expr.args.length}`, sp); return c.setType(expr, { tag: "unknown" }); }
      const argType = c.checkExpr(expr.args[0]);
      if (argType.tag !== "int" && argType.tag !== "unknown") c.error(`'${expr.enumName}.tryFrom': expected an integer, got ${c.show(argType)}`, sp);
      return c.setType(expr, c.resolveOptionForValue({ tag: "enum", name: expr.enumName }, sp));
    }
  }
  if (expr.enumName === "String" && expr.variant === "withCapacity") {
    if (expr.args.length !== 1) { c.error(`'String.withCapacity' expects 1 argument, got ${expr.args.length}`, sp); return c.setType(expr, { tag: "unknown" }); }
    const argType = c.checkExpr(expr.args[0]);
    if (argType.tag !== "int" && argType.tag !== "unknown") c.error(`'String.withCapacity': expected integer, got ${c.show(argType)}`, sp);
    // std/string's strWithCapacity (the resolver module-scopes a private std name);
    // lowering puts the negative check on the argument.
    const ctor = ["string$strWithCapacity", "strWithCapacity"].find(n => c.functions.has(n));
    if (ctor) c.staticCalls.set(expr, ctor);
    else c.error(`'String.withCapacity' needs std/string, which the prelude imports`, sp);
    return c.setType(expr, { tag: "string" });
  }
  if (expr.enumName === "Vec" && expr.variant === "new") {
    if (expr.args.length !== 0) c.error(`'Vec.new' takes no arguments`, sp);
    c.error(`cannot infer Vec element type — add a type annotation: 'let v: Vec<T> = Vec.new()'`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  if (expr.enumName === "Vec" && (expr.variant === "withCapacity" || expr.variant === "filled")) {
    c.error(`cannot infer Vec element type — add a type annotation: 'let v: Vec<T> = Vec.${expr.variant}(...)'`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  if (expr.enumName === "HashMap" && (expr.variant === "new" || expr.variant === "withCapacity")) {
    if (expr.variant === "new" && expr.args.length !== 0) c.error(`'HashMap.new' takes no arguments`, sp);
    c.error(`cannot infer HashMap types — add a type annotation: 'let m: HashMap<K, V> = HashMap.${expr.variant}(${expr.variant === "new" ? "" : "n"})'`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  const genericInfo = c.genericEnums.get(expr.enumName);
  if (genericInfo) {
    const variant = genericInfo.variants.get(expr.variant);
    if (!variant) { c.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return c.setType(expr, { tag: "unknown" }); }
    if (expr.args.length !== variant.fields.length) {
      c.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
    }
    const typeMap = new Map<string, TypeKind>();
    for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
      const field = variant.fields[i];
      let argType = c.checkExpr(expr.args[i]);
      if (field.tag === "int" && argType.tag === "int" && !typeEq(field, argType) && c.isConstIntExpr(expr.args[i])) {
        c.retypeConstInt(expr.args[i], field);
        argType = field;
      }
      if (field.tag === "struct" && genericInfo.typeParams.includes(field.name)) {
        const existing = typeMap.get(field.name);
        if (existing && !typeEq(existing, argType)) {
          c.error(`conflicting inference for type parameter '${field.name}'`, sp);
        } else {
          typeMap.set(field.name, argType);
        }
      } else if (!typeEq(field, argType) && argType.tag !== "unknown") {
        c.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${c.show(field)}, got ${c.show(argType)}`, expr.args[i].span);
      }
      c.tryMove(expr.args[i]);
    }
    // fill uninferred type params from defaults
    if (genericInfo.typeParamDefaults) {
      for (let i = 0; i < genericInfo.typeParams.length; i++) {
        const p = genericInfo.typeParams[i];
        if (!typeMap.has(p) && genericInfo.typeParamDefaults[i]) {
          typeMap.set(p, genericInfo.typeParamDefaults[i]!);
        }
      }
    }
    const missing = genericInfo.typeParams.filter(p => !typeMap.has(p));
    if (missing.length > 0) {
      c.error(`cannot infer type parameter(s) '${missing.join("', '")}' for ${expr.enumName}.${expr.variant}`, sp);
      return c.setType(expr, { tag: "unknown" });
    }
    const typeArgs = genericInfo.typeParams.map(p => must(typeMap, p, "type map"));
    const mangled = c.monomorphizeEnum(expr.enumName, typeArgs, sp);
    c.rewrittenEnums.set(expr, mangled);
    return c.setType(expr, { tag: "enum", name: mangled });
  }
  // Infer the type arguments a bare `Pair.new(...)` did not spell, so the call below
  // sees the same shape the turbofish produces.
  let spelled = expr.typeArgs;
  if ((!spelled || spelled.length === 0) && c.genericStructs.has(expr.enumName)
      && !c.enums.has(expr.enumName) && !c.structs.has(expr.enumName)) {
    const inferred = c.inferGenericStaticTypeArgs(expr, expected);
    if (inferred === "argError") return c.setType(expr, { tag: "unknown" });
    if (inferred) spelled = inferred;
  }
  // generic struct static call: Struct<T>.method(args) with explicit type args
  if (spelled && spelled.length > 0 && c.genericStructs.has(expr.enumName)) {
    const typeArgs = spelled.map(ta => c.resolve(ta));
    const mangled = c.monomorphizeStruct(expr.enumName, typeArgs);
    // process pending impl methods that monomorphization may have generated
    c.flushStructBounds();
    while (c._pendingImplFns.length > 0) {
      const fn = c._pendingImplFns.shift()!;
      if (c.fromBoundFailedStruct(fn)) continue;
      c.checkFunction(fn);
    }
    const inherent = c.inherentImpls.get(mangled);
    if (inherent) {
      const sig = inherent.methods.get(expr.variant);
      if (sig) {
        const mangledMethod = `${mangled}$${expr.variant}`;
        c.checkStaticCallArgs(sig, expr, sp);
        c.staticCalls.set(expr, mangledMethod);
        c.requireUnsafeMethod(mangledMethod, `${expr.enumName}.${expr.variant}`, sp);
        // Send enforcement for thread-crossing closures lives in checkThreadBoundary,
        // driven by `@thread` on the declaration — see the comment there for what the
        // hardcoded version that used to sit here missed.
        return c.setType(expr, sig.ret);
      }
    }
    const asMethod2 = c.staticCallOnVariable(expr, expected);
    if (asMethod2) return asMethod2;
    const withheld = c.withheldMethods.get(`${mangled}.${expr.variant}`);
    if (withheld) {
      c.error(`'${expr.variant}' is not available on '${expr.enumName}<${typeArgs.map(a => c.show(a)).join(", ")}>': ${withheld.reason}`, sp, withheld.hint);
      return c.setType(expr, { tag: "unknown" });
    }
    c.error(`'${expr.enumName}<...>' has no static method '${expr.variant}'`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  const info = c.enums.get(expr.enumName);
  if (!info) {
    // static method call: Struct.method(args)
    const inherent = c.inherentImpls.get(expr.enumName);
    if (inherent) {
      const sig = inherent.methods.get(expr.variant);
      if (sig) {
        const mangled = `${expr.enumName}$${expr.variant}`;
        // static methods have no self param — check args directly
        const paramOffset = c.checkStaticCallArgs(sig, expr, sp);
        c.staticCalls.set(expr, mangled);
        const sqlAttrs = paramOffset === 0 ? c.sql.methodAttrs.get(mangled) : undefined;
        if (sqlAttrs) c.noteSqlCall(`${expr.enumName}.${expr.variant}`, sqlAttrs, sig.params, expr.args, expr.enumName, sig.ret, sp);
        c.requireUnsafeMethod(mangled, `${expr.enumName}.${expr.variant}`, sp);
        // Precondition checking on a static method call (Math.sqrt(-1.0) etc).
        // Only when there is no `self` param, so args align 1:1 with the sig's
        // params the way checkCallSiteContracts expects.
        if (paramOffset === 0 && sig.contracts && sig.contracts.length > 0) {
          c.checkCallSiteContracts({ params: sig.params, contracts: sig.contracts } as any, expr.args, sp);
        }
        // Send enforcement: Thread.spawn() requires all closure captures to be Send
        if (expr.enumName === "Thread" && expr.variant === "spawn" && expr.args.length === 1 && expr.args[0].kind === "Closure") {
          const captures = c.closureCaptures.get(expr.args[0]);
          if (captures) {
            for (const cap of captures) {
              if (!c.isSend(cap.type)) {
                c.error(
                  `cannot send '${cap.name}' of type '${c.show(cap.type)}' across threads — type does not implement Send`,
                  expr.args[0].span,
                  c.whyNotSend(cap.type),
                );
              }
            }
          }
        }
        return c.setType(expr, sig.ret);
      }
    }
    const genericKey = `${expr.enumName}$${expr.variant}`;
    const genericTpl = c.genericMethods.get(genericKey);
    if (genericTpl && genericTpl.decl.params[0]?.name !== "self") {
      return c.checkGenericStaticMethodCall(expr, genericKey, sp, expected);
    }
    const asMethod = c.staticCallOnVariable(expr, expected);
    if (asMethod) return asMethod;
    c.errorUnknownStatic(expr.enumName, expr.variant, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  const variant = info.variants.get(expr.variant);
  if (!variant) { c.error(`enum '${expr.enumName}' has no variant '${expr.variant}'`, sp); return c.setType(expr, { tag: "unknown" }); }
  if (expr.args.length !== variant.fields.length) {
    c.error(`variant '${expr.enumName}.${expr.variant}' expects ${variant.fields.length} args, got ${expr.args.length}`, sp);
  }
  for (let i = 0; i < Math.min(expr.args.length, variant.fields.length); i++) {
    let argType = c.checkExpr(expr.args[i], variant.fields[i]);
    if (variant.fields[i].tag === "int" && argType.tag === "int" && !typeEq(variant.fields[i], argType) && c.isConstIntExpr(expr.args[i])) {
      c.retypeConstInt(expr.args[i], variant.fields[i]);
      argType = variant.fields[i];
    }
    if (!typeEq(variant.fields[i], argType) && argType.tag !== "unknown") {
      c.error(`argument ${i + 1} of '${expr.enumName}.${expr.variant}': expected ${c.show(variant.fields[i])}, got ${c.show(argType)}`, expr.args[i].span);
    }
    if (variant.fields[i].tag === "int") c.enforceRangeInto(expr.args[i], argType, variant.fields[i], expr.args[i].span);
    c.tryMove(expr.args[i]);
  }
  return c.setType(expr, { tag: "enum", name: expr.enumName });
}

export function checkDefaultValueExpr(c: TypeChecker, expr: DefaultValue): TypeKind {
  const sp = expr.span;
  const operandType = c.checkExpr(expr.operand);
  const inner = c.unwrapableInner(operandType);
  if (!inner) {
    c.error(`'??' requires Option or Result type, got ${c.show(operandType)}`, sp);
    return c.setType(expr, { tag: "unknown" });
  }
  const defaultType = c.checkExpr(expr.default, inner);
  if (inner.tag === "int") c.enforceRangeInto(expr.default, defaultType, inner, expr.default.span);
  if (!typeEq(inner, defaultType) && defaultType.tag !== "unknown") {
    c.error(`'??' default type mismatch: expected ${c.show(inner)}, got ${c.show(defaultType)}`, sp);
  }
  // `??` consumes BOTH operands wherever it is evaluated: codegen moves the payload
  // out of the Option and moves the default in, whichever branch runs. `moveTargets`
  // has always known that (`case "DefaultValue": return [operand, default]`), but it
  // is only reached when the RESULT lands in a move position — so `let s = o ?? d`
  // was checked and `(o ?? d).len` was not. The moves still happened: after it, `d`
  // read back as "" and `o` still reported `Some` with an emptied payload, both with
  // no diagnostic, which is the silent-empty-string failure the move checker exists
  // to prevent. Record them here, where the operator is checked, so the use position
  // of the result cannot change whether ownership is tracked. tryMoveLeaf gates on
  // isCopy itself, so `Option<i64> ?? 0` still moves nothing.
  c.tryMove(expr.operand);
  c.tryMove(expr.default);
  return c.setType(expr, inner);
}
