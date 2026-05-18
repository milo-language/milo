import type { Program, Function, Expr, MiloType, StructDecl, Span, ImplDecl, EnumDecl } from "./ast";
import { simpleType } from "./ast";
import { type TypeKind, typeName } from "./types";
import { TypeChecker } from "./checker";
import type { FnSig } from "./checker-types";

TypeChecker.prototype.processDerives = function(this: TypeChecker, program: Program): ImplDecl[] {
  const result: ImplDecl[] = [];
  const explicitEq = new Set<string>();
  for (const s of program.structs) {
    if (!s.attributes || s.typeParams.length > 0) continue;
    for (const attr of s.attributes) {
      if (attr.name !== "derive") continue;
      for (const traitName of attr.args) {
        if (traitName === "Eq") explicitEq.add(s.name);
        const impl = this.synthesizeDeriveImpl(s, traitName);
        if (impl) result.push(impl);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      if (explicitEq.has(s.name)) continue;
      if (this.traits.has(`Eq_${s.name}`)) continue;
      if (program.impls.some(i => i.traitName === "Eq" && i.typeName === s.name)) continue;
      let allEq = true;
      for (const f of s.fields) {
        const ft = this.resolve(f.type);
        if (!this.canAutoEq(ft)) { allEq = false; break; }
      }
      if (allEq) {
        const impl = this.deriveEq(s, true);
        if (impl) { result.push(impl); changed = true; }
      }
    }
  }
  return result;
};

TypeChecker.prototype.canAutoEq = function(this: TypeChecker, t: TypeKind): boolean {
  if (t.tag === "int" || t.tag === "float" || t.tag === "bool" || t.tag === "string") return true;
  if (t.tag === "enum") return true;
  if (t.tag === "struct") {
    return this.traits.has(`Eq_${t.name}`);
  }
  return false;
};

TypeChecker.prototype.synthesizeDeriveImpl = function(this: TypeChecker, s: StructDecl, traitName: string): ImplDecl | null {
  if (traitName === "Eq") return this.deriveEq(s);
  this.error(`cannot derive '${traitName}' — only Eq is supported`);
  return null;
};

TypeChecker.prototype.deriveEq = function(this: TypeChecker, s: StructDecl, skipValidation = false): ImplDecl {
  if (!skipValidation) {
    for (const f of s.fields) {
      const ft = this.resolve(f.type);
      const ftName = typeName(ft);
      if (!this.typeImplementsTrait(ftName, "Eq")) {
        this.error(`cannot derive Eq for '${s.name}': field '${f.name}' of type '${ftName}' does not implement Eq`);
      }
    }
  }

  const selfParam = { name: "self", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };
  const otherParam = { name: "other", type: { name: "Self", isPtr: false, isRef: true, isRefMut: false, isArray: false, arraySize: null } };

  let body: Expr;
  if (s.fields.length === 0) {
    body = { kind: "BoolLit", value: true };
  } else {
    const comparisons: Expr[] = s.fields.map(f => ({
      kind: "BinOp" as const,
      op: "==",
      left: { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "self" }, field: f.name },
      right: { kind: "FieldAccess" as const, object: { kind: "Ident" as const, name: "other" }, field: f.name },
    }));
    body = comparisons.reduce((acc, cmp) => ({
      kind: "BinOp" as const,
      op: "&&",
      left: acc,
      right: cmp,
    }));
  }

  const eqFn: Function = {
    kind: "Function",
    name: "eq",
    typeParams: [],
    params: [selfParam, otherParam],
    retType: simpleType("bool"),
    body: [{ kind: "Return" as const, value: body }],
    isExtern: false,
    isVariadic: false,
  };

  return {
    kind: "ImplDecl",
    traitName: "Eq",
    typeName: s.name,
    typeParams: [],
    methods: [eqFn],
  };
};

TypeChecker.prototype.registerBuiltinOption = function(this: TypeChecker) {
  if (this.genericEnums.has("Option")) return;
  const decl: EnumDecl = {
    kind: "EnumDecl",
    name: "Option",
    typeParams: [{ name: "T", bounds: [] }],
    variants: [
      { name: "Some", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
      { name: "None", fields: [] },
    ],
  };
  const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
  variants.set("Some", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
  variants.set("None", { tag: 1, fields: [] });
  this.genericEnums.set("Option", { typeParams: ["T"], variants, decl });
};

TypeChecker.prototype.registerBuiltinResult = function(this: TypeChecker) {
  if (this.genericEnums.has("Result")) return;
  const decl: EnumDecl = {
    kind: "EnumDecl",
    name: "Result",
    typeParams: [{ name: "T", bounds: [] }, { name: "E", bounds: [] }],
    variants: [
      { name: "Ok", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
      { name: "Err", fields: [{ name: "E", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
    ],
  };
  const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
  variants.set("Ok", { tag: 0, fields: [{ tag: "struct", name: "T" }] });
  variants.set("Err", { tag: 1, fields: [{ tag: "struct", name: "E" }] });
  this.genericEnums.set("Result", {
    typeParams: ["T", "E"],
    typeParamDefaults: [null, { tag: "string" }],
    variants,
    decl,
  });
};

TypeChecker.prototype.registerBuiltinTraits = function(this: TypeChecker) {
  const selfRef: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: false };
  const bool_t: TypeKind = { tag: "bool" };
  const i32_t: TypeKind = { tag: "int", bits: 32, signed: true };
  const u64_t: TypeKind = { tag: "int", bits: 64, signed: false };
  const string_t: TypeKind = { tag: "string" };

  this.traits.set("Eq", {
    name: "Eq",
    supertraits: [],
    methods: new Map([
      ["eq", { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: bool_t, hasDefault: false }],
    ]),
  });

  this.traits.set("Hash", {
    name: "Hash",
    supertraits: [],
    methods: new Map([
      ["hash", { params: [{ name: "self", type: selfRef }], ret: u64_t, hasDefault: false }],
    ]),
  });

  this.traits.set("Clone", {
    name: "Clone",
    supertraits: [],
    methods: new Map([
      ["clone", { params: [{ name: "self", type: selfRef }], ret: { tag: "struct", name: "Self" }, hasDefault: false }],
    ]),
  });

  this.traits.set("Display", {
    name: "Display",
    supertraits: [],
    methods: new Map([
      ["toString", { params: [{ name: "self", type: selfRef }], ret: string_t, hasDefault: false }],
    ]),
  });

  const selfType: TypeKind = { tag: "struct", name: "Self" };
  for (const [traitName, methodName] of [["Add", "add"], ["Sub", "sub"], ["Mul", "mul"], ["Div", "div"]] as const) {
    this.traits.set(traitName, {
      name: traitName,
      supertraits: [],
      methods: new Map([
        [methodName, { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: selfType, hasDefault: false }],
      ]),
    });
  }

  const selfRefMut: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: true };
  this.traits.set("Drop", {
    name: "Drop",
    supertraits: [],
    methods: new Map([
      ["drop", { params: [{ name: "self", type: selfRefMut }], ret: { tag: "void" }, hasDefault: false }],
    ]),
  });

  const primTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "string"];
  for (const pt of primTypes) {
    const eqMethods = new Map<string, FnSig>();
    eqMethods.set("eq", { params: [{ type: selfRef, name: "self" }, { type: selfRef, name: "other" }], ret: bool_t, variadic: false });
    this.traitImpls.set(pt, [{ traitName: "Eq", typeName: pt, methods: eqMethods }]);
  }

  const hashTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "bool", "string"];
  for (const pt of hashTypes) {
    const existing = this.traitImpls.get(pt) || [];
    const hashMethods = new Map<string, FnSig>();
    hashMethods.set("hash", { params: [{ type: selfRef, name: "self" }], ret: u64_t, variadic: false });
    existing.push({ traitName: "Hash", typeName: pt, methods: hashMethods });
    this.traitImpls.set(pt, existing);
  }
};

TypeChecker.prototype.resolveTypeNameForImpl = function(this: TypeChecker, name: string): string {
  if (this.structs.has(name) || this.genericStructs.has(name)) return name;
  if (this.enums.has(name) || this.genericEnums.has(name)) return name;
  return name;
};

TypeChecker.prototype.substituteSelfInMiloType = function(this: TypeChecker, ty: MiloType, concreteName: string): MiloType {
  if (ty.name === "Self") return { ...ty, name: concreteName };
  if (ty.typeArgs) return { ...ty, typeArgs: ty.typeArgs.map(a => this.substituteSelfInMiloType(a, concreteName)) };
  return ty;
};

TypeChecker.prototype.registerImpl = function(this: TypeChecker, impl: ImplDecl, program: Program, implFnsToCheck: Function[]) {
  const tn = impl.typeName;

  if (impl.typeParams && impl.typeParams.length > 0 && !impl.traitName) {
    const existing = this.genericImpls.get(tn) || [];
    existing.push({ impl, program });
    this.genericImpls.set(tn, existing);
    return;
  }

  if (impl.traitName) {
    const trait = this.traits.get(impl.traitName);
    if (!trait) {
      this.error(`unknown trait '${impl.traitName}'`, impl.span);
      return;
    }

    const existing = this.traitImpls.get(tn) || [];
    if (existing.some(i => i.traitName === impl.traitName)) {
      this.error(`duplicate impl '${impl.traitName}' for '${tn}'`, impl.span);
      return;
    }

    if (impl.traitName === "Drop") {
      const builtins = ["string", "Vec", "Heap", "HashMap"];
      if (builtins.includes(tn)) {
        this.error(`cannot impl Drop for built-in type '${tn}'`, impl.span);
        return;
      }
      if (!this.structs.has(tn) && !this.enums.has(tn)) {
        this.error(`impl Drop requires a struct or enum type, got '${tn}'`, impl.span);
        return;
      }
      this.dropImpls.add(tn);
    }

    for (const sup of trait.supertraits) {
      if (!existing.some(i => i.traitName === sup)) {
        this.error(`impl '${impl.traitName}' for '${tn}' requires impl '${sup}' for '${tn}'`, impl.span);
      }
    }

    const implMethodNames = new Set(impl.methods.map(m => m.name));
    for (const [mName, mInfo] of trait.methods) {
      if (!mInfo.hasDefault && !implMethodNames.has(mName)) {
        this.error(`impl '${impl.traitName}' for '${tn}': missing required method '${mName}'`, impl.span);
      }
    }

    const methods = new Map<string, FnSig>();
    for (const m of impl.methods) {
      const traitMethod = trait.methods.get(m.name);
      if (!traitMethod) {
        this.error(`method '${m.name}' is not defined in trait '${impl.traitName}'`, impl.span);
        continue;
      }
      const mangled = `${tn}$${impl.traitName}$${m.name}`;
      const concreteFn: Function = {
        ...m,
        name: mangled,
        params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, tn) })),
        retType: this.substituteSelfInMiloType(m.retType, tn),
      };
      const params = concreteFn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
      const ret = this.resolve(concreteFn.retType);
      this.functions.set(mangled, { params, ret, variadic: false });
      methods.set(m.name, { params, ret, variadic: false });
      this.monomorphizedFns.push(concreteFn);
      implFnsToCheck.push(concreteFn);
    }

    for (const [mName, mInfo] of trait.methods) {
      if (mInfo.hasDefault && !implMethodNames.has(mName)) {
        const traitDecl = program.traits.find(t => t.name === impl.traitName)!;
        const traitMethod = traitDecl.methods.find(m => m.name === mName)!;
        const mangled = `${tn}$${impl.traitName}$${mName}`;
        const concreteFn: Function = {
          kind: "Function",
          name: mangled,
          typeParams: [],
          params: traitMethod.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, tn) })),
          retType: this.substituteSelfInMiloType(traitMethod.retType, tn),
          body: traitMethod.body!,
          isExtern: false,
          isVariadic: false,
        };
        const params = concreteFn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
        const ret = this.resolve(concreteFn.retType);
        this.functions.set(mangled, { params, ret, variadic: false });
        methods.set(mName, { params, ret, variadic: false });
        this.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }
    }

    existing.push({ traitName: impl.traitName, typeName: tn, methods });
    this.traitImpls.set(tn, existing);
  } else {
    if (this.inherentImpls.has(tn)) {
      const existing = this.inherentImpls.get(tn)!;
      for (const m of impl.methods) {
        const mangled = `${tn}$${m.name}`;
        const concreteFn: Function = {
          ...m,
          name: mangled,
          params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, tn) })),
          retType: this.substituteSelfInMiloType(m.retType, tn),
        };
        const params = concreteFn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
        const ret = this.resolve(concreteFn.retType);
        this.functions.set(mangled, { params, ret, variadic: false });
        existing.methods.set(m.name, { params, ret, variadic: false });
        this.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }
    } else {
      const methods = new Map<string, FnSig>();
      for (const m of impl.methods) {
        const mangled = `${tn}$${m.name}`;
        const concreteFn: Function = {
          ...m,
          name: mangled,
          params: m.params.map(p => ({ name: p.name, type: this.substituteSelfInMiloType(p.type, tn) })),
          retType: this.substituteSelfInMiloType(m.retType, tn),
        };
        const params = concreteFn.params.map(p => ({ type: this.resolve(p.type), name: p.name }));
        const ret = this.resolve(concreteFn.retType);
        this.functions.set(mangled, { params, ret, variadic: false });
        methods.set(m.name, { params, ret, variadic: false });
        this.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }
      this.inherentImpls.set(tn, { traitName: null, typeName: tn, methods });
    }
  }
};

TypeChecker.prototype.resolveMethod = function(this: TypeChecker, objTypeName: string, methodName: string): { mangled: string; sig: FnSig } | null {
  const inherent = this.inherentImpls.get(objTypeName);
  if (inherent) {
    const sig = inherent.methods.get(methodName);
    if (sig) return { mangled: `${objTypeName}$${methodName}`, sig };
  }
  const impls = this.traitImpls.get(objTypeName);
  if (impls) {
    const matches: { mangled: string; sig: FnSig }[] = [];
    for (const impl of impls) {
      const sig = impl.methods.get(methodName);
      if (sig) matches.push({ mangled: `${objTypeName}$${impl.traitName}$${methodName}`, sig });
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      this.error(`ambiguous method '${methodName}' on '${objTypeName}' — implemented by multiple traits`);
      return matches[0];
    }
  }
  return null;
};

TypeChecker.prototype.typeImplementsTrait = function(this: TypeChecker, tName: string, traitName: string): boolean {
  const impls = this.traitImpls.get(tName);
  if (!impls) return false;
  if (impls.some(i => i.traitName === traitName)) return true;
  const trait = this.traits.get(traitName);
  if (trait) {
    for (const sup of trait.supertraits) {
      if (!this.typeImplementsTrait(tName, sup)) return false;
    }
  }
  return false;
};
