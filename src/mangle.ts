// Per-package name mangling — see docs/plans/package-manager.md §P0.
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

// Top-level names of one package, split by namespace exactly like DeclOrigins.
export interface PkgDeclNames { values: Set<string>; types: Set<string> }

export function emptyPkgDecls(): PkgDeclNames {
  return { values: new Set(), types: new Set() };
}

// `extern fn` binds a C symbol by name and `@export` is a deliberate C ABI
// surface: renaming either would change what the linker sees.
export function isManglableFn(f: Function): boolean {
  if (f.isExtern) return false;
  if (f.attributes?.some((a) => a.name === "export")) return false;
  return true;
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
export function manglePackage(
  prog: Program,
  pkg: string,
  decls: PkgDeclNames,
  bindings: Map<string, string>,
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
        for (const f of e.fields) walkExpr(f.value, sc);
        break;
      case "EnumLit":
        e.enumName = resolveType(e.enumName, sc);
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
    }
  };

  const bindPattern = (p: Pattern, sc: Scopes) => {
    if (p.kind === "EnumPattern") for (const b of p.bindings) sc.bindValue(b);
  };
  const walkPattern = (p: Pattern, sc: Scopes) => {
    if (p.kind === "EnumPattern") p.enumName = resolveType(p.enumName, sc);
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
    for (const f of prog.functions) if (isManglableFn(f)) f.name = q(f.name);
    for (const g of prog.globals) g.name = q(g.name);
    for (const s of prog.structs) s.name = q(s.name);
    for (const e of prog.enums) e.name = q(e.name);
    for (const t of prog.traits) t.name = q(t.name);
    for (const i of prog.interfaces) i.name = q(i.name);
    for (const a of prog.typeAliases) a.name = q(a.name);
  }

  // ── 2. rewrite references ──
  const topScope = () => { const sc = new Scopes(); sc.pushType(); sc.pushValue(); return sc; };

  for (const fn of prog.functions) walkFnBody(fn, [], false);

  for (const s of prog.structs) {
    const sc = topScope();
    for (const tp of s.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(s.typeParams, sc);
    for (const f of s.fields) walkType(f.type, sc);
  }
  for (const e of prog.enums) {
    const sc = topScope();
    for (const tp of e.typeParams ?? []) sc.bindType(tp.name);
    walkBounds(e.typeParams, sc);
    for (const v of e.variants) for (const ft of v.fields ?? []) walkType(ft, sc);
  }
  for (const a of prog.typeAliases) walkType(a.type, topScope());
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
