import type { Function, Stmt, MiloType, StructDecl } from "./ast";
import { type TypeKind, typeName } from "./types";
import { TypeChecker } from "./checker";

TypeChecker.prototype.mangleTypeName = function(this: TypeChecker, t: TypeKind): string {
  switch (t.tag) {
    case "int": return `${t.signed ? "i" : "u"}${t.bits}`;
    case "float": return `f${t.bits}`;
    case "bool": return "bool";
    case "void": return "void";
    case "string": return "string";
    case "struct": return t.name;
    case "enum": return t.name;
    case "ptr": return `ptr_${this.mangleTypeName(t.inner)}`;
    case "box": return `Box_${this.mangleTypeName(t.inner)}`;
    case "vec": return `Vec_${this.mangleTypeName(t.element)}`;
    case "hashmap": return `HashMap_${this.mangleTypeName(t.key)}_${this.mangleTypeName(t.value)}`;
    case "array": return `arr_${this.mangleTypeName(t.element)}_${t.size}`;
    case "ref": return `ref_${this.mangleTypeName(t.inner)}`;
    case "fn": return `fn_${t.params.map(p => this.mangleTypeName(p)).join("_")}_ret_${this.mangleTypeName(t.ret)}`;
    case "unknown": return "unknown";
  }
};

TypeChecker.prototype.monomorphizeEnum = function(this: TypeChecker, baseName: string, typeArgs: TypeKind[]): string {
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
};

TypeChecker.prototype.monomorphizeStruct = function(this: TypeChecker, baseName: string, typeArgs: TypeKind[]): string {
  const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
  if (this.structs.has(mangled)) return mangled;

  const generic = this.genericStructs.get(baseName)!;
  const typeMap = new Map<string, TypeKind>();
  generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

  const fields = generic.decl.fields.map(f => ({
    name: f.name,
    type: this.resolve(this.substituteMiloType(f.type, generic.typeParams, typeArgs)),
  }));
  this.structs.set(mangled, { fields, baseName, typeArgs });

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

  const genericImplTemplates = this.genericImpls.get(baseName);
  if (genericImplTemplates) {
    for (const { impl: gi, program: prog } of genericImplTemplates) {
      const concreteImpl: import("./ast").ImplDecl = {
        kind: "ImplDecl",
        traitName: gi.traitName,
        typeName: mangled,
        typeParams: [],
        methods: gi.methods.map(m => ({
          ...m,
          body: this.substituteBody(m.body, generic.typeParams, typeArgs),
          params: m.params.map(p => ({
            name: p.name,
            type: this.substituteSelfInMiloType(
              this.substituteMiloType(p.type, generic.typeParams, typeArgs),
              mangled
            ),
          })),
          retType: this.substituteSelfInMiloType(
            this.substituteMiloType(m.retType, generic.typeParams, typeArgs),
            mangled
          ),
        })),
        span: gi.span,
      };
      this.registerImpl(concreteImpl, prog, this._pendingImplFns);
    }
  }

  if (generic.decl.attributes) {
    for (const attr of generic.decl.attributes) {
      if (attr.name !== "derive") continue;
      for (const traitName of attr.args) {
        const impl = this.synthesizeDeriveImpl(decl, traitName);
        if (impl) this.registerImpl(impl, { structs: [], enums: [], functions: [], imports: [], traits: [], impls: [] }, this._pendingImplFns);
      }
    }
  }

  return mangled;
};

TypeChecker.prototype.substituteTypeKind = function(this: TypeChecker, t: TypeKind, typeMap: Map<string, TypeKind>): TypeKind {
  if (t.tag === "struct" && typeMap.has(t.name)) return typeMap.get(t.name)!;
  if (t.tag === "array") return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
  if (t.tag === "ref") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "ptr") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "box") return { ...t, inner: this.substituteTypeKind(t.inner, typeMap) };
  if (t.tag === "vec") return { ...t, element: this.substituteTypeKind(t.element, typeMap) };
  if (t.tag === "hashmap") return { ...t, key: this.substituteTypeKind(t.key, typeMap), value: this.substituteTypeKind(t.value, typeMap) };
  if (t.tag === "fn") return { ...t, params: t.params.map(p => this.substituteTypeKind(p, typeMap)), ret: this.substituteTypeKind(t.ret, typeMap) };
  return t;
};

TypeChecker.prototype.substituteMiloType = function(this: TypeChecker, ty: MiloType, typeParams: string[], typeArgs: TypeKind[]): MiloType {
  const idx = typeParams.indexOf(ty.name);
  if (idx !== -1) {
    return { ...ty, name: typeName(typeArgs[idx]) };
  }
  if (ty.isFn && ty.fnParams && ty.fnRet) {
    return {
      ...ty,
      fnParams: ty.fnParams.map(p => this.substituteMiloType(p, typeParams, typeArgs)),
      fnRet: this.substituteMiloType(ty.fnRet, typeParams, typeArgs),
    };
  }
  if (ty.typeArgs) {
    return { ...ty, typeArgs: ty.typeArgs.map(a => this.substituteMiloType(a, typeParams, typeArgs)) };
  }
  return ty;
};

TypeChecker.prototype.monomorphizeFn = function(this: TypeChecker, baseName: string, typeArgs: TypeKind[]): string {
  const mangled = `${baseName}_${typeArgs.map(a => this.mangleTypeName(a)).join("_")}`;
  if (this.functions.has(mangled)) return mangled;

  const generic = this.genericFns.get(baseName)!;
  const typeMap = new Map<string, TypeKind>();
  generic.typeParams.forEach((p, i) => typeMap.set(p, typeArgs[i]));

  for (let i = 0; i < generic.decl.typeParams.length; i++) {
    const tp = generic.decl.typeParams[i];
    const concreteType = typeArgs[i];
    for (const bound of tp.bounds) {
      if (!this.typeImplementsTrait(typeName(concreteType), bound)) {
        this.error(`type '${typeName(concreteType)}' does not implement trait '${bound}'`);
      }
    }
  }

  const params = generic.decl.params.map(p => ({
    type: this.resolve(this.substituteMiloType(p.type, generic.typeParams, typeArgs)),
    name: p.name,
  }));
  const ret = this.resolve(this.substituteMiloType(generic.decl.retType, generic.typeParams, typeArgs));

  this.functions.set(mangled, { params, ret, variadic: false });

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

  this.checkFunction(concreteDecl);

  return mangled;
};

TypeChecker.prototype.substituteBody = function(this: TypeChecker, stmts: Stmt[], typeParams: string[], typeArgs: TypeKind[]): Stmt[] {
  return JSON.parse(JSON.stringify(stmts), (key, value) => {
    if (value && typeof value === "object" && "name" in value && !("kind" in value) && typeof value.name === "string") {
      const idx = typeParams.indexOf(value.name);
      if (idx !== -1) return { ...value, name: typeName(typeArgs[idx]) };
    }
    return value;
  });
};
