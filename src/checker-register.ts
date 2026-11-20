// Declaration registration: impls, derives, builtin traits, attribute validation, extern C signatures, global ordering.
import { TypeChecker } from "./checker";
import type { Attribute, Expr, Function, GlobalDecl, MiloType, Program, Span, StructDecl } from "./ast";
import { CONDITIONAL_CLONE_BASES } from "./checker-derive";
import type { TypeKind } from "./types";
import { sameFnOwnership, typeEq } from "./types";
import { declaredType, floatNamespaceConst } from "./ast";
import { countCSigParams } from "./csig";
import { isStdCollectionModule, isUnsafeDecl, mustUseOf, rawPointerField } from "./checker-util";
import { TRACE_ATTRS, traceAttrError } from "./trace-attrs";
import { attributesFor } from "./attributes";
import { validateSqlAttribute } from "./checker-sql";
import type { FnSig, TraitInfo, TraitMethodInfo } from "./checker";

export function processDerives(c: TypeChecker, program: Program): import("./ast").ImplDecl[] {
  const result: import("./ast").ImplDecl[] = [];
  const explicitEq = new Set<string>();
  const explicitClone = new Set<string>();
  for (const tpl of program.deriveTemplates ?? []) {
    // A template may not take a built-in's name. Silently losing to `Eq` would make a
    // package's derive a no-op that still type-checks, which is the worst failure a
    // plugin point can have.
    if (tpl.name === "Eq" || tpl.name === "Json" || tpl.name === "Row" || tpl.name === "Table") {
      c.error(`'derive ${tpl.name}' collides with the built-in @derive(${tpl.name})`, tpl.span,
        `rename the template — a user derive cannot replace a built-in one`);
      continue;
    }
    const prev = c.deriveTemplates.get(tpl.name);
    if (prev && prev !== tpl) {
      c.error(`'derive ${tpl.name}' is declared twice`, tpl.span,
        `two modules in this program each define a derive named '${tpl.name}'; rename one`);
      continue;
    }
    c.deriveTemplates.set(tpl.name, tpl);
  }
  // Derives run before impls are registered, so the user's own methods are not
  // in `this.functions` yet — read them off the AST.
  for (const im of program.impls) {
    for (const m of im.methods) c.jsonUserMethods.add(`${im.typeName}.${m.name}`);
  }
  // A struct is a legal Json field type if it derives the codec or hand-wrote
  // one. Collected up front so field validation does not depend on which
  // struct the derive loop reaches first.
  for (const s of program.structs) {
    if (s.attributes?.some(a => a.name === "derive" && a.args.includes("Json"))) {
      c.jsonCapableStructs.add(s.name);
    }
  }
  for (const key of c.jsonUserMethods) {
    if (key.endsWith(".fromJsonNode")) c.jsonCapableStructs.add(key.slice(0, -".fromJsonNode".length));
  }
  for (const s of program.structs) {
    if (!s.attributes || s.typeParams.length > 0) continue;
    for (const attr of s.attributes) {
      if (attr.name !== "derive") continue;
      for (const traitName of attr.args) {
        if (traitName === "Eq") explicitEq.add(s.name);
        if (traitName === "Clone") {
          explicitClone.add(s.name);
          // Checked here, not in deriveClone: dropImpls is not populated until impls
          // register, which is after synthesis — the method-local check passed a Drop
          // type clean because it ran too early to see the impl.
          if (program.impls.some(i => i.traitName === "Drop" && i.typeName === s.name)) {
            c.error(`cannot derive Clone for '${s.name}': it implements Drop, so each clone would release the resource again on drop`, s.span);
          }
          // Synthesized after the fixpoint below, not here: an explicit derive whose
          // field is a plain struct that only the AUTO pass makes clonable would be
          // validated before that struct is, and fail with "has no clone".
          continue;
        }
        const impl = c.derive.synthesizeDeriveImpl(s, traitName);
        if (impl) result.push(impl);
      }
    }
  }
  for (const e of program.enums) {
    if (!e.attributes || e.typeParams.length > 0) continue;
    for (const attr of e.attributes) {
      if (attr.name !== "derive") continue;
      for (const traitName of attr.args) {
        if (traitName !== "Clone") continue; // rejected in validateAttributes
        explicitClone.add(e.name);
        if (program.impls.some(i => i.traitName === "Drop" && i.typeName === e.name)) {
          c.error(`cannot derive Clone for '${e.name}': it implements Drop, so each clone would release the resource again on drop`, e.span);
        }
      }
    }
  }
  // Hand-written Clone impls are not in traitImpls until registerImpl runs, which is
  // after this pass; without this set the fixpoint cannot see that `struct Q { p: P }`
  // is clonable when P's clone() is the user's own.
  c.handWrittenClone = new Set(program.impls.filter(i => i.traitName === "Clone").map(i => i.typeName));
  // auto-derive Eq for all structs not explicitly derived and not generic
  // loop until fixpoint (struct A containing struct B needs B derived first)
  const derived = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of program.structs) {
      if (s.typeParams.length > 0) continue;
      if (s.isOpaque) continue;
      if (explicitEq.has(s.name)) continue;
      if (derived.has(s.name)) continue;
      if (program.impls.some(i => i.traitName === "Eq" && i.typeName === s.name)) continue;
      let allEq = true;
      for (const f of s.fields) {
        const ft = c.resolve(f.type);
        if (!c.derive.canAutoEq(ft)) { allEq = false; break; }
      }
      if (allEq) {
        const impl = c.derive.deriveEq(s, true);
        if (impl) { result.push(impl); derived.add(s.name); changed = true; }
      }
    }
  }
  // Auto-derive Clone for every plain struct and enum, so `.clone()` exists without
  // ceremony: the explicit spelling the index-clone lint asks for has to actually be
  // available. Explicit `@derive(Clone)` types are candidates here too; the ones the
  // fixpoint cannot close are validated afterwards so the error names what blocked them.
  //
  // Greatest fixpoint, unlike Eq: start from every candidate and drop the ones a field
  // disqualifies until nothing changes. Growing from the leaves can never close a cycle
  // through Vec (`enum T { Node(Vec<T>) }`, or `struct A { e: E }` / `enum E { X(Vec<A>) }`):
  // T is clonable only if T already is. Cycles with no indirection are infinite-size
  // types the enum/struct registration already rejects.
  //
  // Two exclusions Eq does not need: a Drop type (cloning an fd closes it twice,
  // the TcpStream bug, as a method) and `@noCopy` (the attribute exists precisely
  // to stop copies of a resource handle; a clone() would be the same hazard with
  // an explicit spelling). A user's generic enum is left to monomorphization; Option and
  // Result instances join below (CONDITIONAL_CLONE_BASES).
  const cloneDerived = new Set<string>();
  for (const s of program.structs) {
    if (s.typeParams.length > 0) continue;
    if (s.isOpaque) continue;
    if (program.impls.some(i => (i.traitName === "Clone" || i.traitName === "Drop") && i.typeName === s.name)) continue;
    if (s.attributes?.some(a => a.name === "noCopy")) continue;
    if (c.structs.get(s.name)?.pointerField) continue;
    cloneDerived.add(s.name);
  }
  for (const e of program.enums) {
    if (e.typeParams.length > 0) continue;
    if (program.impls.some(i => (i.traitName === "Clone" || i.traitName === "Drop") && i.typeName === e.name)) continue;
    if (e.attributes?.some(a => a.name === "noCopy")) continue;
    cloneDerived.add(e.name);
  }
  // Option/Result instances that already exist (a field or signature spelled them)
  // join the fixpoint, so `struct Q { o: Option<Q2> }` closes together with Q2. A Copy
  // instance is skipped: `.clone()` on it is already the identity.
  const builtinInstances: import("./ast").EnumDecl[] = [];
  for (const [name, info] of c.enums) {
    if (!info.decl || !info.baseName || !CONDITIONAL_CLONE_BASES.has(info.baseName)) continue;
    if (c.isCopyType({ tag: "enum", name })) continue;
    builtinInstances.push(info.decl);
    cloneDerived.add(name);
  }
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (const s of program.structs) {
      if (!cloneDerived.has(s.name)) continue;
      if (s.fields.every(f => c.derive.canAutoClone(c.resolve(f.type), cloneDerived))) continue;
      cloneDerived.delete(s.name);
      shrunk = true;
    }
    for (const e of [...program.enums, ...builtinInstances]) {
      const conditional = CONDITIONAL_CLONE_BASES.has(c.enums.get(e.name)?.baseName ?? "");
      if (!cloneDerived.has(e.name) || !c.derive.enumCloneBlocker(e.name, cloneDerived, !conditional)) continue;
      cloneDerived.delete(e.name);
      shrunk = true;
    }
  }
  for (const s of program.structs) {
    if (cloneDerived.has(s.name)) result.push(c.derive.deriveClone(s, true));
  }
  for (const e of [...program.enums, ...builtinInstances]) {
    if (!cloneDerived.has(e.name)) continue;
    const impl = c.derive.deriveCloneEnum(e, true);
    if (impl) result.push(impl);
  }
  c.cloneDerived = cloneDerived;
  c._derivesProcessed = true;
  for (const s of program.structs) {
    if (!explicitClone.has(s.name) || cloneDerived.has(s.name)) continue;
    const impl = c.derive.deriveClone(s, false, cloneDerived);
    if (impl) result.push(impl);
  }
  for (const e of program.enums) {
    if (!explicitClone.has(e.name) || cloneDerived.has(e.name)) continue;
    const impl = c.derive.deriveCloneEnum(e, false, cloneDerived);
    if (impl) result.push(impl);
  }
  return result;
}

export function registerBuiltinOption(c: TypeChecker) {
  if (c.genericEnums.has("Option")) return;
  const decl: import("./ast").EnumDecl = {
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
  c.genericEnums.set("Option", { typeParams: ["T"], variants, decl });
}

export function registerBuiltinResult(c: TypeChecker) {
  if (c.genericEnums.has("Result")) return;
  const decl: import("./ast").EnumDecl = {
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
  c.genericEnums.set("Result", {
    typeParams: ["T", "E"],
    typeParamDefaults: [null, { tag: "string" }],
    variants,
    decl,
  });
}

export function registerBuiltinTraits(c: TypeChecker) {
  const selfRef: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: false };
  const bool_t: TypeKind = { tag: "bool" };
  const u64_t: TypeKind = { tag: "int", bits: 64, signed: false };
  const string_t: TypeKind = { tag: "string" };

  // Eq trait
  c.traits.set("Eq", {
    name: "Eq",
    supertraits: [],
    methods: new Map([
      ["eq", { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: bool_t, hasDefault: false }],
    ]),
  });

  // Hash trait
  c.traits.set("Hash", {
    name: "Hash",
    supertraits: [],
    methods: new Map([
      ["hash", { params: [{ name: "self", type: selfRef }], ret: u64_t, hasDefault: false }],
    ]),
  });

  // Clone trait
  c.traits.set("Clone", {
    name: "Clone",
    supertraits: [],
    methods: new Map([
      ["clone", { params: [{ name: "self", type: selfRef }], ret: { tag: "struct", name: "Self" }, hasDefault: false }],
    ]),
  });

  // Display trait
  c.traits.set("Display", {
    name: "Display",
    supertraits: [],
    methods: new Map([
      ["toString", { params: [{ name: "self", type: selfRef }], ret: string_t, hasDefault: false }],
    ]),
  });

  // Iterator marker trait. Milo has no associated types, so the element type can't be
  // named in the trait method — instead the iteration contract (`next(&mut Self):
  // Option<T>`) is checked structurally at each `for x in it` site (duck-typed on the
  // method). `impl Iterator for X {}` marks X as iterable so it satisfies an
  // `<I: Iterator>` bound and is nameable in prover contracts over "any iterator".
  c.traits.set("Iterator", { name: "Iterator", supertraits: [], methods: new Map() });

  // Operator traits
  const selfType: TypeKind = { tag: "struct", name: "Self" };
  for (const [traitName, methodName] of [["Add", "add"], ["Sub", "sub"], ["Mul", "mul"], ["Div", "div"]] as const) {
    c.traits.set(traitName, {
      name: traitName,
      supertraits: [],
      methods: new Map([
        [methodName, { params: [{ name: "self", type: selfRef }, { name: "other", type: selfRef }], ret: selfType, hasDefault: false }],
      ]),
    });
  }

  // Drop trait — self: &mut Self
  const selfRefMut: TypeKind = { tag: "ref", inner: { tag: "struct", name: "Self" }, mutable: true };
  c.traits.set("Drop", {
    name: "Drop",
    supertraits: [],
    methods: new Map([
      ["drop", { params: [{ name: "self", type: selfRefMut }], ret: { tag: "void" }, hasDefault: false }],
    ]),
  });

  // register primitive impls for Eq (checker-only, no codegen needed)
  const primTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "string"];
  for (const pt of primTypes) {
    const eqMethods = new Map<string, FnSig>();
    eqMethods.set("eq", { params: [{ type: selfRef, name: "self" }, { type: selfRef, name: "other" }], ret: bool_t, variadic: false });
    c.traitImpls.set(pt, [{ traitName: "Eq", typeName: pt, methods: eqMethods }]);
  }

  // Hash impls for hashable primitives
  const hashTypes = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "bool", "string"];
  for (const pt of hashTypes) {
    const existing = c.traitImpls.get(pt) || [];
    const hashMethods = new Map<string, FnSig>();
    hashMethods.set("hash", { params: [{ type: selfRef, name: "self" }], ret: u64_t, variadic: false });
    existing.push({ traitName: "Hash", typeName: pt, methods: hashMethods });
    c.traitImpls.set(pt, existing);
  }
}

// An impl method is only ever called through the TRAIT's signature: `a + b` passes both
// operands by reference because `Add.add` says `&Self`, `Drop.drop` is handed `&mut Self`,
// a `<T: Trait>` call site borrows exactly what the trait declares. So an impl that spells
// a parameter differently is not a looser contract, it is a body reading the wrong bytes:
// `add(self: Res, other: Res)` read a pointer as a struct and then dropped it (H7).
// Compare receiver mode, arity, every parameter's type and reference mode, and the
// return type, with `Self` substituted for the implementing type on the trait side.
export function checkImplMethodSignature(c: TypeChecker, impl: import("./ast").ImplDecl, m: Function, trait: TraitInfo, traitMethod: TraitMethodInfo, implParams: { name: string; type: TypeKind }[], implRet: TypeKind): void {
  // A method with its own type parameters is a template on both sides; there is no
  // concrete signature to compare until it is instantiated.
  if (m.typeParams && m.typeParams.length > 0) return;
  const typeName = impl.typeName;
  const where = `'${m.name}' in 'impl ${impl.traitName} for ${c.demangle(typeName)}'`;
  const sp = m.span ?? impl.span;
  const selfMilo = c.selfTypeOf(typeName);
  const substSelf = (t: MiloType) => c.substituteSelfInMiloType(t, selfMilo.name, selfMilo.typeArgs);
  const expected = traitMethod.decl
    ? {
        params: traitMethod.decl.params.map(p => ({ name: p.name, type: c.resolve(substSelf(declaredType(p))) })),
        ret: c.resolve(substSelf(traitMethod.decl.retType)),
      }
    : (() => {
        const selfTy = c.resolve(selfMilo);
        const subst = (t: TypeKind): TypeKind =>
          t.tag === "struct" && t.name === "Self" ? selfTy
          : t.tag === "ref" ? { ...t, inner: subst(t.inner) }
          : t;
        return { params: traitMethod.params.map(p => ({ name: p.name, type: subst(p.type) })), ret: subst(traitMethod.ret) };
      })();
  // The signature as the trait spells it, which is also what the impl should write.
  const declared = `fn ${m.name}(${traitMethod.params.map(p => `${p.name}: ${c.show(p.type)}`).join(", ")}): ${c.show(traitMethod.ret)}`;
  const hint = `the trait's signature is '${declared}'; write it that way in the impl`;
  if (implParams.length !== expected.params.length) {
    c.error(`${where} takes ${implParams.length} parameter(s); the trait '${trait.name}' declares ${expected.params.length}`, sp, hint);
    return;
  }
  for (let i = 0; i < implParams.length; i++) {
    const got = implParams[i]!.type;
    const want = expected.params[i]!.type;
    if (typeEq(got, want) && sameFnOwnership(got, want)) continue;
    const mode =
      got.tag !== "ref" && want.tag === "ref" ? " by value"
      : got.tag === "ref" && want.tag !== "ref" ? " by reference"
      : got.tag === "ref" && want.tag === "ref" && got.mutable !== want.mutable ? (got.mutable ? " by mutable reference" : " by shared reference")
      : "";
    const traitParam = traitMethod.params[i]!;
    c.error(`${where} takes '${implParams[i]!.name}: ${c.show(got)}'${mode}; the trait '${trait.name}' declares '${traitParam.name}: ${c.show(traitParam.type)}'`, sp, hint);
    return;
  }
  if (!typeEq(implRet, expected.ret)) {
    c.error(`${where} returns '${c.show(implRet)}'; the trait '${trait.name}' declares '${c.show(traitMethod.ret)}'`, sp, hint);
  }
}

export function isExternStructType(c: TypeChecker, ty: TypeKind): boolean {
  return ty.tag === "struct" && !!c.structs.get(ty.name)?.isExtern;
}

// `@cSig("unistd.h", "long sysconf(int)")` — the C signature is checked against the real
// header at build time. Milo's type system can't express C type identity (is `i64` a
// `long` or a `long long`? on macOS they're distinct types of the same width), so the
// compiler cannot derive this — the declaration states it and the build verifies it.
export function checkCSig(c: TypeChecker, f: Function, attr: Attribute): void {
  if (!f.isExtern) {
    c.error(`@cSig on '${f.name}': only an 'extern fn' has a C signature to verify`, undefined,
      `a Milo fn is compiled from this source — there's no foreign declaration to check it against`);
    return;
  }
  if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
    c.error(`@cSig on '${f.name}': expected two string arguments`, undefined,
      `write '@cSig("unistd.h", "int ${f.name}(int)")' — the header, then the C signature as the header spells it`);
    return;
  }
  const header = attr.args[0]!, sig = attr.args[1]!;
  if (!TypeChecker.isCHeaderSpec(header)) {
    c.error(`@cSig on '${f.name}': '${header}' is not a C header path`, undefined,
      `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'unistd.h'. Separate per-platform spellings with '|' when no one name is portable`);
    return;
  }
  if (!TypeChecker.C_SIG_RE.test(sig)) {
    c.error(`@cSig on '${f.name}': '${sig}' is not a C function signature`, undefined,
      `expected the declaration as C spells it — e.g. 'ssize_t ${f.name}(int, void *, size_t)'`);
    return;
  }
  const cSym = f.linkName ?? f.name;
  if (!new RegExp(`(^|[^A-Za-z0-9_])${cSym}\\s*\\(`).test(sig)) {
    c.error(`@cSig on '${cSym}': the signature declares a different function`, undefined,
      `'${sig}' must name '${cSym}' — the assert is generated against that symbol`);
    return;
  }
  // Arity is checkable here, with no header in the picture: the guard TU compares C
  // parameter i against Milo parameter i, so a signature that lists a different number
  // of parameters than the decl would silently shift every comparison by one.
  const cArity = countCSigParams(sig);
  if (cArity !== null && !f.isVariadic && cArity !== f.params.length) {
    c.error(`@cSig on '${f.name}': the signature takes ${cArity} parameter${cArity === 1 ? "" : "s"}, the Milo declaration takes ${f.params.length}`, undefined,
      `'${sig}' and the 'extern fn' must describe the same call`);
    return;
  }
  c.cSigs.set(f.name, { header, sig });
}

// `@cValue("SDL_PIXELFORMAT_ABGR8888", "SDL2/SDL.h")` pins a Milo constant to the C
// macro or enumerator it transcribes. The guard TU compares the two, so the value has
// to survive into generated C as a literal — hence the integer-literal restriction.
export function checkCValue(c: TypeChecker, g: GlobalDecl, attr: Attribute, type: TypeKind): void {
  if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
    c.error(`@cValue on '${g.name}': expected two string arguments`, g.span,
      `write '@cValue("${g.name}", "SDL2/SDL.h")' — the C name, then the header that defines it`);
    return;
  }
  const cName = attr.args[0]!, header = attr.args[1]!;
  if (!TypeChecker.C_IDENT_RE.test(cName)) {
    c.error(`@cValue on '${g.name}': '${cName}' is not a C identifier`, g.span,
      `expected the macro or enumerator name as C spells it — e.g. 'SDL_INIT_VIDEO'`);
    return;
  }
  if (!TypeChecker.isCHeaderSpec(header)) {
    c.error(`@cValue on '${g.name}': '${header}' is not a C header path`, g.span,
      `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'SDL2/SDL.h'`);
    return;
  }
  if (g.mutable) {
    c.error(`@cValue on '${g.name}': a 'var' is not a constant, so there is nothing fixed to compare against C`, g.span,
      `declare it with 'let'`);
    return;
  }
  if (type.tag !== "int") {
    c.error(`@cValue on '${g.name}': only an integer constant can be checked against a C macro, got ${c.show(type)}`, g.span,
      `the guard compares the two with '==' in C, which needs an integer on both sides`);
    return;
  }
  // A computed initializer would have to be re-derived in C to compare it. Folding it
  // here instead would compare Milo's arithmetic against itself, which proves nothing
  // about the header — so require the literal the author actually transcribed.
  const v = g.value;
  const isIntLit = v.kind === "IntLit" || (v.kind === "UnaryOp" && v.op === "-" && v.operand.kind === "IntLit");
  if (!isIntLit) {
    c.error(`@cValue on '${g.name}': the initializer must be an integer literal`, g.span,
      `@cValue checks a transcribed constant against its header; an expression has nothing to transcribe`);
    return;
  }
  c.cValues.set(g.name, { cName, header });
}

// `@copy` is a claim with one meaning: this struct holds a raw pointer it does not own.
// On a struct with no pointer field it is a no-op that lies about why the type is Copy,
// so it is rejected rather than ignored. A generic template is judged on its declared
// field types (`*T`, `*u8`), since a bare `T` may or may not become a pointer.
export function validateCopyAttr(c: TypeChecker, s: StructDecl, attr: Attribute, program: Program) {
  if (attr.args && attr.args.length > 0) {
    c.error(`'@copy' on '${s.name}' takes no arguments`, s.span,
      `write '@copy' on its own line above the struct`);
  }
  if (s.attributes?.some(a => a.name === "noCopy")) {
    c.error(`'@copy' and '@noCopy' on '${s.name}' contradict each other`, s.span,
      `'@copy' keeps a pointer-holding struct Copy; '@noCopy' makes a struct move-tracked. Keep the one that says who owns the resource`);
    return;
  }
  if (program.impls.some(i => i.traitName === "Drop" && i.typeName === s.name)) {
    c.error(`'@copy' on '${s.name}' contradicts its Drop impl: a type with a destructor is never Copy`, s.span,
      `a Drop impl means the value owns something to release, which is exactly what '@copy' denies. Drop the attribute`);
    return;
  }
  const isPtrType = (t: MiloType): boolean => t.isPtr || (t.ptrDepth ?? 0) > 0;
  const pointerField = s.typeParams.length > 0
    ? s.fields.find(f => isPtrType(f.type))?.name
    : rawPointerField(c.structs.get(s.name)?.fields ?? []);
  if (!pointerField) {
    c.error(`'@copy' on '${s.name}' does nothing: no field of it is a raw pointer`, s.span,
      `'@copy' keeps a struct Copy although it holds a raw pointer it does not own. A struct with no pointer field is already Copy when its fields are, so drop the attribute`);
    return;
  }
  // The census of pointer-carrying Copy structs, as a lint. Off by default: every
  // `@copy` in the tree was placed on purpose. `--deny=unowned-pointer-copy` lists them,
  // so an audit can re-ask each one the question the attribute answered.
  c.warn("unowned-pointer-copy",
    `'${s.name}' is @copy and holds a raw pointer ('${pointerField}'): a copy of it shares whatever the pointer addresses`,
    s.span,
    `this is what '@copy' asks for. Confirm that '${s.name}' does not own the pointee (a C-owned record, a pointer into a buffer another value owns); if it does, remove '@copy' so the struct is move-tracked`);
}

// `@copyOnly` constrains type parameters, so on a declaration without any it would be
// a claim about nothing; say so rather than accept an annotation that does no work.
export function validateCopyOnly(c: TypeChecker, declName: string, attr: Attribute, typeParams: string[], span?: Span): void {
  attr.args.forEach((arg, i) => {
    if (attr.argKinds?.[i] !== "ident" || !typeParams.includes(arg)) {
      c.error(`'@copyOnly(${arg})' on '${declName}': '${arg}' is not one of its type parameters`, span,
        typeParams.length > 0
          ? `it declares ${typeParams.map(t => `'${t}'`).join(", ")}; write '@copyOnly' bare to constrain all of them`
          : `write '@copyOnly' on a generic declaration`);
    }
  });
  if (typeParams.length === 0) {
    c.error(`'@copyOnly' on '${declName}': it has no type parameters to constrain`, span,
      `'@copyOnly' restricts what a generic's type parameters may be instantiated with; a concrete type has none, so drop the attribute`);
  }
}

// `@copy` on an enum: the same claims as on a struct, against a variant payload.
export function validateEnumCopyAttr(c: TypeChecker, e: import("./ast").EnumDecl, attr: Attribute, program: Program) {
  if (attr.args && attr.args.length > 0) {
    c.error(`'@copy' on '${e.name}' takes no arguments`, e.span, `write '@copy' on its own line above the enum`);
  }
  if (program.impls.some(i => i.traitName === "Drop" && i.typeName === e.name)) {
    c.error(`'@copy' on '${e.name}' contradicts its Drop impl: a type with a destructor is never Copy`, e.span,
      `a Drop impl means the value owns something to release, which is exactly what '@copy' denies. Drop the attribute`);
    return;
  }
  // Read off the AST: this runs before the enum's variants are registered.
  const isPtrType = (t: MiloType): boolean => t.isPtr || (t.ptrDepth ?? 0) > 0;
  if (!e.variants.some(v => v.fields.some(isPtrType))) {
    c.error(`'@copy' on '${e.name}' does nothing: no variant of it carries a raw pointer`, e.span,
      `'@copy' keeps an enum Copy although a variant holds a raw pointer it does not own. An enum with no pointer payload is already Copy when its payloads are, so drop the attribute`);
  }
}

export function validateAttributes(c: TypeChecker, declName: string, attrs: Attribute[] | undefined, target: "struct" | "enum"): void {
  if (!attrs) return;
  const known = TypeChecker.KNOWN_ATTRS.map(a => `@${a}`).join(", ");
  for (const attr of attrs) {
    if (!TypeChecker.KNOWN_ATTRS.includes(attr.name)) {
      c.error(`unknown attribute '@${attr.name}' on '${declName}'`, undefined, `known attributes: ${known}`);
    } else if (TRACE_ATTRS.has(attr.name) && target === "struct") {
      const bad = traceAttrError(attr, "struct");
      if (bad) c.error(`'@${attr.name}' on '${declName}': ${bad}`);
    } else if (target === "enum") {
      // Clone is the one derive an enum consumes (processDerives); Eq/Json/user
      // templates still only expand over a struct, so they keep the old rejection.
      if (attr.name === "derive" && attr.args.every(a => a === "Clone")) continue;
      if (attr.name === "copy") continue; // validated in validateEnumCopyAttr
      c.error(`'@${attr.name}' is not supported on enums — '${declName}'`, undefined,
        `only structs consume attributes today; on an enum it would be silently ignored`);
    }
  }
}

export function checkVariadicExtern(c: TypeChecker, fn: Function): void {
  if (!fn.isExtern) return;
  const fixed = TypeChecker.VARIADIC_LIBC.get(fn.name);
  if (fixed === undefined) return;
  if (c.entryFile && fn.span?.file && fn.span.file !== c.entryFile) return;

  const why = `On AArch64 a variadic callee reads its variadic args off the stack while a ` +
    `fixed-arity call passes them in registers, so the callee sees garbage. x86_64 hides this ` +
    `(the conventions agree for integer args), which is why it survives testing.`;

  if (!fn.isVariadic && fn.params.length > fixed) {
    c.error(
      `extern '${fn.name}' declares ${fn.params.length} fixed parameters but C fixes only ${fixed} — ` +
      `the rest are variadic, so this miscompiles silently on AArch64`,
      fn.span,
      `declare it 'extern fn ${fn.name}(<${fixed} fixed param(s)>,...): ...' and pass the rest as variadic args. ${why}`);
    return;
  }
  if (fn.isVariadic && fn.params.length !== fixed) {
    c.error(
      `extern '${fn.name}' declares ${fn.params.length} fixed parameter(s) before '...' but C fixes ${fixed}`,
      fn.span,
      `a parameter on the wrong side of the '...' is passed in the wrong place. ${why}`);
  }
}

// The `extern fn` half of the same lint. A signature is as much an unverified claim as a
// layout is, and the pointer parameters are the worse half: a wrong field offset reads
// garbage, a wrong pointee width lets the callee write past what the caller reserved.
export function warnUnverifiedExternFn(c: TypeChecker, fn: Function): void {
  if (!fn.isExtern) return;
  if (fn.attributes?.some(a => a.name === "cSig")) return;
  if (c.entryFile && fn.span?.file && fn.span.file !== c.entryFile) return;
  const ptrParam = fn.params.find(p => declaredType(p).isPtr);
  const why = ptrParam
    ? `'${ptrParam.name}' is a pointer C writes through, so its pointee width is part of the contract and nothing checks it`
    : `parameter and return widths are a claim about C that nothing checks`;
  c.warn("unverified-extern",
    `extern fn '${fn.name}' has no @cSig — its signature is an unverified claim about C`,
    fn.span,
    `${why}. Add '@cSig("some/header.h", "<the declaration as C spells it>")'`);
}

export function warnUnverifiedExtern(c: TypeChecker, s: StructDecl): void {
  if (!s.isExtern || s.isOpaque) return;              // opaque types have no fields to verify
  if (s.attributes?.some(a => a.name === "cLayout")) return;
  if (c.entryFile && s.span?.file && s.span.file !== c.entryFile) return;
  c.warn("unverified-extern",
    `extern struct '${s.name}' has no @cLayout — its layout is an unverified claim about C`,
    s.span,
    `add '@cLayout("struct ${s.name.toLowerCase()}", "some/header.h")' to check the field offsets against the real header at build time`);
}

// `@cOpaque` marks a field as filler with no C counterpart, so @cLayout skips it —
// needed for structs padded out to a size C dictates (getrusage writes 144 bytes into
// a struct whose named fields only cover 32). It still counts toward Milo's own layout,
// so the size assert stays meaningful. `@json("name")` renames a field on the wire.
// Anything else on a field is rejected: a silently ignored attribute is the failure
// this whole feature exists to close.
export function validateFieldAttributes(c: TypeChecker, s: StructDecl): void {
  let iterFields = 0;
  const derivesJson = s.attributes?.some(a => a.name === "derive" && a.args.includes("Json")) ?? false;
  for (const f of s.fields) {
    if (!f.attributes) continue;
    for (const attr of f.attributes) {
      if (attr.name === "iter") {
        if (attr.args.length !== 0) {
          c.error(`@iter on '${s.name}.${f.name}': takes no arguments`, s.span);
        }
        // The delegate must itself be something `for-in` knows how to walk. A
        // second one would make `for x in wrapper` ambiguous with no way to say
        // which you meant, so one per struct.
        if (++iterFields > 1) {
          c.error(`'${s.name}' has more than one @iter field`, s.span,
            `a struct iterates exactly one field — mark only the container that 'for x in ${s.name.toLowerCase()}' should walk`);
        }
        // Read the written type rather than resolving it: on a generic decl the
        // field's type arguments are still type parameters, and resolving
        // `HashMap<T, bool>` here would report T as an unhashable key.
        const ft = f.type;
        const iterable = !ft.isRef && !ft.isRefMut && !ft.isPtr &&
          (ft.isArray || ft.name === "Vec" || ft.name === "HashMap" || ft.name === "string");
        if (!iterable) {
          c.error(`@iter on '${s.name}.${f.name}': '${ft.name}' is not iterable`, s.span,
            `mark a Vec, HashMap, array, or string field`);
        }
      } else if (attr.name === "json") {
        // Arity and content are validated in deriveJson, where the error can
        // name the generated codec. Here only the "nothing consumes it" case.
        if (!derivesJson) {
          c.error(`@json on '${s.name}.${f.name}': the struct does not derive Json`, s.span,
            `add '@derive(Json)' to '${s.name}', or drop the field attribute — nothing else reads it`);
        }
      } else if (attr.name === "cName") {
        // The argument is pasted into `offsetof(struct T, <arg>)` in the guard TU, so it
        // must be a C identifier and nothing more: anything else would be C source.
        if (!s.isExtern) {
          c.error(`@cName on '${s.name}.${f.name}': only an 'extern struct' field has a C name`, s.span,
            `a Milo struct has no C counterpart to name`);
        } else if (attr.args.length !== 1 || attr.argKinds?.[0] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(attr.args[0]!)) {
          c.error(`@cName on '${s.name}.${f.name}': expected one string argument naming a C identifier, e.g. @cName("type")`, s.span);
        } else if (f.attributes.some(a => a.name === "cOpaque")) {
          c.error(`@cName on '${s.name}.${f.name}': a @cOpaque field has no C counterpart to name`, s.span);
        } else if (s.fields.some(o => o !== f && (o.attributes?.find(a => a.name === "cName")?.args[0] ?? o.name) === attr.args[0])) {
          c.error(`@cName on '${s.name}.${f.name}': another field of '${s.name}' already maps to C field '${attr.args[0]}'`, s.span);
        }
      } else if (attr.name !== "cOpaque") {
        c.error(`'@${attr.name}' is not supported on a struct field — '${s.name}.${f.name}'`, s.span,
          `only ${attributesFor("field").map(a => `'@${a}'`).join(", ")} apply to a field`);
      } else if (!s.isExtern) {
        c.error(`@cOpaque on '${s.name}.${f.name}': only an 'extern struct' field can be C-invisible`, s.span,
          `a Milo struct has no C layout to be opaque against`);
      } else if (attr.args.length !== 0) {
        c.error(`@cOpaque on '${s.name}.${f.name}': takes no arguments`, s.span);
      }
    }
  }
}

export function checkCLayout(c: TypeChecker, s: StructDecl, attr: Attribute): void {
  if (!s.isExtern || s.isOpaque) {
    c.error(`@cLayout on '${s.name}': only 'extern struct' has a C layout to verify`, undefined,
      `@cLayout checks declared field offsets against a C header — a Milo struct has no C counterpart`);
    return;
  }
  if (attr.args.length !== 2 || attr.argKinds?.some(k => k !== "string")) {
    c.error(`@cLayout on '${s.name}': expected two string arguments`, undefined,
      `write '@cLayout("struct ${s.name.toLowerCase()}", "some/header.h")' — the C type name and the header declaring it`);
    return;
  }
  const cType = attr.args[0]!, header = attr.args[1]!;
  if (!TypeChecker.C_TYPE_RE.test(cType)) {
    c.error(`@cLayout on '${s.name}': '${cType}' is not a C type name`, undefined,
      `expected something like 'struct stat', 'mytypedef_t', or 'union sigval'`);
    return;
  }
  if (!TypeChecker.isCHeaderSpec(header)) {
    c.error(`@cLayout on '${s.name}': '${header}' is not a C header path`, undefined,
      `expected a header ending in '.h', as written inside '#include <...>' — e.g. 'sys/stat.h'`);
    return;
  }
  const info = c.structs.get(s.name);
  if (info) info.cLayout = { cType, header };
}

// extern-struct fields must be plain-old-data: scalars, raw pointers, nested extern
// structs, or fixed arrays of those. Strings/Vecs/enums carry drop glue or a non-C
// layout, so an extern struct built from them could never round-trip through C.
export function isValidExternStructField(c: TypeChecker, ty: TypeKind): boolean {
  switch (ty.tag) {
    case "int": case "float": case "bool": case "ptr": return true;
    case "array": return ty.size !== null && c.isValidExternStructField(ty.element);
    case "struct": { const info = c.structs.get(ty.name); return !!info && !!info.isExtern; }
    case "cfn": return c.isCReprFnSig(ty);
    default: return false;
  }
}

// Inside an `extern struct`, `(A, B) => R` names the C spelling: one thin code
// pointer, not the `{ code, environment }` pair a Milo fn value carries. `cfn` is
// already exactly that type (it lowers to a bare `ptr`), so the rewrite happens
// once here and layout, the @cLayout guard TU, headergen and the call site all see
// the right thing with no context-sensitive special case of their own. A `move`
// closure type keeps its `fn` tag deliberately: it owns a heap environment, which
// is the one thing a C field cannot hold, so it falls through to the
// not-C-representable error instead of being silently thinned.
export function thinFnField(_c: TypeChecker, isExtern: boolean | undefined, t: TypeKind): TypeKind {
  if (!isExtern || t.tag !== "fn" || t.owning) return t;
  return { tag: "cfn", params: t.params, ret: t.ret };
}

// What may be stored in a C function-pointer field, and the whole reason the set is
// this small: the field is one word, so a value that is not already one word has to
// lose half of itself on the way in. A top-level `fn` name is the code pointer with
// nothing attached; another such field is a pointer copy. Everything else carries an
// environment C has nowhere to put.
//
// Returns true when it has handled the value (accepted or reported); false to let the
// caller raise its ordinary type-mismatch error.
export function checkCFnStore(c: TypeChecker, value: Expr, expected: TypeKind & { tag: "cfn" }, valType: TypeKind, where: string, sp?: Span): boolean {
  if (valType.tag === "cfn") {
    if (typeEq(expected, valType)) { c.strandedCFnReads.delete(value); return true; }
    return false;
  }
  if (valType.tag !== "fn") return false;
  // ident-ok: the accepted form IS a bare top-level function name; anything else is
  // a value with an environment and is rejected below.
  if (value.kind === "Ident" && c.functions.has(value.name) && c.lookup(value.name) === null) {
    const thin: TypeKind = { tag: "cfn", params: valType.params, ret: valType.ret };
    if (typeEq(expected, thin)) return true;
    c.error(`${where}: '${value.name}' has signature ${c.show(thin)}, expected ${c.show(expected)}`, sp);
    return true;
  }
  c.error(`${where}: only a top-level 'fn' can be stored in a C function-pointer field`, sp,
    `a closure value is a { code, environment } pair and this field holds only the code pointer, so the environment would be lost and the C call would read garbage — name a top-level function instead`);
  return true;
}

// A C function pointer's own parameters and return have to cross the ABI too. A
// nested fn type is excluded: inside a signature there is no field declaration to
// thin it, so it would be Milo's fat pair again and the C caller would disagree
// about the argument count.
export function isCReprFnSig(c: TypeChecker, ty: { params: TypeKind[]; ret: TypeKind }): boolean {
  const ok = (t: TypeKind) => t.tag !== "fn" && t.tag !== "cfn" && c.isValidExternStructField(t);
  return ty.params.every(ok) && (ty.ret.tag === "void" || ok(ty.ret));
}

// What may appear in an extern fn signature (by value). `&T` and `*T` cross by
// reference and are always fine; a struct crosses by value only if it's `extern struct`;
// enums and regular structs have no stable C representation. Returns an error to raise, or null.
export function externSigError(c: TypeChecker, ty: TypeKind, role: "parameter" | "return type"): { msg: string; hint?: string } | null {
  switch (ty.tag) {
    case "int": case "float": case "bool": case "ptr": case "ref": case "string": return null;
    case "void": return role === "return type" ? null : { msg: `extern function parameter cannot be void` };
    case "array":
      return ty.size !== null && c.isValidExternStructField(ty.element)
        ? null : { msg: `${role} '${c.show(ty)}' has no stable C representation` };
    case "struct": {
      const info = c.structs.get(ty.name);
      if (!info) return { msg: `unknown type '${ty.name}' in extern ${role}` };
      if (!info.isExtern)
        return { msg: `struct '${ty.name}' crosses the C ABI by value but is not declared 'extern struct'`,
                 hint: `declare '${ty.name}' as 'extern struct', or pass it by reference (&${ty.name})` };
      return null;
    }
    case "enum":
      return { msg: `enum '${ty.name}' cannot cross the C ABI (no stable representation)`,
               hint: `pass a pointer (*${ty.name}) or an integer tag instead` };
    case "fn":
      // fn-ptr callbacks are fine unless they themselves pass a struct by value (out of scope)
      for (const p of ty.params)
        if (p.tag === "struct")
          return { msg: `function-pointer ${role} passes struct '${p.name}' by value`,
                   hint: `by-value structs in callbacks aren't supported — pass a pointer` };
      return ty.ret.tag === "struct"
        ? { msg: `function-pointer ${role} returns struct '${(ty.ret as any).name}' by value`,
            hint: `by-value structs in callbacks aren't supported — return a pointer` }
        : null;
    default:
      return { msg: `${role} '${c.show(ty)}' is not valid in an extern function signature` };
  }
}

export function registerImpl(c: TypeChecker, impl: import("./ast").ImplDecl, program: Program, implFnsToCheck: Function[]) {
  const typeName = impl.typeName;

  if (impl.traitName === "Send" || impl.traitName === "Sync") {
    if (!impl.isUnsafe) {
      c.error(`manual '${impl.traitName}' implementation for '${typeName}' must be unsafe`, impl.span,
        `write 'unsafe impl ${impl.traitName} for ${typeName} {}' because the compiler cannot verify this promise`);
      return;
    }
    if (impl.methods.length > 0) {
      c.error(`unsafe impl '${impl.traitName}' for '${typeName}' is a marker and cannot define methods`, impl.span);
      return;
    }
    if (!c.structs.has(typeName) && !c.genericStructs.has(typeName)) {
      c.error(`unsafe impl '${impl.traitName}' requires a struct type, got '${typeName}'`, impl.span);
      return;
    }
    (impl.traitName === "Send" ? c.sendTypes : c.syncTypes).add(typeName);
    return;
  }
  if (impl.isUnsafe) {
    c.error(`unsafe impl is only supported for the Send and Sync marker traits`, impl.span);
    return;
  }

  // 'addrOf' is the built-in universal raw address-of operator (x.addrOf(): *T).
  // Reserve the name so `x.addrOf()` means exactly one thing everywhere — a
  // user method of the same name would be silently shadowed (context-dependent
  // dispatch), which is the ambiguity this design exists to remove.
  for (const m of impl.methods) {
    if (m.name === "addrOf")
      c.error(`'addrOf' is a reserved method name — it is the built-in raw address-of operator ('x.addrOf(): *T'). Rename this method.`, m.span ?? impl.span);
    // Method attributes were silently dropped before they could be parsed at all;
    // reject the unknown ones here so a typo can't look like it took effect.
    for (const attr of m.attributes ?? []) {
      if (!attributesFor("method").includes(attr.name)) {
        c.error(`'@${attr.name}' is not supported on methods — '${typeName}.${m.name}'`, m.span ?? impl.span,
          `only ${attributesFor("method").map(a => `'@${a}'`).join(", ")} apply to a method`);
      } else if (attr.name === "sql" || attr.name === "sqlSchema") {
        const bad = validateSqlAttribute(attr, `${typeName}.${m.name}`, m.params);
        if (bad) c.error(bad, m.span ?? impl.span);
      } else if (attr.name === "inline" && !isStdCollectionModule((m.span ?? impl.span)?.file)) {
        c.error(`'@inline' on '${typeName}.${m.name}': only the std collection modules may force inlining`, m.span ?? impl.span,
          `drop '@inline'; the optimizer inlines small functions on its own`);
      } else if (attr.name === "trackCaller" && !isStdCollectionModule((m.span ?? impl.span)?.file)) {
        c.error(`'@trackCaller' on '${typeName}.${m.name}': only the std collection modules may report their caller's location`, m.span ?? impl.span,
          `drop '@trackCaller'; a panic names the line it happens on`);
      } else if (TRACE_ATTRS.has(attr.name)) {
        const bad = traceAttrError(attr, "fn");
        if (bad) c.error(`'@${attr.name}' on '${typeName}.${m.name}': ${bad}`, m.span ?? impl.span);
      } else if (attr.args.length > 0 && attr.name !== "ordered") {
        c.error(`'@${attr.name}' takes no arguments`, m.span ?? impl.span,
          `write '@${attr.name}' on the line above 'fn ${m.name}'`);
      } else if ((attr.name === "copyOut" || attr.name === "ordered") && !(impl.typeParams && impl.typeParams.length > 0 && !impl.traitName)) {
        c.error(`'@${attr.name}' on '${typeName}.${m.name}': only a method of a generic inherent impl can be withheld per instantiation`, m.span ?? impl.span,
          impl.traitName ? `a trait impl's method set is fixed by the trait; move the copying method to 'impl ${typeName} { ... }'`
            : `'${typeName}' has no type parameters, so there is no instantiation to withhold it from`);
      } else if (attr.name === "ordered") {
        c.validateOrderedArgs(`${typeName}.${m.name}`, attr, impl.typeParams.map(t => t.name), m.span ?? impl.span);
      }
    }
  }

  // generic impl — store as template, instantiate per monomorphization. Trait impls
  // included: a generic trait impl with a body (e.g. `impl Drop for Foo<T>`) can't be
  // checked against the base name (not a concrete struct); deferring to per-mono means
  // the body is checked, and the trait registered (dropImpls etc.), against the real
  // mangled struct — see monomorphizeStruct, which preserves traitName when instantiating.
  if (impl.typeParams && impl.typeParams.length > 0) {
    const existing = c.genericImpls.get(typeName) || [];
    if (!existing.some(e => e.impl === impl)) {
      existing.push({ impl, program });
      c.genericImpls.set(typeName, existing);
    }
    return;
  }

  if (impl.traitName) {
    const trait = c.traits.get(impl.traitName);
    if (!trait) {
      c.error(`unknown trait '${impl.traitName}'`, impl.span);
      return;
    }

    // check for duplicate impl
    const existing = c.traitImpls.get(typeName) || [];
    if (existing.some(i => i.traitName === impl.traitName)) {
      c.error(`duplicate impl '${impl.traitName}' for '${typeName}'`, impl.span);
      return;
    }

    // Drop-specific validations
    if (impl.traitName === "Drop") {
      const builtins = ["string", "Vec", "Heap", "HashMap"];
      if (builtins.includes(typeName)) {
        c.error(`cannot impl Drop for built-in type '${typeName}'`, impl.span);
        return;
      }
      if (!c.structs.has(typeName) && !c.enums.has(typeName)) {
        c.error(`impl Drop requires a struct or enum type, got '${typeName}'`, impl.span);
        return;
      }
      c.dropImpls.add(typeName);
    }

    // check supertraits
    for (const sup of trait.supertraits) {
      if (!existing.some(i => i.traitName === sup)) {
        c.error(`impl '${impl.traitName}' for '${typeName}' requires impl '${sup}' for '${typeName}'`, impl.span);
      }
    }

    // validate all required methods are present
    const implMethodNames = new Set(impl.methods.map(m => m.name));
    for (const [mName, mInfo] of trait.methods) {
      if (!mInfo.hasDefault && !implMethodNames.has(mName)) {
        c.error(`impl '${impl.traitName}' for '${typeName}': missing required method '${mName}'`, impl.span);
      }
    }

    // register each method as a concrete function
    const methods = new Map<string, FnSig>();
    for (const m of impl.methods) {
      const traitMethod = trait.methods.get(m.name);
      if (!traitMethod) {
        c.error(`method '${m.name}' is not defined in trait '${impl.traitName}'`, impl.span);
        continue;
      }
      // A trait method with its OWN type parameters is a template, exactly as an inherent
      // one is. Keyed without the trait name so the call site — which knows only the
      // receiver type and the method name — can find it; two traits declaring the same
      // generic method on one type is the ambiguity `resolveMethod` already rejects, and
      // it is rejected here too rather than letting one silently win.
      if (m.typeParams && m.typeParams.length > 0) {
        const key = `${typeName}$${m.name}`;
        if (c.genericMethods.has(key)) {
          c.error(`ambiguous generic method '${m.name}' on '${typeName}' — implemented by more than one trait`, m.span ?? impl.span);
        } else {
          c.genericMethods.set(key, {
            decl: {
              ...m,
              name: `${typeName}$${impl.traitName}$${m.name}`,
              implTrait: impl.traitName,
              params: m.params.map(p => ({ name: p.name, type: c.substituteSelfInMiloType(declaredType(p), typeName) })),
              retType: c.substituteSelfInMiloType(m.retType, typeName),
            },
            owner: typeName,
          });
        }
        continue;
      }
      const mangled = `${typeName}$${impl.traitName}$${m.name}`;
      const concreteFn: Function = {
        ...m,
        name: mangled,
        implTrait: impl.traitName,
        params: m.params.map(p => ({ name: p.name, type: c.substituteSelfInMiloType(declaredType(p), typeName) })),
        retType: c.substituteSelfInMiloType(m.retType, typeName),
      };
      const params = concreteFn.params.map(p => ({ type: c.resolve(declaredType(p)), name: p.name }));
      const ret = c.resolve(concreteFn.retType);
      c.checkImplMethodSignature(impl, m, trait, traitMethod, params, ret);
      if (isUnsafeDecl(m)) c.unsafeMethods.add(mangled);
      c.functions.set(mangled, { params, ret, variadic: false, ...mustUseOf(m) });
      methods.set(m.name, { params, ret, variadic: false, ...mustUseOf(m) });
      c.monomorphizedFns.push(concreteFn);
      implFnsToCheck.push(concreteFn);
    }

    // register default methods that weren't overridden
    for (const [mName, mInfo] of trait.methods) {
      if (mInfo.hasDefault && !implMethodNames.has(mName)) {
        const traitDecl = program.traits.find(t => t.name === impl.traitName)!;
        const traitMethod = traitDecl.methods.find(m => m.name === mName)!;
        const mangled = `${typeName}$${impl.traitName}$${mName}`;
        const concreteFn: Function = {
          kind: "Function",
          name: mangled,
          implTrait: impl.traitName,
          typeParams: [],
          params: traitMethod.params.map(p => ({ name: p.name, type: c.substituteSelfInMiloType(declaredType(p), typeName) })),
          retType: c.substituteSelfInMiloType(traitMethod.retType, typeName),
          contracts: [],
          body: traitMethod.body!,
          isExtern: false,
          isVariadic: false,
        };
        const params = concreteFn.params.map(p => ({ type: c.resolve(declaredType(p)), name: p.name }));
        const ret = c.resolve(concreteFn.retType);
        c.functions.set(mangled, { params, ret, variadic: false });
        methods.set(mName, { params, ret, variadic: false });
        c.monomorphizedFns.push(concreteFn);
        implFnsToCheck.push(concreteFn);
      }
    }

    existing.push({ traitName: impl.traitName, typeName, methods });
    c.traitImpls.set(typeName, existing);
  } else {
    // inherent impl. A second impl block for the type (or the next method of a container
    // impl, which is instantiated on demand) merges into the first.
    const existing = c.inherentImpls.get(typeName);
    const methods = existing?.methods ?? new Map<string, FnSig>();
    for (const m of impl.methods) {
      const mangled = `${typeName}$${m.name}`;
      const concreteFn: Function = {
        ...m,
        name: mangled,
        params: m.params.map(p => ({ name: p.name, type: c.substituteSelfInMiloType(declaredType(p), typeName) })),
        retType: c.substituteSelfInMiloType(m.retType, typeName),
      };
      // A method with its own type parameters is a template, not a signature. Checking
      // its body here would type `R` as a struct nobody declared; the call site
      // instantiates it instead.
      if (isUnsafeDecl(m)) c.unsafeMethods.add(mangled);
      if (m.typeParams && m.typeParams.length > 0) {
        c.genericMethods.set(mangled, { decl: concreteFn, owner: typeName });
        continue;
      }
      const params = concreteFn.params.map(p => ({ type: c.resolve(declaredType(p)), name: p.name }));
      const ret = c.resolve(concreteFn.retType);
      if (m.attributes) c.sql.methodAttrs.set(mangled, m.attributes);
      // A method redefined in a later impl (the program's own over std's, which merges
      // first) wins with its body as well as its signature, as a redefined fn does: two
      // bodies under one symbol would reach the backend as a redefinition.
      const prior = methods.has(m.name) ? c.monomorphizedFns.findIndex(f => f.name === mangled) : -1;
      c.functions.set(mangled, { params, ret, variadic: false, ...mustUseOf(m) });
      methods.set(m.name, { params, ret, variadic: false, contracts: m.contracts, ...mustUseOf(m) });
      if (prior >= 0) c.monomorphizedFns[prior] = concreteFn;
      else c.monomorphizedFns.push(concreteFn);
      implFnsToCheck.push(concreteFn);
    }
    if (!existing) c.inherentImpls.set(typeName, { traitName: null, typeName, methods });
  }
}

// A global whose initializer runs code is initialized at its first read (codegen,
// src/lazy-globals.ts), so for those this order no longer decides anything at run time;
// what still runs in `program.globals` order is the initializers of globals nothing
// reads, before main. The direct-cycle error below holds for both: no order, lazy or
// not, can satisfy `let A = B + 1; let B = A + 1`.
//
// Historically all runtime initializers ran in this order, so a global that reads
// another had to sit after it. Source order does not guarantee that: the resolver
// appends the entry module's globals before walking its imports, so `let FRAG = HEAD +
// SKY_GLSL` built from an imported chunk read a zeroed string and silently produced a
// truncated shader. Sort by dependency instead — direct reads, plus reads inside
// functions the initializer calls — and keep source order among independent globals.
//
// Call edges are an over-approximation (a name-keyed call graph), so a cycle they
// introduce is not necessarily real: only a cycle in the direct global→global edges is
// reported. Anything else falls back to source order, which is what shipped before.
export function orderGlobalsByDependency(c: TypeChecker, program: Program) {
  // The sorted order lives here during the check; applyRewrites writes it back into `globalsHome`.
  c.globalsHome = program.globals;
  const globals = [...program.globals];
  c.globalsOrdered = globals;
  if (globals.length < 2) return;
  const index = new Map<string, number>();
  globals.forEach((g, i) => index.set(g.name, i));

  const scan = (node: unknown, reads: Set<string>, calls: Set<string>) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const c of node) scan(c, reads, calls); return; }
    const n = node as Record<string, any>;
    if (n.kind === "Ident" && typeof n.name === "string" && index.has(n.name)) reads.add(n.name);
    // `Name.thing(...)` is parsed as an enum/static call; it may be a read of a global
    // named `Name` (staticCallOnVariable rewrites it later) or a static method call.
    if (n.kind === "EnumLit" && typeof n.enumName === "string") {
      if (index.has(n.enumName)) reads.add(n.enumName);
      if (typeof n.variant === "string") calls.add(`${n.enumName}.${n.variant}`);
    }
    // `Call.func` is the callee's name. This read `n.callee`, which no Call has, so a
    // global initialized through a free fn (`var pool = arenaNew<Node>()`) never
    // learned that fn reads `nextArenaId`. A constant global is a static initializer
    // and its order never matters, but a global built by a call runs at startup in
    // list order, so the fn's reads have to count for the ordering pass.
    if (n.kind === "Call" && typeof n.func === "string") calls.add(n.func);
    if (n.kind === "MethodCall" && typeof n.method === "string") calls.add(n.method);
    for (const k in n) { if (k !== "span") scan(n[k], reads, calls); }
  };

  // Direct reads/calls of every callable, keyed by every name a call site could use.
  const bodies = new Map<string, { reads: Set<string>; calls: Set<string> }>();
  const record = (key: string, body: unknown) => {
    let e = bodies.get(key);
    if (!e) { e = { reads: new Set(), calls: new Set() }; bodies.set(key, e); }
    scan(body, e.reads, e.calls);
  };
  for (const f of program.functions) if (!f.isExtern) record(f.name, f.body);
  for (const im of program.impls) {
    for (const m of im.methods) { record(m.name, m.body); record(`${im.typeName}.${m.name}`, m.body); }
  }

  // Fixpoint: which globals a callable reads once its callees are folded in.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, e] of bodies) {
      for (const callee of e.calls) {
        const c = bodies.get(callee);
        if (!c) continue;
        for (const r of c.reads) if (!e.reads.has(r)) { e.reads.add(r); changed = true; }
      }
    }
  }

  const directDeps: Set<string>[] = [];
  const allDeps: Set<string>[] = [];
  for (const g of globals) {
    const reads = new Set<string>(), calls = new Set<string>();
    scan(g.value, reads, calls);
    reads.delete(g.name);
    directDeps.push(new Set(reads));
    const all = new Set(reads);
    for (const callee of calls) for (const r of bodies.get(callee)?.reads ?? []) if (r !== g.name) all.add(r);
    allDeps.push(all);
  }

  // Direct cycles are a real error — no order can satisfy them.
  const onDirectCycle = new Set<number>();
  const seen = new Array<number>(globals.length).fill(0); // 0 unvisited, 1 on stack, 2 done
  const walkDirect = (i: number): void => {
    if (seen[i] === 2) return;
    if (seen[i] === 1) { onDirectCycle.add(i); return; }
    seen[i] = 1;
    for (const d of directDeps[i]!) { const j = index.get(d); if (j !== undefined) walkDirect(j); }
    seen[i] = 2;
  };
  for (let i = 0; i < globals.length; i++) walkDirect(i);
  for (const i of onDirectCycle) {
    const g = globals[i]!;
    c.error(`global '${g.name}': initializer depends on itself through another global`, g.span,
      `each initializer needs the value the other one is still computing, so no order can satisfy them (a cycle through function calls is caught at run time, at the first read)`);
  }

  // Stable topological order: emit each global after everything it depends on,
  // visiting in source order so unrelated globals keep their original positions.
  const order: typeof globals = [];
  const state = new Array<number>(globals.length).fill(0);
  const visit = (i: number) => {
    if (state[i] !== 0) return; // done, or already on the stack (cycle → source order wins)
    state[i] = 1;
    for (const d of allDeps[i]!) { const j = index.get(d); if (j !== undefined && j !== i) visit(j); }
    state[i] = 2;
    order.push(globals[i]!);
  };
  for (let i = 0; i < globals.length; i++) visit(i);
  c.globalsOrdered = order;
}

// A generic struct literal checked against one concrete instance (`hint`, the
// monomorphized struct): from a binding's annotation, or from the literal's own
// `Pair<i64, string> { … }` type arguments.
// ── Field defaults ──
//
// A default is restricted to what needs nothing from the place a literal is written:
// literals (a leading `-` included), `[]`, `null`/`None`, enum variants and `Some`/
// `Ok`/`Err` of allowed values, a static call on a type (`Vec.new()`,
// `Duration.ms(500)`), a struct literal of allowed values, a cast of one, and an
// immutable Copy-typed global (`= DEFAULT_TIMEOUT_MS`). No locals, no `self`, no free
// fn calls: the default's AST is copied into every literal that omits the field, so
// anything that could resolve differently there (or move out of a global) is refused.
// The copy is evaluated at each literal, after the listed fields, in declaration order.
export function registerFieldDefaults(c: TypeChecker, program: Program) {
  for (const s of program.structs) {
    const typeParams = new Set(s.typeParams.map(t => t.name));
    for (const f of s.fields) {
      if (!f.default) continue;
      const why = c.defaultFormError(f.default, typeParams);
      if (why) {
        c.error(`default for field '${s.name}.${f.name}' ${why}`, f.default.span ?? s.span,
          `a default may be a literal, '[]', 'null', an enum variant, a static call on a type ('Vec.new()'), a struct literal of those, or an immutable Copy global; compute anything else in a constructor`);
        c.badDefaults.add(`${s.name}.${f.name}`);
        continue;
      }
      let m = c.structDefaults.get(s.name);
      if (!m) { m = new Map(); c.structDefaults.set(s.name, m); }
      m.set(f.name, f.default);
    }
  }
}

// Why `e` cannot be a field default, or null when it can.
export function defaultFormError(c: TypeChecker, e: Expr, typeParams: Set<string>): string | null {
  const sub = (xs: Expr[]) => { for (const x of xs) { const w = c.defaultFormError(x, typeParams); if (w) return w; } return null; };
  const namesParam = (ts: import("./ast").MiloType[] | undefined): boolean => (ts ?? []).some(t => typeParams.has(t.name) || namesParam(t.typeArgs));
  switch (e.kind) {
    case "IntLit": case "FloatLit": case "BoolLit": case "CharLit": return null;
    case "StringLit": return null;
    case "Ident": return null; // an immutable Copy global: checked with its type (checkFieldDefaultTypes)
    case "UnaryOp":
      return e.op === "-" && (e.operand.kind === "IntLit" || e.operand.kind === "FloatLit") ? null : `may not apply '${e.op}' to anything but a number literal`;
    case "ArrayLit": return sub(e.elements);
    case "FieldAccess": return floatNamespaceConst(e) ? null : "may not read a field";
    case "CastExpr": return namesParam([e.targetType]) ? "may not name a type parameter" : c.defaultFormError(e.operand, typeParams);
    case "EnumLit":
      if (typeParams.has(e.enumName) || namesParam(e.typeArgs)) return "may not name a type parameter";
      return sub(e.args);
    case "Call":
      if (e.func === "Some" || e.func === "Ok" || e.func === "Err") return sub(e.args);
      return `may not call '${e.func}'`;
    case "StructLit":
      if (e.base) return "may not use '..' struct update";
      if (typeParams.has(e.name) || namesParam(e.typeArgs)) return "may not name a type parameter";
      return sub(e.fields.map(f => f.value));
    default: return `may not be ${e.kind === "BinOp" ? "an arithmetic or comparison expression" : e.kind === "MethodCall" ? "a method call" : "this kind of expression"}`;
  }
}

// Type-check each non-generic struct's defaults once, at the declaration, against the
// field type: a struct no literal ever omits a field of still gets a wrong default
// reported. A generic's defaults depend on the instance and are checked per literal.
export function checkFieldDefaultTypes(c: TypeChecker, program: Program) {
  for (const s of program.structs) {
    if (s.typeParams.length > 0) continue;
    const info = c.structs.get(s.name);
    const defs = c.structDefaults.get(s.name);
    if (!info || !defs) continue;
    for (const [name, def] of defs) {
      const fieldDef = info.fields.find(d => d.name === name);
      if (!fieldDef || fieldDef.type.tag === "unknown") continue;
      const copy = structuredClone(def);
      if (!c.checkDefaultGlobals(copy, `${s.name}.${name}`)) { c.badDefaults.add(`${s.name}.${name}`); defs.delete(name); continue; }
      let t = c.checkExpr(copy, fieldDef.type);
      if (fieldDef.type.tag === "int" && t.tag === "int" && c.isConstIntExpr(copy)) t = fieldDef.type;
      if (!typeEq(fieldDef.type, t) && t.tag !== "unknown" && !c.tryInterfaceCoercion(copy, t, fieldDef.type)) {
        c.error(`default for field '${s.name}.${name}': expected ${c.show(fieldDef.type)}, got ${c.show(t)}`, def.span ?? s.span);
        c.badDefaults.add(`${s.name}.${name}`); defs.delete(name);
      }
    }
  }
}

// Every name a default reads must be an immutable global of a Copy type: a `var` could
// differ between literals, and a non-Copy global would be MOVED into each literal.
export function checkDefaultGlobals(c: TypeChecker, e: Expr, field: string): boolean {
  let ok = true;
  const walk = (x: Expr) => {
    if (x.kind === "Ident") {
      const info = c.globalScope?.get(x.name);
      if (!info) { c.error(`default for field '${field}' reads '${x.name}', which is not a module-level 'let'`, x.span); ok = false; }
      else if (info.mutable) { c.error(`default for field '${field}' reads '${x.name}', a 'var': a default must be the same at every literal`, x.span, `declare it with 'let'`); ok = false; }
      else if (!c.isCopyType(info.type)) { c.error(`default for field '${field}' reads '${x.name}', a ${c.show(info.type)}, which each literal would move out of the global`, x.span, `write the value itself, e.g. a string literal`); ok = false; }
      return;
    }
    for (const [k, v] of Object.entries(x) as [string, unknown][]) {
      if (Array.isArray(v)) for (const it of v) { if (it && typeof it === "object" && "kind" in it) walk(it as Expr); else if (it && typeof it === "object" && "value" in it) walk((it as { value: Expr }).value); }
      else if (v && typeof v === "object" && "kind" in (v as object) && k !== "targetType") walk(v as Expr);
    }
  };
  walk(e);
  return ok;
}
