// Whole-program driver: check entry points, the declaration pass (checkCore), pass ordering, result assembly.
import { TypeChecker } from "./checker";
import type { Expr, Function, Program, Span } from "./ast";
import { CheckAbort, applyWarningDefaults, cNameOf, importPathFrom, inModule, isStdCollectionModule, mustUseOf, rawPointerField, rawPointerVariant, rewritten } from "./checker-util";
import { applyRewrites } from "./apply-rewrites";
import { applyStringDecisions, moveFlow } from "./move-flow";
import { reportBorrowFlow } from "./borrow-flow";
import { declaredType, simpleType } from "./ast";
import { basename, resolve as resolvePath, sep } from "path";
import { display, displayQualified } from "./mangle";
import type { TypeKind } from "./types";
import { NEVER_TYPE, typeEq, typeFromAst } from "./types";
import { validateSqlAttribute } from "./checker-sql";
import { TRACE_ATTRS, traceAttrError } from "./trace-attrs";
import { recordsAttrErrors, replaySite } from "./replay-externs";
import { attributesFor } from "./attributes";
import { must } from "./must";
import { checkPurity } from "./checker-purity-host";
import { checkConcurrentClosureArgs, checkEscapingClosures, checkGlobalBorrowInvalidation, checkTaskScopes, checkThreadBoundary, lazyInitFnName } from "./checker-program-passes";
import { checkPlainClosureEnv } from "./checker-closure-env";
import { checkNonEscapingParams } from "./checker-nonescaping-host";
import { checkPointerParamEscape } from "./checker-pointer-escape-host";
import { checkMutParamBundle } from "./checker-mut-bundle-host";
import { checkMutability } from "./checker-mutability-host";
import { checkVisibility } from "./visibility";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import { STDLIB_DIR } from "./stdlibBundle";
import type { CheckResult, InterfaceMethodInfo, TraitMethodInfo } from "./checker";

export function flushSqlErrors(c: TypeChecker): void {
  for (const e of c.sql.errors) c.error(e.msg, e.span, e.hint);
  c.sql.errors = [];
}

/** @consumesThis */
export function check(c: TypeChecker, program: Program): CheckResult {
  // Not in the constructor: a constructor body is `this.f = e` only, so the generated Milo can build it.
  applyWarningDefaults(c.warningConfig);
  // Outermost `fatal()` boundary. Everything below has a finer one, so reaching
  // here means a fatal fired in a pass that has no per-item recovery (a
  // registration sweep, a whole-program lint). The diagnostic is already
  // recorded, so the caller still gets a real error instead of a stack trace —
  // which matters most in the LSP, where the checker runs on half-typed code
  // and an escaped throw means the file shows no diagnostics at all.
  try {
    c.checkCore(program);
    // The only place the recorded rewrites reach the tree: the passes below read the finished shape.
    applyRewrites(c);
    c.checkPasses(program);
    c.finishChecks();
  } catch (e) {
    if (!(e instanceof CheckAbort)) throw e;
  }
  // A CheckAbort in the core leaves the rewrites unapplied; a second call is a no-op.
  applyRewrites(c);
  if (c.reportStringClones) c.printStringClones();
  const result = c.buildResult();
  // Moves are decided by the dataflow pass (src/move-flow.ts, docs/plans/move-dataflow.md): its
  // use-after-move errors are the checker's, and on a program without errors its string decisions
  // (move or share) are what codegen reads. Before the qualified-name rewrite below, which they need too.
  const flow = moveFlow(program, result, c);
  for (const d of flow.diagnostics) c.error(d.message, d.span, d.hint);
  // Borrow conflicts are decided by the dataflow pass too: its errors are the checker's, the walk's copies are dropped.
  reportBorrowFlow(program, result, c);
  if (!c.diagnostics.some(d => d.severity === "error")) applyStringDecisions(result, flow);
  if (c._displayNames !== undefined && c._displayNames.size > 0) {
    // The file a renamed symbol came from, when exactly one file declared it.
    const origins = new Map<string, string>();
    for (const sym of c._displayNames.keys()) {
      const declaredType = c.declOrigin("types", sym);
      const declaredValue = c.declOrigin("values", sym);
      const files = declaredType !== undefined ? declaredType.files : declaredValue?.files;
      if (files !== undefined && files.size === 1) origins.set(sym, basename([...files][0]));
    }
    for (const d of c.diagnostics) {
      d.message = displayQualified(c._displayNames, d.message, origins);
      const hint = d.hint;
      if (hint) d.hint = displayQualified(c._displayNames, hint, origins);
    }
  }
  return result;
}

export function buildResult(c: TypeChecker): CheckResult {
  return {
    diagnostics: c.diagnostics,
    exprTypes: c.exprTypes,
    patternBindingTypes: c.patternBindingTypes,
    nullRefUnwraps: c.nullRefUnwraps,
    autoBorrowed: c.autoBorrowed,
    matchSubjectRef: c.matchSubjectRef,
    matchSubjectMut: c.matchSubjectMut,
    rewrittenCalls: c.rewrittenCalls,
    replaySites: c.replaySites,
    replayRawShares: c.replayRawShares,
    rewrittenEnums: c.rewrittenEnums,
    variantTagCompares: c.variantTagCompares,
    staticCalls: c.staticCalls,
    rewrittenStructLits: c.rewrittenStructLits,
    movedExprs: c.movedExprs,
    movePositions: c.moveRequested,
    borrowedExprs: c.borrowedExprs,
    sharedStringExprs: c.sharedStringExprs,
    sharedStringCaptures: c.sharedStringCaptures,
    keyExtractorClosures: c.keyExtractorClosures,
    autoWrappedOption: c.autoWrappedOption,
    arrayToVecCoercions: c.arrayToVecCoercions,
    arrayRepeatClones: c.arrayRepeatClones,
    functions: c.functions,
    genericFnNames: new Set(c.genericFns.keys()),
    structs: c.structs,
    enums: c.enums,
    dropImpls: c.dropImpls,
    monomorphizedFns: c.monomorphizedFns,
    monomorphizedEnums: c.monomorphizedDecls,
    monomorphizedStructs: c.monomorphizedStructDecls,
    closureCaptures: c.closureCaptures,
    closureCalls: c.closureCalls,
    cfnCalls: c.cfnCalls,
    resolvedMethods: c.resolvedMethods,
    heapMethodReceivers: c.heapMethodReceivers,
    resolvedOperators: c.resolvedOperators,
    fnFieldCalls: c.fnFieldCalls,
    cfnFieldCalls: c.cfnFieldCalls,
    propagateConversions: c.propagateConversions,
    propagateMessages: c.propagateMessages,
    propagateBoxings: c.propagateBoxings,
    contextBoxings: c.contextBoxings,
    rangeCheckedExprs: c.rangeCheckedExprs,
    sizeOfTypes: c.sizeOfTypes,
    cSigs: c.cSigs,
    cValues: c.cValues,
    offsetOfFields: c.offsetOfFields,
    interfaces: c.interfaces,
    interfaceCoercions: c.interfaceCoercions,
    interfaceMethodCalls: c.interfaceMethodCalls,
    autoJsonStringify: c.autoJsonStringify,
    arraySliceArgs: c.arraySliceArgs,
    autoJsonToJson: c.autoJsonToJson,
    anonStructs: c.anonStructs,
    globalTypes: c._globalTypes,
    nonConstGlobals: c._nonConstGlobals,
    iteratorForIns: c.iteratorForIns,
    stringViewForIns: c.stringViewForIns,
    iterDelegates: c.iterDelegates,
    consumingForIns: c.consumingForIns,
    viewLets: c.viewLets,
    refLets: c.refLets,
    forInBindingTypes: c.forInBindingTypes,
    rewrites: c.rewrites,
    patternRewrites: c.patternRewrites,
  };
}

// Registration and every expression check. Records rewrites, never writes the AST.
export function checkCore(c: TypeChecker, program: Program): void {
  c._userFnNames = program.userFnNames;
  c.replayPlans = program.replayPlans;
  for (const fn of program.droppedExterns ?? []) c.checkVariadicExtern(fn);
  c.declOrigins = program.declOrigins;
  c.entryFile = program.entryFile;
  for (const u of program.unusedImports ?? []) {
    c.warn("unused-import",
      `'${u.name}' is imported from '${u.path}' but never used`,
      u.span,
      `remove it from the import list — unless the import exists to force '${u.path}' to link, which this lint cannot see`);
  }
  for (const s of program.shadowedStdlib ?? []) {
    c.warn("shadows-stdlib-override",
      `'fn ${s.name}' shadows a standard-library function of the same name and signature`,
      s.span,
      `the standard library defines '${s.name}' in '${s.stdlibFile}'. The signatures match, so this compiles — but Milo's flat namespace makes this definition win everywhere, including the library's own internal calls to '${s.name}', which now run this body. Rename it, or pass --allow=shadows-stdlib-override if the override is deliberate`);
  }
  c._userImplKeys = program.userImplKeys;
  c._packageNames = program.packageNames;
  c._displayNames = program.displayNames;
  // register built-in functions
  const ptrU8: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
  const i32t: TypeKind = { tag: "int", bits: 32, signed: true };
  // print/format accept any number of Display-formattable args (handled in codegen).
  // No required param — variadic-from-zero. Type-driven formatting per arg.
  c.functions.set("print", { params: [], ret: { tag: "void" }, variadic: true });
  c.functions.set("eprint", { params: [], ret: { tag: "void" }, variadic: true });
  c.functions.set("format", { params: [], ret: { tag: "string" }, variadic: true });
  c.functions.set("flush", { params: [], ret: { tag: "void" }, variadic: false });
  c.functions.set("exit", { params: [{ type: i32t, name: "code" }], ret: NEVER_TYPE, variadic: false });
  c.functions.set("_miloArgCount", { params: [], ret: { tag: "int", bits: 64, signed: true }, variadic: false });
  c.functions.set("_miloArgAt", { params: [{ type: { tag: "int", bits: 64, signed: true }, name: "index" }], ret: { tag: "string" }, variadic: false });
  c.functions.set("_cstrToString", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "string" }, variadic: false });
  // Same copy, but with an explicit length instead of strlen: NUL-safe, so it can
  // carry arbitrary file bytes. `readAll` used to append the buffer a byte at a
  // time, which cost more than the read itself on any large file.
  c.functions.set("_bytesToString", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }, { type: { tag: "int", bits: 64, signed: true }, name: "len" }], ret: { tag: "string" }, variadic: false });
  c.functions.set("_strDataPtr", { params: [{ type: { tag: "ref", inner: { tag: "string" }, mutable: false }, name: "s" }], ret: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, variadic: false });
  // One byte onto stdout's stdio buffer. `putChar` used to write(2) per byte, which
  // is a syscall each and also raced ahead of `print`'s buffered output.
  c.functions.set("_putByte", { params: [{ type: { tag: "int", bits: 8, signed: false }, name: "b" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("_loadU8", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 8, signed: false }, variadic: false });
  c.functions.set("_loadI32", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "ptr" }], ret: { tag: "int", bits: 32, signed: true }, variadic: false });
  c.functions.set("_callClosureVoid", { params: [{ type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "fn" }, { type: { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } }, name: "env" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("assert", { params: [{ type: { tag: "bool" }, name: "cond" }], ret: { tag: "void" }, variadic: true });
  // `todo()` / `todo("why")`: a body that is not written yet. Aborts at runtime naming
  // the function and site, and counts as diverging, so a skeleton of signatures and
  // contracts type-checks (and proves, where the contracts allow) before any body
  // exists. Variadic so the message is optional.
  c.functions.set("todo", { params: [], ret: { tag: "void" }, variadic: true });
  c.functions.set("max", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
  c.functions.set("min", { params: [{ type: i32t, name: "a" }, { type: i32t, name: "b" }], ret: i32t, variadic: false });
  // Atomic intrinsics — ptr arg is *u8, codegen emits LLVM atomic instructions
  const i64t: TypeKind = { tag: "int", bits: 64, signed: true };
  c.functions.set("_atomicLoadI64", { params: [{ type: ptrU8, name: "ptr" }], ret: i64t, variadic: false });
  c.functions.set("_atomicStoreI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("_atomicAddI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
  c.functions.set("_atomicSubI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
  c.functions.set("_atomicSwapI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "val" }], ret: i64t, variadic: false });
  c.functions.set("_atomicCasI64", { params: [{ type: ptrU8, name: "ptr" }, { type: i64t, name: "expected" }, { type: i64t, name: "desired" }], ret: i64t, variadic: false });
  c.functions.set("_atomicLoadI32", { params: [{ type: ptrU8, name: "ptr" }], ret: i32t, variadic: false });
  c.functions.set("_atomicStoreI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("_atomicAddI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
  c.functions.set("_atomicSubI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
  c.functions.set("_atomicSwapI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "val" }], ret: i32t, variadic: false });
  c.functions.set("_atomicCasI32", { params: [{ type: ptrU8, name: "ptr" }, { type: i32t, name: "expected" }, { type: i32t, name: "desired" }], ret: i32t, variadic: false });
  c.functions.set("_atomicLoadBool", { params: [{ type: ptrU8, name: "ptr" }], ret: { tag: "bool" }, variadic: false });
  c.functions.set("_atomicStoreBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("_atomicSwapBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "val" }], ret: { tag: "bool" }, variadic: false });
  c.functions.set("_atomicCasBool", { params: [{ type: ptrU8, name: "ptr" }, { type: { tag: "bool" }, name: "expected" }, { type: { tag: "bool" }, name: "desired" }], ret: { tag: "bool" }, variadic: false });
  // Scheduler global access — green thread runtime
  c.functions.set("_schedulerGet", { params: [], ret: ptrU8, variadic: false });
  c.functions.set("_schedulerSet", { params: [{ type: ptrU8, name: "ptr" }], ret: { tag: "void" }, variadic: false });
  c.functions.set("_panicHookSet", { params: [{ type: ptrU8, name: "fnPtr" }], ret: { tag: "void" }, variadic: false });

  // A user fn with a builtin's name (std/testing's `assert`) wins everywhere in the
  // flat namespace, so an unrelated file's builtin call binds to it without ever
  // importing it. The visibility pass exempts these: the call was written against the
  // builtin, and only the redeclaration diagnostics have anything to say about it.
  // `Heap` is a builtin type, so the prelude naming Heap<Error> is not an import of a
  // user struct that happens to share the name (tests/fixtures/genericStruct.milo).
  c.builtinFnNames = new Set([...c.functions.keys(), "Option", "Result", "Heap"]);
  // Safe code can hold a raw pointer (`0 as *u8`, `Channel.rawPtr()`), so a pointer
  // consumer callable without `unsafe` is an unchecked dereference. Every way to USE a
  // pointer has to need unsafe for a safe fn that only returns one to be sound. std is
  // exempt: it calls these on its own fields (AtomicI64._ptr) in ~70 places, and what
  // keeps a caller from steering one is tests/stdRawPointerApi.test.ts, which holds
  // every safe pub std fn to taking no raw pointer.
  for (const name of c.functions.keys()) {
    const builtin = c.functions.get(name);
    if (builtin && builtin.params.some(p => p.type.tag === "ptr")) c.rawPtrBuiltinNames.add(name);
  }
  c.registerBuiltinTraits();
  c.registerBuiltinOption();
  c.registerBuiltinResult();

  // register type aliases
  for (const ta of program.typeAliases) {
    c.typeAliases.set(ta.name, ta.type);
    if (ta.typeParams?.length) {
      c.aliasTypeParams.set(ta.name, ta.typeParams.map(tp => tp.name));
      for (const tp of ta.typeParams) {
        if (tp.bounds.length > 0) {
          // A bound constrains the uses of a type parameter inside a body. An alias has
          // no body of its own — it is textually replaced — so there is nothing here for
          // a bound to constrain, and honouring the syntax silently would promise a
          // check that never runs.
          c.error(`type alias '${ta.name}': type parameter '${tp.name}' cannot carry a bound`, ta.span,
            `an alias is expanded at each use, so a bound here would never be checked — put the bound on the function or struct that uses the alias`);
        }
      }
    }
  }

  // pre-register enum names so struct fields can reference enum types
  for (const e of program.enums) {
    if (e.typeParams.length === 0) {
      c.enums.set(e.name, { variants: new Map() });
    }
  }

  // Pre-register interface names so struct fields (e.g. `Heap<Shape>`) resolve
  // their inner to an interface rather than defaulting to a struct. Full method
  // registration happens later and overwrites these placeholders.
  for (const iface of program.interfaces) {
    if (!c.interfaces.has(iface.name)) {
      c.interfaces.set(iface.name, { name: iface.name, methods: new Map() });
    }
  }

  c.reportUnknownTypeNames(program);

  c.registerFieldDefaults(program);

  // register structs — two passes so generic structs are available when resolving fields
  for (const s of program.structs) {
    if (s.typeParams.length > 0) {
      const fields = s.fields.map(f => ({ name: f.name, type: typeFromAst(f.type) }));
      c.genericStructs.set(s.name, { typeParams: s.typeParams.map(tp => tp.name), fields, decl: s });
    }
  }

  // pre-register generic impls so struct fields like Channel<string> trigger full monomorphization.
  // `impl Drop for S<T>` belongs here too: a signature naming `S<X>` (`fn f(c: &Channel<Res>)`)
  // monomorphizes S<X> before registerImpl stores the Drop template, and that instance then
  // never ran its Drop at all (Channel<Res> leaked every queued payload). A missing Drop is
  // silent; any other missing trait method is a loud "no method" error, so only Drop is listed.
  for (const impl of program.impls) {
    if (impl.typeParams && impl.typeParams.length > 0 && (!impl.traitName || impl.traitName === "Drop")) {
      const existing = c.genericImpls.get(impl.typeName) || [];
      existing.push({ impl, program });
      c.genericImpls.set(impl.typeName, existing);
    }
  }
  // Drop-ness has to be known before the FIRST monomorphization, which a struct field
  // (`struct S { pool: Arena<Res> }`) triggers below: a `@copyOut` method is kept or
  // dropped from that instantiation by asking resourceKind(Res) right then, and an
  // answer from an empty dropImpls would keep `Arena<Res>.get`. The later registration
  // (before derive synthesis) validates; this one only pre-fills the same Set.
  const declaredTypeNames = new Set([...program.structs.map(s => s.name), ...program.enums.map(e => e.name)]);
  for (const impl of program.impls) {
    if (impl.traitName === "Drop" && declaredTypeNames.has(impl.typeName)) c.dropImpls.add(impl.typeName);
  }

  for (const s of program.structs) {
    if (s.typeParams.length === 0) {
      const fields = s.fields.map(f => ({
        name: f.name, type: c.thinFnField(s.isExtern, c.resolve(f.type)),
        ...(f.attributes?.some(a => a.name === "cOpaque") ? { cOpaque: true } : {}),
        ...cNameOf(f),
        ...(f.attributes?.some(a => a.name === "iter") ? { iterDelegate: true } : {}),
      }));
      // A rejected field type is poisoned to `unknown`, so every construction and read
      // of the field does not report the same mistake again as a type mismatch.
      fields.forEach((f, i) => {
        const fsp = s.fields[i]?.type.span;
        if (f.type.tag === "ref") {
          c.error(`struct '${s.name}' field '${f.name}': references cannot be stored in structs`, fsp, `references are second-class — use an owned type instead`);
          f.type = { tag: "unknown" };
        } else if (c.nestedRef(f.type)) {
          c.error(`struct '${s.name}' field '${f.name}': references cannot be stored in a collection`, fsp, `references are second-class — store owned values instead`);
          f.type = { tag: "unknown" };
        }
      });
      const copy = s.attributes?.some(a => a.name === "copy") ?? false;
      const pointerField = copy ? undefined : rawPointerField(fields);
      c.structs.set(s.name, {
        fields, isExtern: s.isExtern, isOpaque: s.isOpaque,
        ...(s.span?.file && { file: s.span.file }),
        ...(s.attributes?.some(a => a.name === "noCopy") ? { noCopy: true } : {}),
        ...(copy ? { copy: true } : {}),
        ...(pointerField ? { pointerField } : {}),
      });
    }
  }

  // Reject a struct that embeds itself by value (directly or through other by-value
  // structs / fixed arrays) — it has infinite size and can't be laid out, yet used
  // to compile and produce a broken type. What counts as "by value" is `embedsSelf`.
  // Generic declarations are skipped here and rejected per instantiation at the end
  // of this function, because `A<T> { me: A<T> }` has no layout to walk until T is
  // chosen.
  for (const s of program.structs) {
    if (s.typeParams.length > 0) continue;
    if (c.embedsSelf(s.name, new Set())) {
      c.error(`struct '${s.name}' is recursive by value and has infinite size`, s.span,
        `a struct cannot contain itself by value — put the recursive field behind an indirection (e.g. 'Heap<${s.name}>' or 'Vec<${s.name}>')`);
    }
  }

  // validate extern-struct fields once all structs are registered (nested extern
  // structs may be declared in any order). Non-extern structs are unrestricted.
  for (const s of program.structs) {
    if (s.typeParams.length > 0 || !s.isExtern || s.isOpaque) continue;
    const info = c.structs.get(s.name);
    if (!info) continue;
    for (const f of info.fields) {
      if (!c.isValidExternStructField(f.type)) {
        c.error(`extern struct '${s.name}' field '${f.name}': type '${c.show(f.type)}' is not C-representable`, undefined,
          `extern-struct fields must be scalars, pointers, C function pointers ('(A, B) => R'), nested extern structs, or fixed arrays of those`);
      }
    }
  }

  // Struct invariants name the struct's own fields directly (`chr.len > 0`), so they are
  // checked in a scope holding exactly those fields. Nothing else is visible: an invariant
  // reaching for a global or a caller's local would be a claim the type cannot maintain
  // on its own, which is the only thing that makes it assumable at every use site.
  for (const s of program.structs) {
    if (!s.invariants?.length) continue;
    // Generic structs are allowed: an invariant is discharged against the generic
    // declaration, before monomorphization, so one clause covers every instantiation. A
    // clause that reaches into a field of type-parameter type simply won't typecheck.
    const info = c.structs.get(s.name);
    if (!info) continue;
    c.pushScope();
    for (const f of info.fields) {
      c.declare(f.name, { type: f.type, mutable: false, borrowed: false, read: true });
    }
    for (const inv of s.invariants) {
      if (inv.kind !== "invariant") {
        c.error(`a struct takes only 'invariant' clauses, not '${inv.kind}'`, inv.span);
        continue;
      }
      c.checkContractClause(inv);
    }
    c.popScope();
  }

  for (const s of program.structs) {
    c.validateAttributes(s.name, s.attributes, "struct");
    c.validateFieldAttributes(s);
    c.warnUnverifiedExtern(s);
    if (s.attributes) {
      for (const attr of s.attributes) {
        if (attr.name === "cLayout") c.checkCLayout(s, attr);
        if (attr.name === "noCopy" && attr.args && attr.args.length > 0) {
          c.error(`'@noCopy' on '${s.name}' takes no arguments`, s.span,
            `write '@noCopy' on its own line above the struct`);
        }
        if (attr.name === "copy") c.validateCopyAttr(s, attr, program);
        if (attr.name === "copyOnly") c.validateCopyOnly(s.name, attr, s.typeParams.map(t => t.name), s.span);
      }
    }
  }
  for (const e of program.enums) {
    c.validateAttributes(e.name, e.attributes, "enum");
    for (const attr of e.attributes ?? []) if (attr.name === "copy") c.validateEnumCopyAttr(e, attr, program);
  }

  // Option and Result are compiler builtins with dedicated syntax (`T?`, `!`, `??`,
  // `?`-propagation) that a redeclaration does not rebind, and prelude signatures
  // already name them. Overriding one used to be allowed and merely broke the
  // prelude three files away; say so at the declaration instead.
  // By the written name: a per-module rename (src/mangle.ts) does not make it another type.
  for (const e of program.enums) {
    const written = display(c._displayNames, e.name);
    if (written === "Option" || written === "Result") {
      c.error(`'${written}' is a builtin enum and cannot be redeclared`, e.span,
        `it already has the shape you are writing — delete this declaration, or rename it if you meant a different type`);
    }
  }

  // register enums — two passes so generic enums are available when resolving variant fields
  for (const e of program.enums) {
    if (e.typeParams.length > 0) {
      if (e.reprType) {
        c.error(`integer-repr enum '${e.name}' cannot be generic`, e.span,
          `remove the type parameters or remove ': ${e.reprType}'`);
        if (e.reprType !== "i32") {
          c.error(`enum '${e.name}' has unsupported representation '${e.reprType}'`, e.span,
            `integer-repr enums currently require ': i32'`);
        }
      }
      const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
      e.variants.forEach((v, i) => {
        variants.set(v.name, { tag: i, fields: v.fields.map(f => typeFromAst(f)) });
      });
      c.genericEnums.set(e.name, { typeParams: e.typeParams.map(tp => tp.name), variants, decl: e });
    }
  }
  for (const e of program.enums) {
    if (e.typeParams.length === 0) {
      // user-declared non-generic enum overrides any built-in generic of the same name
      c.genericEnums.delete(e.name);
      // pre-register so self-referential fields (Heap<Self>) resolve correctly
      c.enums.set(e.name, { variants: new Map() });
      const variants = new Map<string, { tag: number; fields: TypeKind[] }>();
      // A repr'd enum's tag IS its integer value: explicit `= N`, else previous + 1 from 0.
      // Sparse/non-contiguous is allowed and expected (that is why tryFrom is generated).
      let nextDisc = 0;
      const usedDiscs = new Map<number, string>();
      if (e.reprType && e.reprType !== "i32") {
        c.error(`enum '${e.name}' has unsupported representation '${e.reprType}'`, e.span,
          `integer-repr enums currently require ': i32'`);
      }
      e.variants.forEach((v, i) => {
        const fields = v.fields.map(f => c.resolve(f));
        for (const field of fields) {
          if (field.tag === "enum" && field.name === e.name) {
            c.error(`enum '${e.name}' has infinite size due to recursive field`, undefined,
              `wrap the recursive field in Heap<${e.name}> for heap allocation`);
          }
        }
        let tag = i;
        if (e.reprType) {
          if (fields.length > 0) {
            c.error(`variant '${v.name}' of repr'd enum '${e.name}' cannot carry a payload`, e.span,
              `an 'enum ... : ${e.reprType}' is a C-like enum; drop the '(...)' or drop the ': ${e.reprType}'`);
          }
          tag = v.discriminant ?? nextDisc;
          if (!Number.isInteger(tag) || tag < -2147483648 || tag > 2147483647) {
            c.error(`discriminant ${tag} is out of range for i32 in enum '${e.name}'`, e.span);
          }
          const clash = usedDiscs.get(tag);
          if (clash) c.error(`discriminant ${tag} is used by both '${clash}' and '${v.name}' in enum '${e.name}'`, e.span);
          usedDiscs.set(tag, v.name);
          nextDisc = tag + 1;
        }
        variants.set(v.name, { tag, fields });
      });
      const copy = e.attributes?.some(a => a.name === "copy") ?? false;
      const pointerVariant = copy ? undefined : rawPointerVariant(variants);
      c.enums.set(e.name, { variants, ...(e.reprType && { reprType: e.reprType }), ...(pointerVariant && { pointerVariant }) });
    }
  }

  // The indirect case: an enum whose payload reaches back to it through a struct (or
  // another enum) by value. The direct case above keeps its message; this one names
  // the cycle's other member.
  for (const e of program.enums) {
    if (e.typeParams.length > 0) continue;
    const info = c.enums.get(e.name);
    if (!info) continue;
    const direct = [...info.variants.values()].some(v => v.fields.some(f => f.tag === "enum" && f.name === e.name));
    if (!direct && c.embedsSelf(e.name, new Set())) {
      c.error(`enum '${e.name}' is recursive by value and has infinite size`, e.span,
        `a variant payload is stored inline, so a payload that contains '${e.name}' again (through a struct or another enum) has no layout; put it behind 'Heap<...>'`);
    }
  }

  // register interfaces (before functions so &Interface params resolve correctly)
  for (const iface of program.interfaces) {
    const methods = new Map<string, InterfaceMethodInfo>();
    for (const m of iface.methods) {
      if (m.body !== null) {
        c.error(`interface methods cannot have default bodies`, m.span);
      }
      const params = m.params.map(p => ({ name: p.name, type: c.resolve(declaredType(p)) }));
      const selfParam = params[0];
      if (!selfParam || selfParam.type.tag !== "ref") {
        c.error(`interface method '${m.name}' must take self by reference (&Self or &mut Self)`, m.span);
      }
      const ret = c.resolve(m.retType);
      methods.set(m.name, { params, ret });
    }
    c.interfaces.set(iface.name, { name: iface.name, methods });
  }

  // register traits (user-defined override built-ins)
  for (const t of program.traits) {
    for (const sup of t.supertraits) {
      if (!c.traits.has(sup)) {
        c.error(`supertrait '${sup}' not found`, t.span);
      }
    }
    const methods = new Map<string, TraitMethodInfo>();
    for (const m of t.methods) {
      const params = m.params.map(p => ({ name: p.name, type: c.resolve(declaredType(p)) }));
      const ret = c.resolve(m.retType);
      methods.set(m.name, { params, ret, hasDefault: m.body !== null, decl: m });
    }
    c.traits.set(t.name, { name: t.name, supertraits: t.supertraits, methods });
  }

  // register functions
  for (const fn of program.functions) {
    if (fn.attributes) {
      for (const attr of fn.attributes) {
        if (attr.name === "cSig") c.checkCSig(fn, attr);
        // @externalLinkage forces external linkage — see lower.ts. Needed when the
        // only caller is a dlopen'd library resolving against this executable, which
        // no reachability analysis can see.
        else if (attr.name === "externalLinkage") {
          if (fn.isExtern) {
            c.error(`'@externalLinkage' on extern fn '${fn.name}' — extern declares a function defined elsewhere, so there is no definition here to give linkage to`, undefined,
              `drop '@externalLinkage', or remove 'extern' if you meant to define it`);
          }
          // Legal, and occasionally exactly right: a fn nothing in Milo references,
          // resolved only by a dlopen'd library against this executable. So a warning,
          // never an error. But the pairing is more often a slip — the author wanted
          // "visible from outside" and reached for the linkage attribute instead of
          // `pub`, or had both and dropped the `pub`. The two live in unrelated domains
          // (module graph vs C linker) and nothing else flags them disagreeing.
          else if (!fn.isPub && c.currentFnIsUser) {
            c.warn("external-linkage-not-pub", `'@externalLinkage' on non-pub fn '${fn.name}'`, fn.span,
              `'@externalLinkage' is a C-linker concern and does not make '${fn.name}' importable from Milo — add 'pub' if that is what you meant, and keep both if a dlopen'd library resolves this symbol`);
          }
        }
        else if (attr.name === "link") {
          if (!fn.isExtern) {
            c.error(`'@link' on '${fn.name}': only an 'extern fn' links against a native library`, undefined,
              `put @link on an extern declaration`);
          }
          if (attr.args.length === 0) {
            c.error(`'@link' needs a library name, e.g. @link("SDL2")`, undefined,
              `the argument is the -l name, so @link("SDL2") links -lSDL2`);
          }
          attr.argKinds?.forEach((k, i) => {
            if (k !== "string") {
              c.error(`'@link' argument must be a string library name, got '${attr.args[i]}'`, undefined,
                `write @link("SDL2"), not @link(SDL2)`);
              return;
            }
            // The name is pasted into the link command the compiler shells out to, so it
            // is held to a charset that cannot close the argument and inject a command —
            // the same reason @cLayout/@cSig constrain their arguments. `milo pkg add` fetches
            // third-party source, and building a package must not be able to run one.
            const name = attr.args[i]!;
            if (!TypeChecker.LINK_NAME_RE.test(name)) {
              c.error(`'@link' argument '${name}' is not a library name`, undefined,
                `expected the '-l' name (letters, digits, '_', '.', '+', '-'), optionally 'framework:Name' for a darwin framework`);
            }
          });
        }
        // @wrapping makes the routine's + - * -x, div INT_MIN/-1, and over-shifts use
        // defined modular arithmetic (two's-complement wrap / masked shift) instead of
        // trapping. It is a correctness dial only: div-by-zero, bounds, and ranged
        // checks still trap, and `as` conversions are unchanged.
        else if (attr.name === "wrapping") {
          if (fn.isExtern) {
            c.error(`'@wrapping' on extern fn '${fn.name}' — an extern is defined elsewhere, so there is no arithmetic here to make modular`, undefined,
              `drop '@wrapping'`);
          }
          if (attr.args.length > 0) {
            c.error(`'@wrapping' takes no arguments`, undefined,
              `write '@wrapping fn ${fn.name}(...)'`);
          }
        }
        // @pure declares the function has no effect the signature doesn't already show:
        // it reads and writes only its parameters and its own locals. On a Milo body that
        // is checked (see checkPurity); on an `extern` it is an assertion, because there
        // is no body here to inspect — the same trust hole every effect system has at the
        // FFI boundary.
        else if (attr.name === "pure") {
          if (attr.args.length > 0) {
            c.error(`'@pure' takes no arguments`, undefined, `write '@pure fn ${fn.name}(...)'`);
          }
        }
        else if (attr.name === "sql" || attr.name === "sqlSchema") {
          const bad = validateSqlAttribute(attr, fn.name, fn.params);
          if (bad) c.error(bad, fn.span);
        }
        else if (attr.name === "copyOnly") c.validateCopyOnly(fn.name, attr, fn.typeParams.map(t => t.name), undefined);
        // Bare only: it constrains every type parameter, since the copy is of whatever
        // the container holds and a routine copying out one parameter and not another
        // has not come up. On a concrete fn it would be a claim about nothing.
        else if (attr.name === "copyOut" || attr.name === "ordered") {
          const a = attr.name;
          if (a === "copyOut" && attr.args.length > 0) c.error(`'@copyOut' takes no arguments`, undefined, `write '@copyOut fn ${fn.name}<...>(...)'`);
          if (a === "ordered") c.validateOrderedArgs(fn.name, attr, fn.typeParams.map(t => t.name), undefined);
          if (fn.typeParams.length === 0) {
            c.error(`'@${a}' on '${fn.name}': it has no type parameters to constrain`, undefined,
              a === "copyOut"
                ? `'@copyOut' withholds a generic from a type argument that carries Drop or @noCopy; a concrete fn has none, so drop the attribute`
                : `'@ordered' withholds a generic from a type argument that has no '<'; a concrete fn has none, so drop the attribute`);
          }
        }
        // @thread marks a fn that hands a closure param to a real OS thread. It is the
        // single source of truth for where a data race can enter a program — see
        // checkThreadBoundary, which reads this rather than hardcoding entry points.
        else if (attr.name === "thread") {
          if (attr.args.length > 0) {
            c.error(`'@thread' takes no arguments`, undefined, `write '@thread fn ${fn.name}(...)'`);
          }
        }
        // @concurrent marks a fn that runs its closure argument on several threads at
        // once; checkConcurrentClosureArgs holds the closure to not writing its captures.
        else if (attr.name === "concurrent") {
          if (attr.args.length > 0) {
            c.error(`'@concurrent' takes no arguments`, undefined, `write '@concurrent fn ${fn.name}(...)'`);
          }
        }
        // @parks marks a fn that can switch the current green task out. It sits on the
        // primitives that call swapcontext (the checker cannot see through that extern);
        // everything reaching them inherits it in checkGlobalBorrowInvalidation.
        else if (attr.name === "parks") {
          if (attr.args.length > 0) {
            c.error(`'@parks' takes no arguments`, undefined, `write '@parks fn ${fn.name}(...)'`);
          }
        }
        // @unsafe moves the proof obligation to the caller: the body may be entirely
        // checkable and the function still unsound to call with the wrong arguments.
        // Nothing is verified here (that is the point), so the only check is the shape.
        // @mustUse: a discarded call is the unused-result warning (see the ExprStmt rule).
        // Legal on an extern: a C routine returning an error code is the main use.
        else if (attr.name === "mustUse") {
          if (attr.args.length > 0) {
            c.error(`'@mustUse' takes no arguments`, undefined, `write '@mustUse fn ${fn.name}(...)'`);
          }
        }
        else if (TRACE_ATTRS.has(attr.name)) {
          const bad = traceAttrError(attr, "fn");
          if (bad) c.error(`'@${attr.name}' on '${fn.name}': ${bad}`, fn.span);
        }
        else if (attr.name === "unsafe") {
          if (attr.args.length > 0) {
            c.error(`'@unsafe' takes no arguments`, undefined, `write '@unsafe fn ${fn.name}(...)'`);
          }
          if (fn.isExtern) {
            c.error(`'@unsafe' on extern fn '${fn.name}': an extern call's unsafety is already decided by its signature`, undefined,
              `drop '@unsafe'; see the extern rules in docs/language-reference.md`);
          }
        }
        else if (attr.name === "replayHooked") {
          if (attr.args.length > 0) c.error(`'@replayHooked' takes no arguments`, undefined, `write '@replayHooked fn ${fn.name}(...)'`);
        }
        else if (attr.name === "inline") {
          if (!isStdCollectionModule(fn.sourceFile)) {
            c.error(`'@inline' on '${fn.name}': only the std collection modules may force inlining`, undefined, `drop '@inline'; the optimizer inlines small functions on its own`);
          } else if (attr.args.length > 0) {
            c.error(`'@inline' takes no arguments`, undefined, `write '@inline fn ${fn.name}(...)'`);
          }
        }
        else if (attr.name === "trackCaller") {
          if (!isStdCollectionModule(fn.sourceFile)) {
            c.error(`'@trackCaller' on '${fn.name}': only the std collection modules may report their caller's location`, undefined, `drop '@trackCaller'; a panic names the line it happens on`);
          } else if (attr.args.length > 0) {
            c.error(`'@trackCaller' takes no arguments`, undefined, `write '@trackCaller fn ${fn.name}(...)'`);
          }
        }
        else if (attr.name === "records") {
          if (!fn.isExtern) {
            c.error(`'@records' on '${fn.name}': only an extern has calls for record/replay to capture`, undefined, `drop '@records'`);
          } else {
            for (const msg of recordsAttrErrors(fn)) c.error(`'@records' on extern fn '${fn.name}': ${msg}`, undefined,
              `write one string per output buffer, e.g. @records("buf[ret]"); see 'milo explain @records'`);
          }
        }
        else c.error(`'@${attr.name}' is not supported on functions — '${fn.name}'`, undefined,
          `only ${attributesFor("fn").map(a => `'@${a}'`).join(", ")} apply to a fn; it would be silently ignored otherwise`);
      }
    }
    c.checkVariadicExtern(fn);
    c.warnUnverifiedExternFn(fn);
    if (fn.typeParams.length > 0) {
      c.genericFns.set(fn.name, { typeParams: fn.typeParams.map(tp => tp.name), decl: fn });
      continue;
    }
    const params = fn.params.map(p => ({ type: c.resolve(declaredType(p)), name: p.name }));
    const ret = c.resolve(fn.retType);
    c.errorIfRefReturn(fn, ret);
    // main lowers to a C `int main`; codegen forces its LLVM return to i32, so
    // any other return type emits a mismatched `ret` and fails at the LLVM
    // stage instead of here. Catch it in the checker.
    if (fn.name === "main" && !fn.isExtern) {
      const okMain = ret.tag === "void" || (ret.tag === "int" && ret.bits === 32 && ret.signed);
      if (!okMain) {
        c.error(`'main' must return i32 or void, got ${c.show(ret)}`, fn.span, `the entry point lowers to C 'int main'`);
      }
    }
    // extern signatures must be C-representable — catch ABI-broken decls here rather
    // than emitting silently-wrong IR in codegen
    if (fn.isExtern) {
      for (const p of params) {
        const err = c.externSigError(p.type, "parameter");
        if (err) c.error(`extern function '${fn.name}' parameter '${p.name}': ${err.msg}`, undefined, err.hint);
      }
      const retErr = c.externSigError(ret, "return type");
      if (retErr) c.error(`extern function '${fn.name}' return type: ${retErr.msg}`, undefined, retErr.hint);
    }
    // fn return types allowed — move closures heap-allocate and are safe to escape
    c.functions.set(fn.name, { params, ret, variadic: fn.isVariadic, isExtern: fn.isExtern, ...mustUseOf(fn) });
    c.rawPtrBuiltinNames.delete(fn.name);
    // The call site needs the declaration for contracts and for `@unsafe`; recording it
    // only for contracts meant an `@unsafe fn` with no `requires` clause was declared
    // unsafe and called freely. A `@pure` extern is recorded for the extern-call rule, and
    // an `@sql` fn for checked SQL.
    if ((fn.contracts && fn.contracts.length > 0) || fn.attributes?.some(a => a.name === "unsafe" || a.name === "sql" || a.name === "sqlSchema" || (fn.isExtern && a.name === "pure"))) {
      c.fnDecls.set(fn.name, fn);
    }
  }

  // Drop-ness has to be known BEFORE derive synthesis, not after registerImpl runs:
  // a Drop type is never Copy, and the first copy-ness query decides that from an empty
  // dropImpls and caches `true`. The auto-derived Clone then reads its field as Copy and
  // synthesizes `Wrap { inner: self.inner }`, a move out of `&self`, which the checker
  // rejects with no span on a struct the program never touched. registerImpl adds these
  // again; a Set makes that idempotent, and it still owns the validation.
  for (const impl of program.impls) {
    if (impl.traitName === "Drop" && (c.structs.has(impl.typeName) || c.enums.has(impl.typeName))) {
      c.dropImpls.add(impl.typeName);
    }
  }
  c.allCopyCache.clear();

  // process @derive attributes — synthesize impl decls
  const derivedImpls = c.processDerives(program);

  // register impls
  const implFnsToCheck: Function[] = [];
  for (const impl of [...program.impls, ...derivedImpls]) {
    c.registerImpl(impl, program, implFnsToCheck);
  }
  // Record which field of the receiver each view-returning method points into, before
  // any body is checked — a call site freezes the receiver, and without this it has to
  // freeze the whole object, so a view of `self.a` would block writes to `self.b`.
  // Done as a pre-pass rather than during checkFunction so the answer does not depend
  // on whether the method happens to be checked before its first call site.
  for (const fn of implFnsToCheck) c.recordViewProvenance(fn);

  c.orderGlobalsByDependency(program);

  // type-check module-level globals — push a module scope so declare() works
  c.pushScope();
  c.globalScope = c.scopes[c.scopes.length - 1];
  const globalTypes = new Map<string, TypeKind>();
  // Declare annotated globals up front. Checking one global's initializer can
  // monomorphize a function whose body reads a global declared further down the
  // list (a `var g: Arena<T> = arenaNew<T>()` reaches std/arena's `nextArenaId`),
  // and checking them strictly in order reported that as an undefined variable
  // inside a std file. Unannotated globals still wait for their inferred type.
  for (const g of c.globalsOrdered) c.globalDeclsByName.set(g.name, g);
  for (const f of program.functions) c.fnDeclsByName.set(f.name, f);
  for (const g of c.globalsOrdered) {
    if (!g.type) continue;
    const t = c.resolve(g.type);
    globalTypes.set(g.name, t);
    c.declare(g.name, { type: t, mutable: g.mutable, borrowed: false, read: true, span: g.span, isGlobal: true });
  }
  for (const g of c.globalsOrdered) {
    const hint = g.type ? c.resolve(g.type) : null;
    const valType = c.checkExpr(g.value, hint);
    const finalType = hint ?? valType;
    if (hint && !typeEq(hint, valType) && valType.tag !== "unknown") {
      c.error(`global '${g.name}': type mismatch: expected ${c.show(hint)}, got ${c.show(valType)}`, g.span);
    }
    globalTypes.set(g.name, finalType);
    // Non-constant initializers used to be rejected when the module had no main(),
    // because the generated init routine is called from main. That answered a
    // whole-program question ("is anything going to link this?") inside a per-module
    // pass, so `milo check` rejected every library holding a string constant. A
    // Milo string is an owned heap buffer, so `pub let A: string = "hi"` is never
    // const. The missing-entry-point diagnostic now lives in the driver, where the
    // build/run path is the one that actually needs an entry point.
    //
    // The decision is still made and published on CheckResult, because one build
    // mode does have no entry point to run the routine: `emit-obj --no-entry`
    // strips `@main`, so nothing ever calls `@__milo.global_init` and every global
    // in this list would silently stay zero. That path rejects on this list.
    if (!c.isConstGlobalInit(g.value)) c._nonConstGlobals.push(g.name);
    if (!g.type) c.declare(g.name, { type: finalType, mutable: g.mutable, borrowed: false, read: true, span: g.span, isGlobal: true });
    for (const attr of g.attributes ?? []) {
      if (attr.name === "cValue") c.checkCValue(g, attr, finalType);
      else {
        // Attributes on globals parsed but were silently discarded before @cValue
        // existed, so an unknown one here is a no-op the author believes is doing
        // something. Reject rather than inherit that.
        c.error(`'@${attr.name}' is not an attribute a global can carry`, g.span,
          `only ${attributesFor("global").map(a => `'@${a}'`).join(", ")} applies to a global`);
      }
    }
  }
  c._globalTypes = globalTypes;
  c.checkFieldDefaultTypes(program);

  // The outer `recover` per function catches a `fatal()` fired in the signature
  // or contracts, before the per-statement boundaries inside the body exist.
  for (const fn of program.functions) {
    if (!fn.isExtern && fn.typeParams.length === 0) c.recover(() => c.checkFunction(fn));
  }

  c.checkRawTypeParamReads();
  c.flushStructBounds();

  // type-check impl method bodies after all registrations
  for (const fn of implFnsToCheck) {
    if (c.fromBoundFailedStruct(fn)) continue;
    c.recover(() => c.checkFunction(fn));
  }

  // drain deferred impl fns from generic impl monomorphization
  while (c._pendingImplFns.length > 0) {
    const batch = c._pendingImplFns.splice(0);
    c.flushStructBounds();
    for (const fn of batch) {
      if (c.fromBoundFailedStruct(fn)) continue;
      c.recover(() => c.checkFunction(fn));
    }
  }
  c.flushStructBounds();

  // Any deferred-inference Vec that never saw a `push` couldn't have its element
  // resolved — fall back to the original "add an annotation" error.
  if (c.pendingInferVecs.length > 0) c.reportUninferredVecs();

  // The infinite-size rejection above only covers structs that were WRITTEN with
  // concrete fields. A generic declaration cannot be walked: `A<T> { me: A<T> }`
  // says nothing about layout until T is chosen, so the cycle is only visible in
  // the instantiation. Instantiations are created on demand, some of them from a
  // function body, so this runs at the end when the set has stopped growing.
  //
  // Without it `A<i64>` type-checked clean and reached codegen as
  // `%A_i64 = type { i64, %A_i64 }`, which clang rejects as a recursive type: an
  // accepted program the backend cannot build.
  for (const mangled of [...c.structs.keys()]) {
    const info = must(c.structs, mangled, "structs");
    if (info.baseName === undefined) continue;
    if (!c.embedsSelf(mangled, new Set())) continue;
    const shown = c.demangle(mangled);
    // Point at the generic declaration: the instantiation has no source of its own
    // (created on demand, possibly from a call three files away), and an error with
    // no location makes the reader grep for a type name.
    const declSpan = c.genericStructs.get(info.baseName)?.decl.span;
    c.error(`struct '${shown}' is recursive by value and has infinite size`, declSpan,
      `a struct cannot contain itself by value: put the recursive field behind an indirection (e.g. 'Heap<${shown}>' or 'Vec<${shown}>')`);
  }

}

// The whole-program passes: they read the program after applyRewrites.
export function checkPasses(c: TypeChecker, program: Program): void {
  // They all read the finished program through one view:
  // the call-resolution maps are complete, every monomorphized instance exists, and
  // `closureCaptures` / the auto-`move` promotions have settled. Built once here so no
  // pass carries its own copy of "which function does this call reach".
  const view = c.programView(program);
  const host = c.programPassHost();

  // `@pure` needs the finished call-resolution maps and the full set of
  // monomorphized instances, so it runs after everything else has been checked.
  checkPurity(host, program, view);

  // Also needs the finished maps: `closureCaptures` is filled as each closure body is
  // checked, and the auto-`move` promotions have all settled by now.
  checkEscapingClosures(host, program, view);
  checkPlainClosureEnv(host, program, view);
  checkNonEscapingParams(host, program, view);
  checkTaskScopes(host, program, view);

  // Same reason: the `@thread` entry points, their call sites, and the closure captures
  // are all resolved by now.
  checkThreadBoundary(host, program, view);
  checkConcurrentClosureArgs(host, program, view);

  // Needs the finished call-resolution maps too: the global-write summary is a fixpoint
  // over the call graph, so every callee has to be resolvable before it runs.
  c.callFacts = { host, view, summary: checkGlobalBorrowInvalidation(host, program, view) };
  checkPointerParamEscape(host, program, view);
  // Needs every call site resolved: the evidence suffix compares the argument roots
  // across all of a fn's callers.
  checkMutParamBundle(host, program, view); checkMutability(host, program, view);
  c.lintArenaNeverFrees(program);

  // An expectation that never fired means the code it excused was fixed and the
  // suppression outlived its cause. Reported here, after every warning has had its
  // chance to fire.
  for (const name of c.warningConfig.expected ?? []) {
    if (c.firedWarnings.has(name)) continue;
    c.warn("unfulfilled-expectation",
      `'--expect=${name}' was given but no '${name}' warning was reported`, undefined,
      `the code this suppression excused looks fixed: drop the flag, or switch it to '--allow=${name}' if you meant to silence it unconditionally`);
  }

  // File-level `pub` visibility: a reference to a non-`pub` decl defined in
  // another file is an error. Run last so it never masks a more basic type error.
  for (const v of checkVisibility(program, c.builtinFnNames)) {
    const where = v.declFiles.length === 1 ? basename(v.declFiles[0]) : `${v.declFiles.length} files`;
    if (v.why === "unimported") {
      const modulePath = importPathFrom(v.refFile, v.declFiles[0]);
      c.diagnostics.push({
        severity: "error",
        span: v.span,
        message: `'${v.name}' is not imported`,
        hint: `it is exported by ${where}; add it to the import list: from "${modulePath}" import { ${v.name} }`,
        code: "unimported",
      });
      continue;
    }
    c.diagnostics.push({
      severity: "error",
      span: v.span,
      message: `'${v.name}' is private to ${where}`,
      hint: `mark '${v.name}' as 'pub' where it is defined to use it from another file`,
      code: "private",
    });
  }

}

export function finishChecks(c: TypeChecker): void {
  c.reportStrandedCFnReads();
  c.sql.run();
  c.flushSqlErrors();
}

// The finished program as the whole-program passes (purity, escaping closures, thread
// boundary, global borrow invalidation) see it. Each pass used to rebuild these four
// things inline, and the copies drifted: `rootOf` was the hand-rolled two-step walk
// that `rootNameOf` exists to replace, and purity's callee lookup had a different
// fallback chain from the other three (design pass 2026-09, F2).
export function programView(c: TypeChecker, program: Program): ProgramView {
  // monomorphizedFns holds impl methods (mangled `Type$method`, `Type$Trait$method`)
  // and generic instances; program.functions holds free fns.
  const fns = new Map<string, Function>();
  for (const f of [...program.functions, ...c.monomorphizedFns]) fns.set(f.name, f);
  // A global whose initializer runs code is initialized on its first read, so the
  // initializer is a fn that any read may call: give each one a body the passes can
  // walk. This side may only ever call MORE globals lazy than codegen does (see
  // isConstGlobalInit), which is the side that keeps the passes sound.
  const lazyInits = new Map<string, string>();
  for (const g of program.globals) {
    if (c.isConstGlobalInit(g.value)) continue;
    const name = lazyInitFnName(g.name);
    lazyInits.set(g.name, name);
    fns.set(name, {
      kind: "Function", name, typeParams: [], params: [], retType: simpleType("void"), contracts: [],
      body: [{ kind: "ExprStmt", expr: g.value, span: g.value.span }], isExtern: false, isVariadic: false,
      ...(g.span && { span: g.span }),
    });
  }
  // `Type$method` reads as `Type.method`; a monomorphized `foo_i64` reads as `foo`.
  const asWritten = new Map<string, string>();
  for (const f of c.monomorphizedFns) if (f.sourceName) asWritten.set(f.name, f.sourceName);
  return {
    fns,
    // The three maps are keyed by disjoint node kinds (rewrittenCalls: Call and the
    // Promise.all/race EnumLit; staticCalls: EnumLit; resolvedMethods: MethodCall), so
    // the order is a union, not a priority.
    calleeOf: (e) =>
      c.rewrittenCalls.get(e) ?? c.staticCalls.get(e) ?? c.resolvedMethods.get(e) ??
      (e.kind === "Call" ? e.func : undefined),
    // Takes `unknown` because the passes walk raw AST nodes; anything that is not an
    // expression has no root. Total over the expression grammar via the place walker,
    // where the old inline loops knew only FieldAccess and IndexAccess: `G!.x = v` and
    // `G.slice(a, b)[i]` (a view into G) now root at `G` too, the fail-closed direction.
    rootOf: (e) => c.rootNameOf(e) ?? undefined,
    // display() FIRST: this reads `$` as the method separator and turns it into a dot,
    // which would otherwise turn a module prefix into `gfx.tone`, a name the diagnostic
    // post-pass can no longer recognise.
    pretty: (n) => asWritten.get(n) ?? display(c._displayNames, n).replace(/\$/g, "."),
    lazyInits,
  };
}

// The checker as the whole-program passes see it (`checker-program-passes.ts`). An
// explicit literal rather than `this` so the members stay private and the seam is
// readable here: what a pass can reach is this list and nothing else.
export function programPassHost(c: TypeChecker): ProgramPassHost {
  return {
    exprTypes: c.exprTypes,
    functions: c.functions,
    monomorphizedFns: c.monomorphizedFns,
    closureCaptures: c.closureCaptures,
    rewrittenCalls: c.rewrittenCalls,
    staticCalls: c.staticCalls,
    resolvedMethods: c.resolvedMethods,
    closureCalls: c.closureCalls, cfnCalls: c.cfnCalls,
    fnFieldCalls: c.fnFieldCalls, cfnFieldCalls: c.cfnFieldCalls,
    interfaceMethodCalls: c.interfaceMethodCalls,
    error: (msg, span, hint) => c.error(msg, span, hint),
    errorCode: (code, msg, span, hint) => { c.diagnostics.push({ severity: "error", span, message: msg, hint, code }); },
    warn: (code, msg, span, hint, len) => c.warn(code, msg, span, hint, len),
    show: (t) => c.show(t),
    isSend: (ty) => c.isSend(ty),
    whyNotSend: (ty) => c.whyNotSend(ty),
    pointerViewsIn: (e) => c.pointerViewsIn(e),
    carriesRawPointer: (t) => c.carriesRawPointer(t),
    dropTypesIn: (t) => c.dropTypesIn(t),
    // Any declaration counts: a program that redeclares `extern fn usleep` still
    // names the libc symbol std declares (the merge keeps only the last copy).
    fnDeclaredInStd: (f) => {
      const stdRoot = resolvePath(STDLIB_DIR, "std") + sep;
      const files = [...c.declFiles("values", f.name), f.sourceFile ?? f.span?.file ?? ""];
      return files.some(file => file.startsWith(stdRoot));
    },
    isGenericInstance: (f) => {
      if (f.sourceName !== undefined || c.methodGenericInstances.has(f.name)) return true;
      const owner = f.name.split("$")[0];
      return f.name.includes("$") && (c.monomorphizedStructDecls.some(d => d.name === owner) || c.monomorphizedDecls.some(d => d.name === owner));
    },
    userRawPointerType: (t) => c.carriesRawPointer(t) && !c.typeDeclaredInStd(t),
    replayRawShares: c.replayRawShares,
    replaySiteOf: (sp) => replaySite(sp, STDLIB_DIR, process.cwd()),
    mutation: { written: c.writtenExprs, autoBorrowed: c.autoBorrowed, explicitMutArgs: c.explicitMutArgs, matchSubjectMut: c.matchSubjectMut, diagnostics: c.diagnostics },
  };
}

// An arena that is read but never freed, where a tier exists that would make the
// read infallible. See docs/ownership-patterns.md, pattern 2.
//
// `Arena.get` returns `Option<T>` because a slot can be freed and reused, so a stale
// handle must be catchable. A program that never frees is unwrapping an Option that
// cannot be None at every call site, and `sealGrowth()` removes exactly the operation
// it is paying for while still allowing `alloc`.
//
// Keyed to a LOCAL arena so the whole of its life is visible here: an arena reaching
// this function as a parameter may well be freed by its owner, and guessing otherwise
// would be advice that is wrong more often than right.
export function lintArenaNeverFrees(c: TypeChecker, program: Program): void {
  if (c.warningConfig.allowed.has("arena-never-frees")) return;
  for (const f of [...program.functions]) {
    if (!f.body) continue;
    if (inModule(f.sourceFile, "std/arena")) continue;
    // name -> declaration span, for locals declared as an Arena
    const locals = new Map<string, Span | undefined>();
    const frees = new Set<string>();
    const reads = new Set<string>();
    const receiver = (n: Record<string, unknown>): string | undefined => {
      const o = n.object as Record<string, unknown> | undefined;
      return o && o.kind === "Ident" && typeof o.name === "string" ? o.name : undefined;
    };
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      const n = node as Record<string, unknown> & { kind?: string; name?: unknown; method?: unknown; span?: unknown };
      if ((n.kind === "VarDecl" || n.kind === "LetDecl") && typeof n.name === "string") {
        const t = n.type as { name?: string } | undefined;
        if (t?.name === "Arena") locals.set(n.name, n.span as Span | undefined);
      }
      if (n.kind === "MethodCall" && typeof n.method === "string") {
        const r = receiver(n);
        if (r) {
          if (n.method === "free" || n.method === "clear") frees.add(r);
          // Handing the arena on by value, or sealing it, ends our view of its life.
          if (n.method === "freeze" || n.method === "sealGrowth") frees.add(r);
          if (n.method === "get" || n.method === "valid") reads.add(r);
        }
      }
      // Passed to a function: its callee may free it, so stop guessing.
      if (n.kind === "Call") {
        for (const a of (n.args as Expr[] | undefined) ?? []) {
          if (a.kind === "Ident" && typeof a.name === "string") frees.add(a.name);
        }
      }
      for (const k of Object.keys(n)) if (k !== "span") walk(n[k]);
    };
    walk(f.body);
    for (const [name, span] of locals) {
      if (frees.has(name) || !reads.has(name)) continue;
      c.warn("arena-never-frees",
        `'${name}' is never freed, so every 'get' unwraps an Option that cannot be None`,
        span,
        `'${name}.sealGrowth()' gives an infallible 'get' and keeps 'alloc'; ` +
        `'${name}.freeze()' also gives up 'alloc'. See docs/ownership-patterns.md.`);
    }
  }
}

// Fail-closed report for every C function-pointer field read that no legal context
// consumed. See `strandedCFnReads`.
export function reportStrandedCFnReads(c: TypeChecker): void {
  for (const [, info] of c.strandedCFnReads) {
    c.error(`'${info.struct}.${info.field}' is a C function pointer and cannot be used as a value`, info.span,
      `there are two things to do with one: call it ('s.${info.field}(...)', inside 'unsafe'), or test it with 'isNull(s.${info.field})'`);
  }
  c.strandedCFnReads.clear();
}

// For `let/var x = Vec.new()` / `Vec.withCapacity(n)` with no type annotation:
// return a Vec whose element is a placeholder to be resolved from the first
// `x.push(...)` (see the push handler). Returns null for anything else, so the
// normal (element-required) path — and its error — is untouched everywhere else.
export function reportUninferredVecs(c: TypeChecker): void {
  for (const p of c.pendingInferVecs) {
    if (c.isLiveInfer(p.elem)) {
      c.error(`cannot infer Vec element type — no 'push' found to infer from; add a type annotation: 'let v: Vec<T> = Vec.new()'`, p.span);
    }
  }
}

// Mirrors codegen's getConstantInitializer: what can actually be emitted as
// an LLVM constant for a module-scope global. Empty string/vec are allowed
// (they ARE zeroinitializer); a non-empty string would need heap allocation.
//
// It must never claim MORE than codegen folds: `--no-entry` rejects a module on
// this answer (nothing calls the init routine there), so a "const" the codegen
// side emits as zeroinitializer would wave through a silent zero. Codegen's side
// is Codegen.isFullyConstInit / tryConstantExpr; a case added here needs one there.
export function isConstGlobalInit(c: TypeChecker, slot: Expr): boolean {
  const e = rewritten(c.rewrites, slot);
  switch (e.kind) {
    case "IntLit":
    case "FloatLit":
    case "BoolLit":
    case "CharLit":
      return true;
    case "StringLit":
      return e.value.length === 0;
    case "BinOp":
      return c.isConstGlobalInit(e.left) && c.isConstGlobalInit(e.right);
    case "UnaryOp":
      return c.isConstGlobalInit(e.operand);
    case "CastExpr":
      return c.isConstGlobalInit(e.operand);
    case "ArrayLit":
      return e.elements.every((el) => c.isConstGlobalInit(el));
    case "ArrayRepeat":
      return c.isConstGlobalInit(e.value);
    case "StructLit":
      // A base is read at run time (codegen copies its unlisted fields out of it).
      return !e.base && e.fields.every((f) => c.isConstGlobalInit(f.value));
    case "EnumLit":
      // A static method call (`Arena<T>.new()`) parses as an EnumLit and is recorded in
      // `staticCalls` — it is a real call, not a variant construction, and folding it
      // into a constant is the exact silent-zero this guard exists to stop. Two
      // module-scope `Arena<T>.new()` globals both took id 0 that way, so a handle from
      // one resolved in the other. Only genuine construction is const.
      if (c.staticCalls.has(e)) return false;
      return e.args.every((a) => c.isConstGlobalInit(a));
    default:
      return false;
  }
}

export function printStringClones(c: TypeChecker) {
  for (const e of c.stringCloneCalls) {
    const m = e.methodSpan;
    if (!m?.file || c.explicitMutArgs.has(e) || c.autoBorrowed.get(e)?.mutable || c.writtenExprs.has(e)) continue;
    // An owned `string` receiver only: a `&string` one (a slice view, a borrowed binding)
    // does not convert to an owned string where a type is demanded, so its clone stays.
    if (c.exprTypes.get(e.object)?.tag !== "string") continue;
    process.stderr.write(`MILO_STRING_CLONE ${JSON.stringify({ file: m.file, line: m.line, col: m.col })}\n`);
  }
}
