// File-level visibility enforcement for `pub`.
//
// Milo declarations are file-private by default; `pub` exports them. Because the
// resolver merges every module into one flat namespace (resolver.ts:175), a name
// still *resolves* across files even when it was never imported — so the guarantee
// cannot live at the import site. It lives here: a reference in file A to a
// non-`pub` top-level decl defined in file B (A ≠ B) is an error.
//
// Model: a name is importable if it has at least one `pub` definition anywhere. A
// purely-private name is usable only inside the file that defines it. References
// that bind to locals, type parameters, or builtins are never top-level refs and
// are skipped — that is what the scope tracking below is for.

import type {
  Program, Function, Expr, Stmt, MiloType, Pattern, Span,
  StructDecl, EnumDecl, TraitDecl, InterfaceDecl, TypeAlias, GlobalDecl, ImplDecl,
} from "./ast";

export interface VisibilityViolation {
  name: string;
  kind: "value" | "type";
  refFile: string;
  declFiles: string[];
  span?: Span;
}

interface DeclIndex {
  // names with ≥1 `pub` definition — importable from anywhere
  pubValues: Set<string>;
  pubTypes: Set<string>;
  // private definitions: name → set of files that define it privately
  privValueFiles: Map<string, Set<string>>;
  privTypeFiles: Map<string, Set<string>>;
}

function addPriv(m: Map<string, Set<string>>, name: string, file: string) {
  let s = m.get(name);
  if (!s) { s = new Set(); m.set(name, s); }
  s.add(file);
}

function buildIndex(prog: Program): DeclIndex {
  const idx: DeclIndex = {
    pubValues: new Set(), pubTypes: new Set(),
    privValueFiles: new Map(), privTypeFiles: new Map(),
  };
  const value = (name: string, isPub: boolean | undefined, file?: string) => {
    if (isPub) idx.pubValues.add(name);
    else if (file) addPriv(idx.privValueFiles, name, file);
  };
  const type = (name: string, isPub: boolean | undefined, file?: string) => {
    if (isPub) idx.pubTypes.add(name);
    else if (file) addPriv(idx.privTypeFiles, name, file);
  };
  for (const f of prog.functions) value(f.name, f.isPub, f.span?.file ?? f.sourceFile);
  for (const g of prog.globals) value(g.name, g.isPub, g.span?.file);
  for (const s of prog.structs) type(s.name, s.isPub, s.span?.file);
  for (const e of prog.enums) type(e.name, e.isPub, e.span?.file);
  for (const t of prog.traits) type(t.name, t.isPub, t.span?.file);
  for (const i of prog.interfaces) type(i.name, i.isPub, i.span?.file);
  for (const a of prog.typeAliases) type(a.name, a.isPub, a.span?.file);
  return idx;
}

// A minimal scope stack. Two namespaces: values (vars/fns) and types (generics).
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

export function checkVisibility(prog: Program): VisibilityViolation[] {
  const idx = buildIndex(prog);
  const out: VisibilityViolation[] = [];

  // Report at most one violation per (name, refFile) — repeated uses of the same
  // private import are one mistake, and flooding the diagnostics helps nobody.
  const seen = new Set<string>();

  const refValue = (name: string, sc: Scopes, refFile: string | undefined, span?: Span) => {
    if (!refFile || sc.hasValue(name)) return;
    if (idx.pubValues.has(name)) return;
    const files = idx.privValueFiles.get(name);
    if (!files) return; // not a user top-level value (builtin/unknown) — skip
    if (files.has(refFile)) return; // this file's own private decl
    const key = `v:${name}:${refFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind: "value", refFile, declFiles: [...files], span });
  };

  const refType = (name: string, sc: Scopes, refFile: string | undefined, span?: Span) => {
    if (!refFile || sc.hasType(name)) return;
    if (idx.pubTypes.has(name)) return;
    const files = idx.privTypeFiles.get(name);
    if (!files) return;
    if (files.has(refFile)) return;
    const key = `t:${name}:${refFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind: "type", refFile, declFiles: [...files], span });
  };

  const walkType = (ty: MiloType | null | undefined, sc: Scopes, refFile: string | undefined, span?: Span) => {
    if (!ty) return;
    // Only the head name is a type reference; primitives/builtins won't be in the
    // private index so they self-skip. Generic params are handled via type scope.
    if (ty.name) refType(ty.name, sc, refFile, span);
    for (const a of ty.typeArgs ?? []) walkType(a, sc, refFile, span);
    for (const p of ty.fnParams ?? []) walkType(p, sc, refFile, span);
    walkType(ty.fnRet, sc, refFile, span);
  };

  const walkExpr = (e: Expr | null | undefined, sc: Scopes, refFile: string | undefined) => {
    if (!e) return;
    switch (e.kind) {
      case "Ident": refValue(e.name, sc, refFile, e.span); break;
      case "Call":
        refValue(e.func, sc, refFile, e.span);
        for (const t of e.typeArgs ?? []) walkType(t, sc, refFile, e.span);
        for (const a of e.args) walkExpr(a, sc, refFile);
        break;
      case "StructLit":
        refType(e.name, sc, refFile, e.span);
        for (const f of e.fields) walkExpr(f.value, sc, refFile);
        break;
      case "EnumLit":
        refType(e.enumName, sc, refFile, e.span);
        for (const t of e.typeArgs ?? []) walkType(t, sc, refFile, e.span);
        for (const a of e.args) walkExpr(a, sc, refFile);
        break;
      case "BinOp": walkExpr(e.left, sc, refFile); walkExpr(e.right, sc, refFile); break;
      case "UnaryOp": walkExpr(e.operand, sc, refFile); break;
      case "FieldAccess": walkExpr(e.object, sc, refFile); break;
      case "ArrayLit": for (const el of e.elements) walkExpr(el, sc, refFile); break;
      case "ArrayRepeat": walkExpr(e.value, sc, refFile); break;
      case "IndexAccess": walkExpr(e.object, sc, refFile); walkExpr(e.index, sc, refFile); break;
      case "Unwrap": case "Propagate": walkExpr(e.operand, sc, refFile); break;
      case "DefaultValue": walkExpr(e.operand, sc, refFile); walkExpr(e.default, sc, refFile); break;
      case "CastExpr": walkExpr(e.operand, sc, refFile); walkType(e.targetType, sc, refFile, e.span); break;
      case "MethodCall":
        // method name is resolved by receiver type, not a top-level ref
        walkExpr(e.object, sc, refFile);
        for (const a of e.args) walkExpr(a, sc, refFile);
        break;
      case "Closure": {
        sc.pushValue();
        for (const p of e.params) { sc.bindValue(p.name); walkType(p.type, sc, refFile, e.span); }
        walkType(e.retType, sc, refFile, e.span);
        walkStmts(e.body, sc, refFile);
        sc.popValue();
        break;
      }
      case "RangeExpr": walkExpr(e.start, sc, refFile); walkExpr(e.end, sc, refFile); break;
      case "IsExpr": walkExpr(e.operand, sc, refFile); /* pattern below */ walkPatternRefs(e.pattern, sc, refFile); break;
      case "IfExpr":
        walkExpr(e.cond, sc, refFile);
        sc.pushValue(); walkStmts(e.thenBody, sc, refFile); sc.popValue();
        sc.pushValue(); walkStmts(e.elseBody, sc, refFile); sc.popValue();
        break;
      case "MatchExpr":
        walkExpr(e.subject, sc, refFile);
        for (const arm of e.arms) {
          sc.pushValue();
          bindPattern(arm.pattern, sc);
          walkPatternRefs(arm.pattern, sc, refFile);
          walkStmts(arm.body, sc, refFile);
          sc.popValue();
        }
        break;
      // literals: nothing to reference
    }
  };

  // Enum patterns name a type (the enum); their bindings introduce locals.
  const bindPattern = (p: Pattern, sc: Scopes) => {
    if (p.kind === "EnumPattern") for (const b of p.bindings) sc.bindValue(b);
  };
  const walkPatternRefs = (p: Pattern, sc: Scopes, refFile: string | undefined) => {
    if (p.kind === "EnumPattern") refType(p.enumName, sc, refFile, p.span);
  };

  const walkStmts = (body: Stmt[], sc: Scopes, refFile: string | undefined) => {
    for (const s of body) walkStmt(s, sc, refFile);
  };

  const walkStmt = (s: Stmt, sc: Scopes, refFile: string | undefined) => {
    switch (s.kind) {
      case "LetDecl": case "VarDecl":
        walkExpr(s.value, sc, refFile);
        walkType(s.type, sc, refFile, s.span);
        sc.bindValue(s.name);
        break;
      case "Assign": walkExpr(s.target, sc, refFile); walkExpr(s.value, sc, refFile); break;
      case "Return": walkExpr(s.value, sc, refFile); break;
      case "IfStmt":
        walkExpr(s.cond, sc, refFile);
        sc.pushValue(); walkStmts(s.thenBody, sc, refFile); sc.popValue();
        if (s.elseBody) { sc.pushValue(); walkStmts(s.elseBody, sc, refFile); sc.popValue(); }
        break;
      case "WhileStmt":
        walkExpr(s.cond, sc, refFile);
        sc.pushValue(); walkStmts(s.body, sc, refFile); sc.popValue();
        break;
      case "ExprStmt": walkExpr(s.expr, sc, refFile); break;
      case "MatchStmt":
        walkExpr(s.subject, sc, refFile);
        for (const arm of s.arms) {
          sc.pushValue();
          bindPattern(arm.pattern, sc);
          walkPatternRefs(arm.pattern, sc, refFile);
          walkStmts(arm.body, sc, refFile);
          sc.popValue();
        }
        break;
      case "IfLetStmt":
        walkExpr(s.subject, sc, refFile);
        walkPatternRefs(s.pattern, sc, refFile);
        sc.pushValue(); bindPattern(s.pattern, sc); walkStmts(s.thenBody, sc, refFile); sc.popValue();
        if (s.elseBody) { sc.pushValue(); walkStmts(s.elseBody, sc, refFile); sc.popValue(); }
        break;
      case "LetElseStmt":
        walkExpr(s.value, sc, refFile);
        walkPatternRefs(s.pattern, sc, refFile);
        sc.pushValue(); walkStmts(s.elseBody, sc, refFile); sc.popValue();
        bindPattern(s.pattern, sc); // bindings escape into the enclosing scope
        break;
      case "UnsafeBlock":
        sc.pushValue(); walkStmts(s.body, sc, refFile); sc.popValue();
        break;
      case "ForInStmt":
        walkExpr(s.iterable, sc, refFile);
        sc.pushValue();
        sc.bindValue(s.varName);
        if (s.varName2) sc.bindValue(s.varName2);
        walkStmts(s.body, sc, refFile);
        sc.popValue();
        break;
    }
  };

  const walkFn = (fn: Function, typeParams: string[]) => {
    const refFile = fn.span?.file ?? fn.sourceFile;
    const sc = new Scopes();
    sc.pushType();
    for (const tp of typeParams) sc.bindType(tp);
    for (const tp of fn.typeParams ?? []) sc.bindType(tp.name);
    sc.pushValue();
    for (const p of fn.params) { sc.bindValue(p.name); walkType(p.type, sc, refFile, fn.span); }
    walkType(fn.retType, sc, refFile, fn.span);
    if (fn.body) walkStmts(fn.body, sc, refFile);
    sc.popValue();
    sc.popType();
  };

  for (const fn of prog.functions) if (!fn.isExtern) walkFn(fn, []);

  // Struct/enum field types, alias targets, global initializers.
  const scNone = () => { const s = new Scopes(); s.pushType(); s.pushValue(); return s; };
  for (const s of prog.structs) {
    const sc = scNone(); const refFile = s.span?.file;
    for (const tp of s.typeParams ?? []) sc.bindType(tp.name);
    for (const f of s.fields) walkType(f.type, sc, refFile, f.type ? undefined : s.span);
  }
  for (const e of prog.enums) {
    const sc = scNone(); const refFile = e.span?.file;
    for (const tp of e.typeParams ?? []) sc.bindType(tp.name);
    for (const v of e.variants) for (const ft of v.fields ?? []) walkType(ft, sc, refFile, e.span);
  }
  for (const a of prog.typeAliases) {
    const sc = scNone(); walkType(a.type, sc, a.span?.file, a.span);
  }
  for (const g of prog.globals) {
    const sc = scNone();
    walkType(g.type, sc, g.span?.file, g.span);
    walkExpr(g.value, sc, g.span?.file);
  }

  // impl method bodies: the receiver type name is bound as `Self`.
  for (const impl of prog.impls) {
    for (const m of impl.methods ?? []) {
      const sc = new Scopes();
      sc.pushType(); sc.bindType("Self");
      for (const tp of impl.typeParams ?? []) sc.bindType(tp.name);
      for (const tp of m.typeParams ?? []) sc.bindType(tp.name);
      sc.pushValue();
      for (const p of m.params) { sc.bindValue(p.name); walkType(p.type, sc, m.span?.file ?? impl.span?.file, m.span); }
      walkType(m.retType, sc, m.span?.file ?? impl.span?.file, m.span);
      if (m.body) walkStmts(m.body, sc, m.span?.file ?? impl.span?.file);
      sc.popValue(); sc.popType();
    }
  }

  return out;
}
