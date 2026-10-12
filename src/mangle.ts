// Per-package name mangling.
//
// The resolver merges every module into ONE flat namespace, so two packages that
// both define `fn parse` collide in code the consumer did not write and cannot
// fix. This pass renames every top-level declaration of a file that came from a
// manifest `deps` entry to `<pkg>$<name>`, and rewrites that package's own
// references to match, before the merge. The checker, lowering, and codegen never
// see any of it — that is what makes the whole feature an AST rewrite.
//
// Package id "" (entry file, user source, all of std, the prelude) is a strict
// no-op: nothing is renamed and nothing is rewritten, so a project with no deps
// compiles byte-for-byte as it did before. The one exception is an import
// BINDING: user code that writes `from "http2" import { Client }` gets its local
// `Client` rewritten to `http2$Client`, because the definition it names lives in
// a mangled file. That is why a unit is rewritten when it has package bindings
// even if its own package id is "".
//
// Scope tracking mirrors src/visibility.ts (locals, params, type params and
// `Self` are never top-level references and must not be touched); this file adds
// the positions visibility.ts does not need — contracts, loop invariants, trait
// bounds, supertraits — because missing one there is a false-negative lint while
// missing one here is a miscompile.

import type {
  Program, Function, Expr, Stmt, MiloType, Pattern, Contract,
  TraitMethod, TypeParam,
} from "./ast";
import { patternLeafNames, enumPatternsIn } from "./ast";

// Top-level names of one package, split by namespace exactly like DeclOrigins.
export interface PkgDeclNames { values: Set<string>; types: Set<string> }

export function emptyPkgDecls(): PkgDeclNames {
  return { values: new Set(), types: new Set() };
}

// `extern fn` binds a C symbol by name and `@externalLinkage` is a deliberate C ABI
// surface: renaming either would change what the linker sees.
function isManglableFn(f: Function): boolean {
  if (f.isExtern) return false;
  if (f.attributes?.some((a) => a.name === "externalLinkage")) return false;
  return true;
}

// Stage 1 of per-module namespaces: the extra
// carve-outs that apply when the unit being renamed is a plain user MODULE rather than
// a package. `main` is looked up by the linker under that exact name, and a `@cName` or
// `@cLayout` decl exists precisely to pin a symbol or a layout a C peer names.
function isModuleManglableFn(f: Function): boolean {
  if (!isManglableFn(f)) return false;
  if (f.name === "main") return false;
  return !f.attributes?.some((a) => a.name === "cName");
}

function hasCAttr(attrs: { name: string }[] | undefined): boolean {
  return !!attrs?.some((a) => a.name === "cName" || a.name === "cLayout");
}

// std/string's private helpers that the COMPILER calls by name: lowering rewrites
// `s.contains(x)` to a call of `strContains` (src/lower.ts strMethodMap), codegen emits
// `strIndexOf`/`strIndexOfFrom`/`strLastIndexOf` for the indexOf family and `vecJoin`
// for `Vec<string>.join`.
// They are private so nothing outside std can name them, but their symbol is part of
// the compiler's ABI with std, so the per-module pass leaves it flat. Drift here is
// loud, not silent: a renamed helper is an undefined function in every program that
// calls a string method, which the fixture suite hits in the first file.
export const COMPILER_KNOWN_STD_HELPERS: ReadonlySet<string> = new Set([
  "strContains", "strIndexOf", "strIndexOfFrom", "strLastIndexOf", "strStartsWith",
  "strEndsWith", "strToLower", "strToUpper", "strTrim", "strTrimStart", "strTrimEnd",
  "strSplit", "strRepeat", "strPadStart", "strPadEnd", "strReplace", "strReplaceFirst",
  "strSplitWords", "strSplitWhitespace", "strIsEmpty", "strCharAt", "strReverse",
  "strParseInt", "strParseF64", "vecJoin",
]);

// Trait names the checker matches by spelling: `impl Eq for T` replaces the structural
// `==`, `impl Drop`/`impl Clone` hook moves and copies, `Send`/`Sync` gate threads. A
// program's own `trait Eq` means exactly that hook, so renaming it would leave the
// built-in AND the user's impl in place and every `.eq` call ambiguous.
export const COMPILER_KNOWN_TRAITS: ReadonlySet<string> = new Set(["Eq", "Clone", "Drop", "Json", "Send", "Sync"]);

// One file's top-level names the per-module pass MAY rename: its private names, or with
// `pub` set its exported ones. The two sets are collected apart because their renames
// differ in reach: a private name has no importers, so renaming it touches one file, while
// renaming a `pub` name also rewrites every importer's binding (the resolver does that
// from the same plan).
export function collectModuleDecls(prog: Program, out: PkgDeclNames, pub: boolean, isStd = false): void {
  const want = (isPub: boolean | undefined) => !!isPub === pub;
  for (const f of prog.functions) {
    if (!want(f.isPub) || !isModuleManglableFn(f)) continue;
    if (isStd && COMPILER_KNOWN_STD_HELPERS.has(f.name)) continue;
    out.values.add(f.name);
  }
  for (const g of prog.globals) if (want(g.isPub)) out.values.add(g.name);
  for (const s of prog.structs) if (want(s.isPub) && !s.isExtern && !hasCAttr(s.attributes)) out.types.add(s.name);
  for (const e of prog.enums) if (want(e.isPub) && !hasCAttr(e.attributes)) out.types.add(e.name);
  for (const t of prog.traits) if (want(t.isPub) && !COMPILER_KNOWN_TRAITS.has(t.name)) out.types.add(t.name);
  for (const i of prog.interfaces) if (want(i.isPub)) out.types.add(i.name);
  for (const a of prog.typeAliases) if (want(a.isPub)) out.types.add(a.name);
}

// Accumulate one file's top-level names into a package-wide index. Called for
// every file of a package BEFORE any rewriting, because an intra-package
// reference may point at a name declared in a sibling file.
export function collectPkgDecls(prog: Program, out: PkgDeclNames): void {
  for (const f of prog.functions) if (isManglableFn(f)) out.values.add(f.name);
  for (const g of prog.globals) out.values.add(g.name);
  for (const s of prog.structs) out.types.add(s.name);
  for (const e of prog.enums) out.types.add(e.name);
  for (const t of prog.traits) out.types.add(t.name);
  for (const i of prog.interfaces) out.types.add(i.name);
  for (const a of prog.typeAliases) out.types.add(a.name);
}

class Scopes {
  private values: Set<string>[] = [];
  private types: Set<string>[] = [];
  pushValue() { this.values.push(new Set()); }
  popValue() { this.values.pop(); }
  bindValue(n: string) { if (this.values.length) this.values[this.values.length - 1].add(n); }
  hasValue(n: string): boolean { return this.values.some((s) => s.has(n)); }
  pushType() { this.types.push(new Set()); }
  popType() { this.types.pop(); }
  bindType(n: string) { if (this.types.length) this.types[this.types.length - 1].add(n); }
  hasType(n: string): boolean { return this.types.some((s) => s.has(n)); }
}

/**
 * Rewrite one parsed file in place.
 *
 * @param prog      the file's AST (mutated)
 * @param pkg       its package id; "" means "declare nothing mangled here"
 * @param decls     every top-level name declared anywhere in `pkg`
 * @param bindings  local name → fully mangled name, from this file's imports of
 *                  a mangled package (honors `import { x as y }`)
 */
// `restrictToDecls` renames only the names present in `decls`, instead of every top-level
// decl in the file. A package owns its whole file, so the default is right there; a module
// pass owns only the file's PRIVATE names and must leave its `pub` surface alone, or every
// importer would have to be rewritten to match. Reference rewriting already consults
// `decls`, so both modes resolve references the same way.
export function manglePackage(
  prog: Program,
  pkg: string,
  decls: PkgDeclNames,
  bindings: Map<string, string>,
  restrictToDecls = false,
): void {
  if (pkg === "" && bindings.size === 0) return; // strict no-op

  const q = (name: string) => `${pkg}$${name}`;

  // An import binding wins over the intra-package rule: it is an explicit
  // statement about one name at the top of the file, and for the common
  // intra-package case (`from "./util" import { helper }` inside P) both rules
  // produce the same symbol anyway.
  const resolveValue = (name: string, sc: Scopes): string => {
    if (sc.hasValue(name)) return name;
    const b = bindings.get(name);
    if (b !== undefined) return b;
    if (pkg !== "" && decls.values.has(name)) return q(name);
    return name;
  };

  const resolveType = (name: string, sc: Scopes): string => {
    if (!name || name === "Self" || sc.hasType(name)) return name;
    const b = bindings.get(name);
    if (b !== undefined) return b;
    if (pkg !== "" && decls.types.has(name)) return q(name);
    return name;
  };

  const walkType = (ty: MiloType | null | undefined, sc: Scopes): void => {
    if (!ty) return;
    if (ty.name) ty.name = resolveType(ty.name, sc);
    for (const a of ty.typeArgs ?? []) walkType(a, sc);
    for (const p of ty.fnParams ?? []) walkType(p, sc);
    walkType(ty.fnRet, sc);
  };

  const walkExpr = (e: Expr | null | undefined, sc: Scopes): void => {
    if (!e) return;
    switch (e.kind) {
      case "Ident": e.name = resolveValue(e.name, sc); break;
      case "Call":
        e.func = resolveValue(e.func, sc);
        for (const t of e.typeArgs ?? []) walkType(t, sc);
        for (const a of e.args) walkExpr(a, sc);
        break;
      case "StructLit":
        e.name = resolveType(e.name, sc);
        for (const t of e.typeArgs ?? []) walkType(t, sc);
        for (const f of e.fields) walkExpr(f.value, sc);
        if (e.base) walkExpr(e.base, sc);
        break;
      case "EnumLit":
        // `SOME_GLOBAL.field` parses as an EnumLit — the parser cannot tell a
        // capitalised global from an enum name, and the checker recovers by looking
        // `enumName` up as a VALUE (rewriteStaticToMember). That recovery needs the
        // name it was given to still match the declaration, so resolving this purely
        // as a type left a package's own `NONCE_ALPHABET.len` pointing at an
        // unmangled name while the global had become `pkg$NONCE_ALPHABET` — the
        // consumer then saw "unknown type 'NONCE_ALPHABET'" and the package would
        // not compile at all, though it built fine inside its own repo where nothing
        // is mangled. Try the type namespace first (a real enum wins), then the value
        // namespace, so the checker's recovery still has a name it can resolve.
        {
          const asType = resolveType(e.enumName, sc);
          e.enumName = asType === e.enumName ? resolveValue(e.enumName, sc) : asType;
        }
        for (const t of e.typeArgs ?? []) walkType(t, sc);
        for (const a of e.args) walkExpr(a, sc);
        break;
      case "BinOp": walkExpr(e.left, sc); walkExpr(e.right, sc); break;
      case "UnaryOp": walkExpr(e.operand, sc); break;
      case "FieldAccess": walkExpr(e.object, sc); break;
      case "ArrayLit": for (const el of e.elements) walkExpr(el, sc); break;
      case "ArrayRepeat": walkExpr(e.value, sc); break;
      case "IndexAccess": walkExpr(e.object, sc); walkExpr(e.index, sc); break;
      case "Unwrap": case "Propagate": walkExpr(e.operand, sc); break;
      case "DefaultValue": walkExpr(e.operand, sc); walkExpr(e.default, sc); break;
      case "CastExpr": walkExpr(e.operand, sc); walkType(e.targetType, sc); break;
      case "MethodCall":
        // the method name is resolved by receiver type, never top-level
        walkExpr(e.object, sc);
        for (const a of e.args) walkExpr(a, sc);
        break;
      case "Closure":
        sc.pushValue();
        for (const p of e.params) { sc.bindValue(p.name); walkType(p.type, sc); }
        walkType(e.retType, sc);
        walkStmts(e.body, sc);
        sc.popValue();
        break;
      case "RangeExpr": walkExpr(e.start, sc); walkExpr(e.end, sc); break;
      case "IsExpr": walkExpr(e.operand, sc); walkPattern(e.pattern, sc); break;
      case "IfExpr":
        walkExpr(e.cond, sc);
        sc.pushValue(); walkStmts(e.thenBody, sc); sc.popValue();
        sc.pushValue(); walkStmts(e.elseBody, sc); sc.popValue();
        break;
      case "MatchExpr":
        walkExpr(e.subject, sc);
        for (const arm of e.arms) {
          sc.pushValue();
          bindPattern(arm.pattern, sc);
          walkPattern(arm.pattern, sc);
          walkStmts(arm.body, sc);
          sc.popValue();
        }
        break;
      // Leaves: nothing inside to visit. Listed rather than left to fall through so
      // the guard below can be exhaustive.
      case "IntLit": case "FloatLit": case "BoolLit": case "StringLit": case "CharLit":
        break;
      default: {
        // A missing arm is a SILENT skip: the walker does not descend, and everything
        // built on it stops seeing that subtree with no error to say so. This makes the
        // next unhandled expression kind a compile error.
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  };

  const bindPattern = (p: Pattern, sc: Scopes) => {
    for (const b of patternLeafNames(p)) sc.bindValue(b);
  };
  const walkPattern = (p: Pattern, sc: Scopes) => {
    for (const ep of enumPatternsIn(p)) ep.enumName = resolveType(ep.enumName, sc);
  };

  const walkContracts = (cs: Contract[] | undefined, sc: Scopes) => {
    for (const c of cs ?? []) walkExpr(c.expr, sc);
  };

  const walkStmts = (body: Stmt[], sc: Scopes) => { for (const s of body) walkStmt(s, sc); };

  const walkStmt = (s: Stmt, sc: Scopes): void => {
    switch (s.kind) {
      case "LetDecl": case "VarDecl":
        walkExpr(s.value, sc);
        walkType(s.type, sc);
        sc.bindValue(s.name);
        break;
      case "Assign": walkExpr(s.target, sc); walkExpr(s.value, sc); break;
      case "Return": walkExpr(s.value, sc); break;
      case "IfStmt":
        walkExpr(s.cond, sc);
        sc.pushValue(); walkStmts(s.thenBody, sc); sc.popValue();
        if (s.elseBody) { sc.pushValue(); walkStmts(s.elseBody, sc); sc.popValue(); }
        break;
      case "WhileStmt":
        walkExpr(s.cond, sc);
        sc.pushValue(); walkContracts(s.invariants, sc); walkStmts(s.body, sc); sc.popValue();
        break;
      case "ExprStmt": walkExpr(s.expr, sc); break;
      case "MatchStmt":
        walkExpr(s.subject, sc);
        for (const arm of s.arms) {
          sc.pushValue();
          bindPattern(arm.pattern, sc);
          walkPattern(arm.pattern, sc);
          walkStmts(arm.body, sc);
          sc.popValue();
        }
        break;
      case "IfLetStmt":
        walkExpr(s.subject, sc);
        walkPattern(s.pattern, sc);
        sc.pushValue(); bindPattern(s.pattern, sc); walkStmts(s.thenBody, sc); sc.popValue();
        if (s.elseBody) { sc.pushValue(); walkStmts(s.elseBody, sc); sc.popValue(); }
        break;
      case "IfChainStmt":
        // One scope for the whole chain: a `let` clause's bindings are seen by the later
        // clauses and the then-body. The else is outside it.
        sc.pushValue();
        for (const c of s.clauses) {
          if (c.kind === "CondClause") { walkExpr(c.cond, sc); continue; }
          walkExpr(c.subject, sc);
          walkPattern(c.pattern, sc);
          bindPattern(c.pattern, sc);
        }
        walkStmts(s.thenBody, sc);
        sc.popValue();
        if (s.elseBody) { sc.pushValue(); walkStmts(s.elseBody, sc); sc.popValue(); }
        break;
      case "LetElseStmt":
        walkExpr(s.value, sc);
        walkPattern(s.pattern, sc);
        sc.pushValue(); walkStmts(s.elseBody, sc); sc.popValue();
        bindPattern(s.pattern, sc); // bindings escape into the enclosing scope
        break;
      case "UnsafeBlock":
        sc.pushValue(); walkStmts(s.body, sc); sc.popValue();
        break;
      case "ForInStmt":
        walkExpr(s.iterable, sc);
        sc.pushValue();
        sc.bindValue(s.varName);
        if (s.varName2) sc.bindValue(s.varName2);
        walkStmts(s.body, sc);
        sc.popValue();
        break;
      // No names to bind and no nested scope. Listed rather than left to fall through so
      // the guard below can be exhaustive.
      case "BreakStmt": case "ContinueStmt": break;
      default: {
        // A statement kind nobody added an arm for is silently not walked, and a name that
        // is never walked is never mangled — a wrong symbol rather than an error. This
        // makes the next unhandled kind a compile error.
        const _exhaustive: never = s;
        void _exhaustive;
      }
    }
  };

  // Trait bounds name traits, so they follow the type rule.
  const walkBounds = (tps: TypeParam[] | undefined, sc: Scopes) => {
    for (const tp of tps ?? []) tp.bounds = tp.bounds.map((b) => resolveType(b, sc));
  };

  const walkFnBody = (fn: Function, outerTypeParams: TypeParam[], selfBound: boolean) => {
    const sc = new Scopes();
    sc.pushType();
    if (selfBound) sc.bindType("Self");
    for (const tp of outerTypeParams) sc.bindType(tp.name);
    for (const tp of fn.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(outerTypeParams, sc);
    walkBounds(fn.typeParams, sc);
    sc.pushValue();
    for (const p of fn.params) { sc.bindValue(p.name); walkType(p.type, sc); }
    walkType(fn.retType, sc);
    walkContracts(fn.contracts, sc);
    if (fn.body) walkStmts(fn.body, sc);
    sc.popValue();
    sc.popType();
  };

  const walkTraitMethod = (m: TraitMethod, outerTypeParams: TypeParam[]) => {
    const sc = new Scopes();
    sc.pushType();
    sc.bindType("Self");
    for (const tp of outerTypeParams) sc.bindType(tp.name);
    sc.pushValue();
    for (const p of m.params) { sc.bindValue(p.name); walkType(p.type, sc); }
    walkType(m.retType, sc);
    if (m.body) walkStmts(m.body, sc);
    sc.popValue();
    sc.popType();
  };

  // ── 1. rename declarations (reference rewriting below reads the ORIGINAL
  //       name index, so the order of these two phases does not matter) ──
  if (pkg !== "") {
    const val = (n: string) => !restrictToDecls || decls.values.has(n);
    const typ = (n: string) => !restrictToDecls || decls.types.has(n);
    for (const f of prog.functions) if (isManglableFn(f) && val(f.name)) f.name = q(f.name);
    for (const g of prog.globals) if (val(g.name)) g.name = q(g.name);
    for (const s of prog.structs) if (typ(s.name)) s.name = q(s.name);
    for (const e of prog.enums) if (typ(e.name)) e.name = q(e.name);
    for (const t of prog.traits) if (typ(t.name)) t.name = q(t.name);
    for (const i of prog.interfaces) if (typ(i.name)) i.name = q(i.name);
    for (const a of prog.typeAliases) if (typ(a.name)) a.name = q(a.name);
    // A `derive X { … }` template is named for the trait it implements, so it moves with
    // that trait or `@derive(X)` resolves to a trait that no longer exists under that name.
    for (const d of prog.deriveTemplates ?? []) if (typ(d.name)) d.name = q(d.name);
  }

  // ── 2. rewrite references ──
  const topScope = () => { const sc = new Scopes(); sc.pushType(); sc.pushValue(); return sc; };

  for (const fn of prog.functions) walkFnBody(fn, [], false);

  // `@derive(Describe)` names a trait, so it follows the type rule. A built-in (`Clone`,
  // `Eq`, `Json`) is declared nowhere and resolves to itself.
  const walkDeriveArgs = (attrs: { name: string; args: string[] }[] | undefined, sc: Scopes) => {
    for (const a of attrs ?? []) if (a.name === "derive") a.args = a.args.map((t) => resolveType(t, sc));
  };
  for (const s of prog.structs) {
    const sc = topScope();
    for (const tp of s.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(s.typeParams, sc);
    walkDeriveArgs(s.attributes, sc);
    for (const f of s.fields) walkType(f.type, sc);
  }
  for (const e of prog.enums) {
    const sc = topScope();
    for (const tp of e.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(e.typeParams, sc);
    walkDeriveArgs(e.attributes, sc);
    for (const v of e.variants) for (const ft of v.fields ?? []) walkType(ft, sc);
  }
  for (const a of prog.typeAliases) {
    // A generic alias's parameters are names bound by the alias, not module-level types:
    // without binding them here `type Handler<T> = (T) => R` would have its `T` qualified
    // into `somemodule.T` and stop matching the parameter it names.
    const sc = topScope();
    for (const tp of a.typeParams ?? []) sc.bindType(tp.name);
    walkType(a.type, sc);
  }
  for (const g of prog.globals) {
    const sc = topScope();
    walkType(g.type, sc);
    walkExpr(g.value, sc);
  }
  for (const t of prog.traits) {
    const sc = topScope();
    sc.bindType("Self");
    for (const tp of t.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(t.typeParams, sc);
    t.supertraits = t.supertraits.map((s) => resolveType(s, sc));
    for (const m of t.methods) walkTraitMethod(m, t.typeParams ?? []);
  }
  for (const i of prog.interfaces) for (const m of i.methods) walkTraitMethod(m, []);

  for (const impl of prog.impls) {
    const sc = topScope();
    for (const tp of impl.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(impl.typeParams, sc);
    // The receiver/trait names are ordinary type references; the METHOD names are
    // already namespaced by the receiver type and must not be touched.
    impl.typeName = resolveType(impl.typeName, sc);
    if (impl.traitName) impl.traitName = resolveType(impl.traitName, sc);
    for (const m of impl.methods ?? []) walkFnBody(m, impl.typeParams ?? [], true);
  }
}

// ── display names ──
//
// A mangled name is a SYMBOL. It reaches the linker and nothing else: a reader who wrote
// `fn tone` is never shown `gfx$tone`, in a diagnostic, in `print` output, in a debugger
// or in an editor hover. Every rename this file performs is recorded here, mangled to
// as-written, and every human-facing surface renders through `display()`.
//
// A side table rather than a demangling step, because the mangled string is not
// self-describing: only the pass that did the renaming knows which prefixes it invented,
// and `$` also separates `Type$method` and generic instances (`Pair_i64`). Keyed by name
// because almost every consumer has a NAME in hand and not a decl: a diagnostic is a
// string, `print` gets a struct name, DWARF gets a symbol.
export type DisplayNames = Map<string, string>;

// Built once per map: the alternation is O(renamed names) and diagnostics run it per
// message. The map is built once by the resolver and never mutated after.
const displayRegexes = new WeakMap<DisplayNames, RegExp>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render `text`, a bare symbol or a whole diagnostic message, with every mangled name
 * replaced by the name the programmer wrote.
 *
 * Substring matching, anchored only at the start of the key and only against a letter
 * or digit: `$` cannot occur in a Milo identifier, so every `$` in a compiler-facing name
 * is a separator this compiler put there, and every context a mangled name is embedded
 * in wants the same substitution. `gfx$User$greet` (an impl method), `gfx$Pair_i64` (a
 * monomorphized instance), `Vec_gfx$User` (a container instantiated on one) and
 * `Radio$io$Trait$m` (a trait from module `io`) all read correctly once the registered
 * part is swapped. The lookbehind is what keeps std's short module ids honest: without
 * it the key `io$x` would match inside a user's own `Radio$x`. Longest key first, so
 * `mygfx$tone` never loses to `gfx$tone`.
 */
export function display(map: DisplayNames | undefined, text: string): string {
  if (!map || map.size === 0) return text;
  let re = displayRegexes.get(map);
  if (!re) {
    const keys = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    re = new RegExp(`(?<![A-Za-z0-9])(?:${keys.join("|")})`, "g");
    displayRegexes.set(map, re);
  }
  return text.replace(re, (m) => map.get(m) ?? m);
}

/**
 * `display`, for a message that may name two decls written the same way: `a$Pt` and
 * `b$Pt` both read `Pt`, so "expected Pt, got Pt" would point at correct-looking code.
 * When a written name stands for more than one decl in `text` (two renamed ones, or one
 * renamed and one that kept the bare name, such as std's), each renamed occurrence is
 * qualified with `origin(symbol)`, typically its file: "expected Pt (b.milo), got Pt
 * (a.milo)". A message naming one decl renders exactly as `display` would.
 */
export function displayQualified(
  map: DisplayNames | undefined, text: string, origin: (sym: string) => string | undefined,
): string {
  if (!map || map.size === 0) return text;
  display(map, ""); // builds and caches the matcher
  const re = displayRegexes.get(map)!;
  const syms = new Map<string, Set<string>>();
  for (const m of text.matchAll(re)) {
    const w = map.get(m[0])!;
    let s = syms.get(w);
    if (!s) { s = new Set(); syms.set(w, s); }
    s.add(m[0]);
  }
  const ambiguous = new Set<string>();
  for (const [w, s] of syms) {
    // `$` in the guard: inside a mangled `a$Pt` the bare `Pt` is not a separate mention.
    const bare = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegex(w)}(?![A-Za-z0-9_$])`);
    if (s.size > 1 || bare.test(text)) ambiguous.add(w);
  }
  if (ambiguous.size === 0) return display(map, text);
  return text.replace(re, (m) => {
    const w = map.get(m) ?? m;
    if (!ambiguous.has(w)) return w;
    const o = origin(m);
    return o ? `${w} (${o})` : w;
  });
}

/**
 * Rewrite a RESOLVED program's declarations back to their written names, in place.
 *
 * For display-only consumers; the LSP is the one that exists. Hover, go-to-definition
 * and document symbols look a decl up by the identifier under the cursor and then print
 * its signature, so against a mangled program they find nothing at all (`tone` never
 * matches `gfx$tone`). They have no reason to see symbols, so the cheapest correct
 * answer is a program that has none.
 *
 * MUST run after type checking, never before: the checker resolves by these names, and
 * two modules' `tone` collapsing back into one is exactly the collision mangling prevents.
 */
export function restoreDisplayNames(prog: Program): void {
  const map = prog.displayNames;
  if (!map || map.size === 0) return;
  const d = (n: string) => display(map, n);
  const ty = (t: MiloType | null | undefined): void => {
    if (!t) return;
    if (t.name) t.name = d(t.name);
    for (const a of t.typeArgs ?? []) ty(a);
    for (const p of t.fnParams ?? []) ty(p);
    ty(t.fnRet);
  };
  const fn = (f: Function | TraitMethod): void => {
    f.name = d(f.name);
    for (const p of f.params) ty(p.type);
    ty(f.retType);
  };
  for (const f of prog.functions) fn(f);
  for (const g of prog.globals) { g.name = d(g.name); ty(g.type); }
  for (const s of prog.structs) { s.name = d(s.name); for (const f of s.fields) ty(f.type); }
  for (const e of prog.enums) { e.name = d(e.name); for (const v of e.variants) for (const f of v.fields ?? []) ty(f); }
  for (const t of prog.traits) { t.name = d(t.name); t.supertraits = t.supertraits.map(d); for (const m of t.methods) fn(m); }
  for (const i of prog.interfaces) { i.name = d(i.name); for (const m of i.methods) fn(m); }
  for (const a of prog.typeAliases) { a.name = d(a.name); ty(a.type); }
  for (const impl of prog.impls) {
    impl.typeName = d(impl.typeName);
    if (impl.traitName) impl.traitName = d(impl.traitName);
    for (const m of impl.methods ?? []) fn(m);
  }
}
