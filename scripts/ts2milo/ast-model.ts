// The tagged-union and AST-type rules of the portable subset, shared by the transpiler (which
// maps expressions over these types) and by the Milo AST emitter below (which maps the types).
//
// Rule: a TS `type U = A | B | ...` whose members are interfaces (or inline object types), each
// carrying the same property (the discriminant: `kind`, `tag`, ...) of a distinct string-literal
// type, is a tagged union. It becomes `enum U { A_kind(A), ... }`, one variant per member named by
// the literal, holding a struct named for the interface (without its discriminant field, which the
// variant now carries). An inline member's struct is named `U_<Literal>`.
import ts from "typescript";
import { collectIdentity, ID_FIELD } from "./node-identity";

// `kind` is the discriminant's value, `name` the variant's struct, `decl` its declaration.
export interface Variant { via?: string; kind: string; name: string; decl: ts.InterfaceDeclaration | ts.TypeLiteralNode; members: readonly ts.TypeElement[] }
// A union of unions: `variants` are the leaves of every member, each `via` the member it sits under;
// `members` is set only then.
export interface NestedMember { name: string; decl: ts.Declaration; union: TaggedUnion | null }
export interface TaggedUnion { name: string; decl: ts.TypeAliasDeclaration; field: string; variants: Variant[]; members?: NestedMember[] }

const literalOf = (members: readonly ts.TypeElement[], field: string): string | null => {
  for (const m of members) {
    if (ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === field && m.type && ts.isLiteralTypeNode(m.type) && ts.isStringLiteral(m.type.literal)) return m.type.literal.text;
  }
  return null;
};

const literalsOf = (members: readonly ts.TypeElement[], field: string): string[] | null => {
  for (const m of members) {
    if (!(ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === field && m.type)) continue;
    const ts_ = ts.isUnionTypeNode(m.type) ? m.type.types : [m.type];
    const out = ts_.map((x) => (ts.isLiteralTypeNode(x) && ts.isStringLiteral(x.literal) ? x.literal.text : null));
    return out.some((x) => x === null) ? null : (out as string[]);
  }
  return null;
};

// The declaration is a tagged union if every member is an interface or an inline object type and
// one property of them all has a distinct string-literal type per member. That property is the
// discriminant; `kind` wins when several qualify.
export function taggedUnionOf(checker: ts.TypeChecker, d: ts.TypeAliasDeclaration): TaggedUnion | null {
  if (d.typeParameters || !ts.isUnionTypeNode(d.type)) return null;
  const raw: { decl: ts.InterfaceDeclaration | ts.TypeLiteralNode; members: readonly ts.TypeElement[] }[] = [];
  for (const t of d.type.types) {
    if (ts.isTypeLiteralNode(t)) { raw.push({ decl: t, members: t.members }); continue; }
    if (!ts.isTypeReferenceNode(t)) return null;
    const decl = checker.getSymbolAtLocation(t.typeName)?.declarations?.[0];
    if (!decl || !ts.isInterfaceDeclaration(decl)) return null;
    raw.push({ decl, members: decl.members });
  }
  const cands = raw[0].members.flatMap((m) => (ts.isPropertySignature(m) && ts.isIdentifier(m.name) ? [m.name.text] : [])).sort((a, b) => Number(b === "kind") - Number(a === "kind"));
  for (const field of cands) {
    const lits = raw.map((r) => literalOf(r.members, field));
    if (lits.some((l) => l === null) || new Set(lits).size !== lits.length) continue;
    const variants = raw.map((r, i): Variant => ({ kind: lits[i]!, name: ts.isInterfaceDeclaration(r.decl) ? r.decl.name.text : `${d.name.text}_${pascal(lits[i]!)}`, decl: r.decl, members: r.members }));
    return { name: d.name.text, decl: d, field, variants };
  }
  return null;
}

// Rule (union of unions): `type U = A | B | ...` whose members are tagged unions and/or single
// interfaces, all with one discriminant field and no literal in two members, is an enum with one
// variant per MEMBER, wrapping it: `enum U { A(A), B(B) }`. A guard on a leaf narrows through both
// levels. Passing an A where a U is wanted wraps it. `U` is never itself a flat tagged union.
export function nestedUnionOf(checker: ts.TypeChecker, d: ts.TypeAliasDeclaration): TaggedUnion | null {
  if (d.typeParameters || !ts.isUnionTypeNode(d.type) || !d.type.types.every(ts.isTypeReferenceNode)) return null;
  const members: NestedMember[] = [];
  const unionLeaves: Variant[] = [];
  let field: string | null = null;
  for (const t of d.type.types as unknown as ts.TypeReferenceNode[]) {
    let sym = checker.getSymbolAtLocation(t.typeName);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym); // imported from another file
    const decl = sym?.declarations?.[0];
    if (!decl) return null;
    let u: TaggedUnion | null = null;
    if (ts.isTypeAliasDeclaration(decl)) {
      u = taggedUnionOf(checker, decl);
      if (!u || (field !== null && field !== u.field)) return null;
      field = u.field;
    } else if (!ts.isInterfaceDeclaration(decl)) return null;
    const name = (decl as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text;
    members.push({ name, decl, union: u });
    if (u) unionLeaves.push(...u.variants.map((v) => ({ ...v, via: name })));
  }
  // With only interface members, the shared discriminant is found among the first one's string-literal fields.
  if (!field) {
    const first = (members[0].decl as ts.InterfaceDeclaration).members;
    const cands = first.flatMap((m) => (ts.isPropertySignature(m) && ts.isIdentifier(m.name) ? [m.name.text] : [])).sort((a, b) => Number(b === "kind") - Number(a === "kind"));
    field = cands.find((c) => literalsOf(first, c) !== null) ?? null;
    if (!field) return null;
  }
  const variants: Variant[] = [];
  for (const m of members) {
    if (m.union) { variants.push(...unionLeaves.filter((v) => v.via === m.name)); continue; }
    const decl = m.decl as ts.InterfaceDeclaration;
    // A lone interface may carry several literals (`kind: "a" | "b"`): each is a leaf of the one member.
    const lits = literalsOf(decl.members, field);
    if (lits === null) return null;
    for (const kind of lits) variants.push({ via: m.name, kind, name: m.name, decl, members: decl.members });
  }
  if (members.length < 2 || new Set(variants.map((v) => v.kind)).size !== variants.length) return null;
  return { name: d.name.text, decl: d, field, variants, members };
}

// `e` is `x.<discriminant>` of a tagged-union value `x`: the one read of a union the transpiler
// turns into narrowing, and the one read the portable subset allows (in a guard).
export function discriminantRead(checker: ts.TypeChecker, e: ts.Node): TaggedUnion | null {
  if (!ts.isPropertyAccessExpression(e)) return null;
  const u = guardUnion(checker, e.expression);
  return u && u.field === e.name.text ? u : null;
}

// Variant interface -> its union, per program, so a union narrowed by earlier `else if` branches
// (which TS gives no alias name) is still recognized by its members.
const byVariant = new WeakMap<ts.TypeChecker, Map<ts.Declaration, TaggedUnion>>();
export function registerUnions(program: ts.Program, checker: ts.TypeChecker): void {
  if (byVariant.has(checker)) return;
  const m = new Map<ts.Declaration, TaggedUnion>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    for (const s of sf.statements) {
      if (!ts.isTypeAliasDeclaration(s)) continue;
      const u = taggedUnionOf(checker, s);
      if (u) for (const v of u.variants) m.set(v.decl, u);
    }
  }
  byVariant.set(checker, m);
}

export const variantUnionOf = (checker: ts.TypeChecker, d: ts.Declaration): TaggedUnion | undefined => byVariant.get(checker)?.get(d);

// The tagged union a type is, whole or narrowed to some of its variants, or null. A single variant
// (an interface) is not a union.
export function unionOfType(checker: ts.TypeChecker, t: ts.Type): TaggedUnion | null {
  const d = t.aliasSymbol?.declarations?.[0];
  if (d && ts.isTypeAliasDeclaration(d)) return taggedUnionOf(checker, d) ?? nestedUnionOf(checker, d);
  if (!t.isUnion()) return null;
  const reg = byVariant.get(checker);
  let found: TaggedUnion | null = null;
  for (const m of t.types) {
    const decl = m.symbol?.declarations?.[0];
    const u = decl && reg?.get(decl);
    if (!u || (found && found !== u)) return null;
    found = u;
  }
  return found;
}

// The union an expression is a value of by declaration: after earlier `else if` branches TS has
// narrowed the last variant down to a lone interface, but the next `x.kind === "K"` (or the union's own discriminant) still guards the
// union it was declared as.
export function guardUnion(checker: ts.TypeChecker, e: ts.Expression): TaggedUnion | null {
  const sym = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e) : undefined;
  return (sym && unionOfType(checker, checker.getTypeOfSymbol(sym))) ?? unionOfType(checker, checker.getTypeAtLocation(e));
}

// ---- field boxing: a by-value cycle needs a Heap ----

export interface AstModel {
  unions: Map<string, TaggedUnion>;
  ifaces: Map<string, ts.InterfaceDeclaration>;
  // Members of inline (object-literal) union variants: structs of their own, outside `ifaces`.
  inline: Map<string, readonly ts.TypeElement[]>;
  // The file each interface or union is declared in.
  fileOf: Map<string, string>;
  // Fields whose Milo type is `Heap<...>` (the field closes a by-value cycle).
  boxed: Set<ts.PropertySignature>;
  cloneable: Set<string>;
  // Types on a cycle or holding one: the Milo derive clones them, but a clone is only a faithful stand-in for a TS shared reference when nothing mutates either side.
  recursive: Set<string>;
  // Types that carry a hidden `id` field (node-identity.ts).
  identity: Set<string>;
  // Types on a cycle: an array of them holds Heap<T> elements, or the text of the type grows with every level of nesting.
  cyclic: Set<string>;
  // Fields with no Milo type (an untagged union of primitives). Counted and reported.
  dropped: { iface: string; field: string; type: string }[];
}

const stripOptional = (t: ts.TypeNode): ts.TypeNode => {
  if (ts.isParenthesizedTypeNode(t)) return stripOptional(t.type);
  if (ts.isUnionTypeNode(t)) {
    const rest = t.types.filter((x) => x.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword));
    if (rest.length === 1) return stripOptional(rest[0]);
  }
  return t;
};

// `files`: the AST file and every other input file whose interfaces a decoder must reach.
export function buildAstModel(program: ts.Program, checker: ts.TypeChecker, files: string[]): AstModel {
  const unions = new Map<string, TaggedUnion>();
  const ifaces = new Map<string, ts.InterfaceDeclaration>();
  const fileOf = new Map<string, string>();
  for (const file of files) {
    for (const s of program.getSourceFile(file)!.statements) {
      // First file wins (ast.ts is first): a later file may reuse a name (backend-program.ts has its own StructDecl).
      if (ts.isInterfaceDeclaration(s) && !(ifaces.has(s.name.text) && fileOf.get(s.name.text) === files[0])) { ifaces.set(s.name.text, s); fileOf.set(s.name.text, file); }
      if (ts.isTypeAliasDeclaration(s) && !(unions.has(s.name.text) && fileOf.get(s.name.text) === files[0])) { const u = taggedUnionOf(checker, s); if (u) { unions.set(u.name, u); fileOf.set(u.name, file); } }
    }
  }
  // Direct (non-array) edges between named types. A union points at its variants, an interface at
  // the types its non-array fields name. A field on a cycle is boxed.
  const edges = new Map<string, { field: ts.PropertySignature | null; to: string }[]>();
  const add = (from: string, to: string, field: ts.PropertySignature | null) => { if (!edges.has(from)) edges.set(from, []); edges.get(from)!.push({ field, to }); };
  const dropped: AstModel["dropped"] = [];
  for (const u of unions.values()) for (const v of u.variants) add(u.name, v.name, null);
  // Inline variants are structs of their own, outside `ifaces`; walked the same way.
  const members = new Map<string, readonly ts.TypeElement[]>();
  for (const i of ifaces.values()) members.set(i.name.text, i.members);
  const inline = new Map<string, readonly ts.TypeElement[]>();
  for (const u of unions.values()) for (const v of u.variants) if (ts.isTypeLiteralNode(v.decl)) { members.set(v.name, v.members); inline.set(v.name, v.members); if (!fileOf.has(v.name)) fileOf.set(v.name, fileOf.get(u.name)!); }
  for (const [iname, mems] of members) {
    for (const m of mems) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const t = stripOptional(m.type);
      if (ts.isTypeReferenceNode(t)) {
        const n = t.typeName.getText();
        if (ifaces.has(n) || unions.has(n)) add(iname, n, m);
      }
    }
  }
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const go = (n: string): boolean => {
      if (n === target) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      return (edges.get(n) ?? []).some((e) => go(e.to));
    };
    return (edges.get(from) ?? []).some((e) => go(e.to));
  };
  const boxed = new Set<ts.PropertySignature>();
  for (const [from, es] of edges) for (const e of es) if (e.field && reaches(e.to, from)) boxed.add(e.field);
  // Types `@derive(Clone)` can be put on: no cycle through them, and none among the types they hold
  // (the derive cannot be applied to mutually recursive types, so a clone of one is a Milo error).
  const all = new Map<string, Set<string>>();
  for (const u of unions.values()) all.set(u.name, new Set(u.variants.map((v) => v.name)));
  for (const [iname, mems] of members) {
    const s = new Set<string>();
    for (const m of mems) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      let t = stripOptional(m.type);
      if (ts.isArrayTypeNode(t)) t = stripOptional(t.elementType);
      if (ts.isTypeReferenceNode(t)) { const n = t.typeName.getText(); if (ifaces.has(n) || unions.has(n)) s.add(n); }
    }
    all.set(iname, s);
  }
  const closure = (n: string): Set<string> => {
    const out = new Set<string>();
    const go = (x: string) => { for (const y of all.get(x) ?? []) if (!out.has(y)) { out.add(y); go(y); } };
    go(n);
    return out;
  };
  const cyclic = new Set<string>();
  for (const n of all.keys()) if (closure(n).has(n)) cyclic.add(n);
  const cloneable = new Set<string>(all.keys());
  const recursive = new Set<string>();
  for (const n of all.keys()) if (cyclic.has(n) || [...closure(n)].some((x) => cyclic.has(x))) recursive.add(n);
  return { unions, ifaces, inline, fileOf, boxed, dropped, cloneable, recursive, cyclic, identity: collectIdentity(program, checker, files) };
}

// ---- Milo AST types and the JSON decoder, from the types ----

const RESERVED = new Set("fn extern let var return if else while true false struct enum match mut import from break continue as trait impl for in unsafe move null is type interface requires ensures invariant decreases self Self pub".split(" "));
const field_ = (n: string) => (RESERVED.has(n) ? n + "_" : n);
const pascal = (s: string) => s.replace(/(^|[^a-zA-Z0-9]+)(.)/g, (_, __, c) => c.toUpperCase());

export interface AstEmit { types: string; decoder: string; encoder: string; typeNames: string[]; dropped: AstModel["dropped"]; sizeBoxed: string[]; foreign: { file: string; name: string }[] }
export interface LitName { name: string; lits: string[]; file: string }

// Milo for every type reachable from `roots`: struct and enum declarations for the types declared
// in `astFile`, and a JSON decoder (cursors into a std/json document) for all of them wherever
// declared. `litName` names a string-literal union the way the function emitter does, so both
// sides agree on the enum; `modOf` gives the Milo module a file's declarations live in.
// Declared in ast.ts but owned by the hand-written runtime, whose Diagnostic holds one: a second struct of the name is a different type.
export const RUNTIME_OWNED = new Set(["Span"]);
// The name a type node refers to: a plain reference, or one written as an import type.
const refName = (n: ts.TypeNode): string | null => (ts.isTypeReferenceNode(n) ? n.typeName.getText() : ts.isImportTypeNode(n) && n.qualifier ? n.qualifier.getText() : null);
export function emitAst(checker: ts.TypeChecker, model: AstModel, astFile: string, roots: string[], litName: (t: ts.TypeNode) => LitName | null, modOf: (file: string) => string, used: Set<ts.Node>, kindEnum: (u: TaggedUnion) => LitName): AstEmit {
  const membersOf = (n: string) => model.ifaces.get(n)?.members ?? model.inline.get(n);
  const enums = new Map<string, LitName>();
  const order: string[] = [];
  const seen = new Set<string>();
  const variantOf = new Map<string, string>();
  for (const u of model.unions.values()) for (const v of u.variants) variantOf.set(v.name, u.name);
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    order.push(name);
    const u = model.unions.get(name);
    if (u) { for (const v of u.variants) visit(v.name); return; }
    const mems = membersOf(name);
    if (!mems) return;
    for (const m of mems) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      if (variantOf.has(name) && (m.name as ts.Identifier).text === model.unions.get(variantOf.get(name)!)!.field) continue;
      if (model.fileOf.get(name) === astFile && !used.has(m)) continue;
      const base = stripOptional(m.type);
      const elem = ts.isArrayTypeNode(base) ? stripOptional(base.elementType) : base;
      const en = refName(elem);
      if (en) visit(en);
    }
  };
  for (const r of roots) visit(r);
  // The discriminant has no field in a variant struct, so a read of it outside a guard (`e.kind === "X"`)
  // goes through `U_kind(e)`, which returns an enum of the variant kinds.
  const kindOf = new Map<string, LitName>();
  for (const u of model.unions.values()) {
    if (!seen.has(u.name) || model.fileOf.get(u.name) !== astFile) continue;
    const l = kindEnum(u);
    if (l.file === astFile) { enums.set(l.name, l); kindOf.set(u.name, l); }
  }

  // Types declared outside astFile whose Milo struct has fields the decoder cannot build (a Map, a
  // closure): their decoder would leave fields out of the literal, so they have none and nothing
  // that holds one is decoded either.
  const incomplete = new Set<string>();
  const decoderFieldsDropped = (name: string): boolean => {
    const u = model.unions.get(name);
    if (u) return u.variants.some((v) => incomplete.has(v.name));
    const unionField = variantOf.has(name) ? model.unions.get(variantOf.get(name)!)!.field : "";
    return (membersOf(name) ?? []).some((m) => ts.isPropertySignature(m) && !!m.type && (m.name as ts.Identifier).text !== unionField && typeOf(m) === null);
  };

  // Milo type of a field, or null when it has none (an untagged union of primitives).
  const typeOf = (m: ts.PropertySignature): string | null => {
    const wrap = (s: string, node: ts.TypeNode, question: boolean) => (question || stripOptional(node) !== node ? `Option<${s}>` : s);
    const conv = (n: ts.TypeNode, _boxedHere: boolean): string | null => {
      n = stripOptional(n);
      if (ts.isArrayTypeNode(n)) {
        const e = conv(n.elementType, false);
        if (e === null) return null;
        const el = stripOptional(n.elementType);
        const name = refName(el) ?? "";
        return `Vec<${wrap(model.cyclic.has(name) ? `Heap<${e}>` : e, n.elementType, false)}>`;
      }
      if (n.kind === ts.SyntaxKind.NumberKeyword) return "i64";
      if (n.kind === ts.SyntaxKind.StringKeyword || n.kind === ts.SyntaxKind.BigIntKeyword) return "string";
      if (n.kind === ts.SyntaxKind.BooleanKeyword || (ts.isLiteralTypeNode(n) && n.literal.kind === ts.SyntaxKind.TrueKeyword)) return "bool";
      const rn = refName(n);
      if (rn) {
        if (membersOf(rn) || model.unions.has(rn)) return incomplete.has(rn) ? null : rn;
      }
      const l = litName(n) ?? (ts.isTypeReferenceNode(n) ? (() => { const d = checker.getSymbolAtLocation(n.typeName)?.declarations?.[0]; return d && ts.isTypeAliasDeclaration(d) ? litName(d.type) : null; })() : null);
      if (l) { enums.set(l.name, l); return l.name; }
      return null;
    };
    const base = conv(m.type!, false);
    const full = base === null ? null : model.boxed.has(m) ? `Heap<${base}>` : base;
    return full === null ? null : wrap(full, m.type!, !!m.questionToken);
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...model.ifaces.keys(), ...model.inline.keys(), ...model.unions.keys()]) {
      if (model.fileOf.get(n) === astFile || incomplete.has(n) || !decoderFieldsDropped(n)) continue;
      incomplete.add(n);
      changed = true;
    }
  }

  const structFields = new Map<string, { name: string; ty: string; node: ts.PropertySignature; fill?: string }[]>();
  const dropped: AstModel["dropped"] = [];
  const foreign: { file: string; name: string }[] = [];
  const fieldsOf = (name: string, report: boolean) => {
    const fs: { name: string; ty: string; node: ts.PropertySignature; fill?: string }[] = [];
    if (model.identity.has(name) || RUNTIME_OWNED.has(name)) fs.push({ name: ID_FIELD, ty: "i64", node: undefined as unknown as ts.PropertySignature });
    for (const m of membersOf(name)!) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const fname = (m.name as ts.Identifier).text;
      if (variantOf.has(name) && fname === model.unions.get(variantOf.get(name)!)!.field) continue;
      // A field no input file reads is not carried: a smaller type, a smaller dump, a smaller decoder.
      if (model.fileOf.get(name) === astFile && !used.has(m)) continue;
      const t = typeOf(m);
      if (t === null) {
        // A list or optional of a type the decoder cannot build (tokens): the struct keeps the field, the decoder leaves it empty.
        const base = stripOptional(m.type);
        const isList = ts.isArrayTypeNode(base);
        const el = isList ? stripOptional(base.elementType) : base;
        const en = refName(el);
        const opt = base !== m.type || !!m.questionToken;
        if (en && membersOf(en) && model.fileOf.get(en) !== astFile && (isList || opt)) {
          foreign.push({ file: model.fileOf.get(en)!, name: en });
          const inner = isList ? `Vec<${en}>` : en;
          fs.push({ name: fname, ty: opt ? `Option<${inner}>` : inner, node: m, fill: opt ? "Option.None" : "Vec.new()" });
          continue;
        }
      }
      if (t === null) { if (report && model.fileOf.get(name) === astFile) dropped.push({ iface: name, field: fname, type: m.type.getText() }); continue; }
      fs.push({ name: fname, ty: t, node: m });
    }
    structFields.set(name, fs);
  };
  for (const name of order) if (membersOf(name)) fieldsOf(name, true);

  // The Milo backend only passes a value of 128 bytes or more by reference when it is a literal or a
  // call result, so a Heap<Expr> read as a `&Expr` argument fails once the enum is that big. An enum
  // is as big as its largest variant: box the largest fields of any variant struct until the
  // estimate (with the tag) is under a limit that leaves room for the estimate being rough.
  const LIMIT = 112;
  const sizeOf = (ty: string): number => {
    if (ty === "i64" || ty === "bool") return 8;
    if (ty === "string" || ty.startsWith("Vec<")) return 24;
    if (ty.startsWith("Heap<")) return 8;
    if (ty.startsWith("Option<")) return sizeOf(ty.slice(7, -1)) + 8;
    if (enums.has(ty)) return 8;
    const u = model.unions.get(ty);
    if (u) return Math.max(...u.variants.map((v) => sizeOf(v.name))) + 8;
    return (structFields.get(ty) ?? []).reduce((a, f) => a + sizeOf(f.ty), 0);
  };
  const sizeBoxed: string[] = [];
  for (const u of model.unions.values()) {
    if (!seen.has(u.name)) continue;
    const names = new Set<string>();
    for (const v of u.variants) {
      const s = v.name;
      // Optionals and structs first (a string or a Vec is already a handle, a Heap<string> buys
      // nothing); a Vec only when nothing else is left.
      for (const allowVec of [false, true]) {
        for (;;) {
          if (sizeOf(s) + 8 <= LIMIT) break;
          const aggregate = (ty: string) => structFields.has(ty) || model.unions.has(ty);
          const cand = (structFields.get(s) ?? []).filter((f) => !f.fill && (f.ty.startsWith("Option<") || aggregate(f.ty) || (allowVec && f.ty.startsWith("Vec<"))) && !f.ty.startsWith("Option<Heap<") && sizeOf(f.ty) > 16).sort((a, b) => sizeOf(b.ty) - sizeOf(a.ty))[0];
          if (!cand) break;
          model.boxed.add(cand.node);
          if (!allowVec) names.add(cand.name);
          sizeBoxed.push(`${s}.${cand.name}`);
          fieldsOf(s, false);
        }
      }
    }
    // (The structs below that are not variants get the same treatment after this loop.)
    // A field boxed in one variant is boxed in all of them, so the common-field accessor and every
    // read of it agree.
    for (const v of u.variants) {
      const s = v.name;
      let changed = false;
      for (const f of structFields.get(s) ?? []) {
        if (names.has(f.name) && !model.boxed.has(f.node) && sizeOf(f.ty) > 8) { model.boxed.add(f.node); changed = true; }
      }
      if (changed) fieldsOf(s, false);
    }
  }

  // A struct held in a Heap (an array element on a cycle) is read as a value too: same limit.
  for (const name of order) {
    if (variantOf.has(name) || !membersOf(name) || !model.cyclic.has(name)) continue;
    for (const allowVec of [false, true]) {
      for (;;) {
        if (sizeOf(name) + 8 <= LIMIT) break;
        const aggregate = (ty: string) => structFields.has(ty) || model.unions.has(ty);
        const cand = (structFields.get(name) ?? []).filter((f) => !f.fill && (f.ty.startsWith("Option<") || aggregate(f.ty) || (allowVec && f.ty.startsWith("Vec<"))) && !f.ty.startsWith("Option<Heap<") && sizeOf(f.ty) > 16).sort((a, b) => sizeOf(b.ty) - sizeOf(a.ty))[0];
        if (!cand) break;
        model.boxed.add(cand.node);
        sizeBoxed.push(`${name}.${cand.name}`);
        fieldsOf(name, false);
      }
    }
  }

  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...model.cloneable]) {
      const bad = (structFields.get(n) ?? []).some((f) => (f.ty.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((w) => (membersOf(w) || model.unions.has(w)) && !model.cloneable.has(w)));
      if (bad) { model.cloneable.delete(n); changed = true; }
    }
  }

  // ---- types (only those declared in astFile; the rest are declared by their own files) ----
  const t: string[] = ["// GENERATED by scripts/ts2milo.ts from src/ast.ts. Do not edit; change the TypeScript.", ...[...RUNTIME_OWNED].filter((n) => order.includes(n)).map((n) => `from "./ts2milo_runtime" import { ${n} }`)];
  const typeNames: string[] = [];
  for (const l of enums.values()) if (l.file === astFile) t.push(`@derive(Clone)`, `pub enum ${l.name} { ${l.lits.map(pascal).join(", ")} }`);
  for (const name of order) {
    if (model.fileOf.get(name) !== astFile) continue;
    const u = model.unions.get(name);
    if (u) {
      typeNames.push(name);
      t.push(...(model.cloneable.has(name) ? ["@derive(Clone)"] : []), `pub enum ${name} {`, ...u.variants.map((v) => `    ${pascal(v.kind)}(${v.name}),`), `}`);
      // A field every variant has, read through one accessor (`Expr_span(e)`): a union has no fields of its own.
      // A boxed field is returned unboxed (cloned out of its Heap).
      const per = u.variants.map((v) => structFields.get(v.name) ?? []);
      const unbox = (ty: string) => (ty.startsWith("Option<Heap<") ? `Option<${ty.slice(12, -2)}>` : ty.startsWith("Heap<") ? ty.slice(5, -1) : ty);
      for (const f of per[0] ?? []) {
        const plain = unbox(f.ty);
        if (plain.includes("Heap<") || !per.every((p) => p.some((x) => x.name === f.name && unbox(x.ty) === plain))) continue;
        const arm = (v: Variant) => {
          const x = structFields.get(v.name)!.find((y) => y.name === f.name)!;
          const read = `p.${field_(f.name)}`;
          if (x.ty.startsWith("Option<Heap<")) return `match ${read} { Option.Some(h) => Option.Some((*h).clone()), Option.None => Option.None }`;
          if (x.ty.startsWith("Heap<")) return `(*${read}).clone()`;
          return `${read}.clone()`;
        };
        t.push(`pub fn ${name}_${f.name}(e: &${name}): ${plain} {`, `    return match e {`, ...u.variants.map((v) => `        ${name}.${pascal(v.kind)}(p) => ${arm(v)},`), `    }`, `}`);
      }
      const ke = kindOf.get(name);
      if (ke) {
        t.push(`pub fn ${name}_${u.field}(e: &${name}): ${ke.name} {`, `    return match e {`, ...u.variants.map((v) => `        ${name}.${pascal(v.kind)}(p) => ${ke.name}.${pascal(v.kind)},`), `    }`, `}`);
      }
      continue;
    }
    const fs = structFields.get(name);
    if (!fs) continue;
    typeNames.push(name);
    if (RUNTIME_OWNED.has(name)) continue;
    t.push(...(model.cloneable.has(name) ? ["@derive(Clone)"] : []), `pub struct ${name} {`, ...fs.map((f) => `    ${field_(f.name)}: ${f.ty},`), `}`);
  }

  // ---- decoder ----
  const d: string[] = [];
  const done = new Set<string>();
  const dec = (ty: string): string => {
    const name = "dec_" + ty.replace(/[<>, ]/g, "_");
    if (done.has(name)) return name;
    done.add(name);
    const head = `fn ${name}(j: &Json, c: i64): ${ty} {`;
    const lines: string[] = [];
    if (ty === "i64") lines.push(head, `    return j.curInt(c).unwrapOr(0)`, `}`, "");
    else if (ty === "bool") lines.push(head, `    return j.curBool(c).unwrapOr(false)`, `}`, "");
    else if (ty === "string") lines.push(head, `    return jsFromUtf8(rawStr(j, c))`, `}`, "");
    else if (ty.startsWith("Vec<")) {
      const f = dec(ty.slice(4, -1));
      lines.push(head, `    var out: ${ty} = Vec.new()`, `    let n = j.curLen(c)`, `    var i: i64 = 0`, `    while i < n {`, `        out.push(${f}(j, j.curChild(c, i)))`, `        i += 1`, `    }`, `    return out`, `}`, "");
    } else if (ty.startsWith("Option<")) {
      const f = dec(ty.slice(7, -1));
      lines.push(head, `    if j.curKind(c) <= 0 {`, `        return Option.None`, `    }`, `    return Option.Some(${f}(j, c))`, `}`, "");
    } else if (ty.startsWith("Heap<")) {
      const f = dec(ty.slice(5, -1));
      lines.push(head, `    return Heap(${f}(j, c))`, `}`, "");
    } else if (enums.has(ty)) {
      const lits = enums.get(ty)!.lits;
      lines.push(head, `    let s = rawStr(j, c)`);
      for (const l of lits.slice(0, -1)) lines.push(`    if s == ${JSON.stringify(l)} {`, `        return ${ty}.${pascal(l)}`, `    }`);
      lines.push(`    return ${ty}.${pascal(lits[lits.length - 1])}`, `}`, "");
    } else if (model.unions.has(ty)) {
      const u = model.unions.get(ty)!;
      lines.push(head, `    let k = rawStr(j, j.curField(c, ${JSON.stringify(u.field)}))`);
      for (const v of u.variants.slice(0, -1)) lines.push(`    if k == ${JSON.stringify(v.kind)} {`, `        return ${ty}.${pascal(v.kind)}(${dec(v.name)}(j, c))`, `    }`);
      const last = u.variants[u.variants.length - 1];
      lines.push(`    return ${ty}.${pascal(last.kind)}(${dec(last.name)}(j, c))`, `}`, "");
    } else {
      const fs = structFields.get(ty) ?? [];
      lines.push(head, `    return ${ty} {`, ...fs.map((f) => (f.fill ? `        ${field_(f.name)}: ${f.fill},` : f.node ? `        ${field_(f.name)}: ${dec(f.ty)}(j, j.curField(c, ${JSON.stringify(f.name)})),` : `        ${f.name}: ts2miloNextId(),`)), `    }`, `}`, "");
    }
    d.push(...lines);
    return name;
  };
  const rootFns = roots.map((r) => (incomplete.has(r) ? "" : dec(r)));
  const mods = new Map<string, Set<string>>();
  const importFrom = (file: string, name: string) => { const m = modOf(file); if (!mods.has(m)) mods.set(m, new Set()); mods.get(m)!.add(name); };
  for (const name of order) if (!incomplete.has(name)) { const f = model.fileOf.get(name); if (f && !RUNTIME_OWNED.has(name) && (model.unions.has(name) || structFields.has(name))) importFrom(f, name); }
  for (const l of enums.values()) importFrom(l.file, l.name);
  const out: string[] = ["// GENERATED by scripts/ts2milo.ts from the TypeScript types. Do not edit; change the TypeScript.", `from "std/json" import { Json }`, `from "./ts2milo_runtime" import { ${[...RUNTIME_OWNED].filter((n) => order.includes(n)).map((n) => n + ", ").join("")}jsFromUtf8${(model.identity.size || order.some((n) => RUNTIME_OWNED.has(n))) ? ", ts2miloNextId" : ""} }`];
  for (const [m, names] of [...mods.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push(`from "${m}" import { ${[...names].sort().join(", ")} }`);
  out.push("");
  out.push(`fn rawStr(j: &Json, c: i64): string {`, `    match j.curStr(c) {`, `        Option.Some(s) => { return s }`, `        Option.None => { return "" }`, `    }`, `}`, "");
  out.push(...d);
  roots.forEach((r, i) => !incomplete.has(r) && out.push(`pub fn decode${r}(j: &Json, c: i64): ${r} {`, `    return ${rootFns[i]}(j, c)`, `}`));

  // ---- encoder: the mirror of the decoder, writing a generated AST as JSON (the parser differential compares it with
  // emit-ast). Spans and the hidden node id are not written: the TS AST has no id, and spans are compared elsewhere. ----
  const e: string[] = [];
  const edone = new Set<string>();
  const enc = (ty: string): string => {
    const name = "enc_" + ty.replace(/[<>, ]/g, "_");
    if (edone.has(name)) return name;
    edone.add(name);
    const head = `fn ${name}(v: &${ty}, out: &mut string) {`;
    const lines: string[] = [];
    if (ty === "i64") lines.push(head, `    out.pushStr(v.toString())`, `}`, "");
    else if (ty === "bool") lines.push(head, `    if v {`, `        out.pushStr("true")`, `    } else {`, `        out.pushStr("false")`, `    }`, `}`, "");
    else if (ty === "string") lines.push(head, `    jsonQuote(v, &mut out)`, `}`, "");
    else if (ty.startsWith("Vec<")) {
      const f = enc(ty.slice(4, -1));
      lines.push(head, `    out.pushStr("[")`, `    var i: i64 = 0`, `    while i < v.len {`, `        if i > 0 {`, `            out.pushStr(",")`, `        }`, `        ${f}(v[i], &mut out)`, `        i += 1`, `    }`, `    out.pushStr("]")`, `}`, "");
    } else if (ty.startsWith("Option<")) {
      const f = enc(ty.slice(7, -1));
      lines.push(head, `    match v {`, `        Option.Some(x) => {`, `            ${f}(x, &mut out)`, `        }`, `        Option.None => {`, `            out.pushStr("null")`, `        }`, `    }`, `}`, "");
    } else if (ty.startsWith("Heap<")) {
      const f = enc(ty.slice(5, -1));
      lines.push(head, `    ${f}(*v, &mut out)`, `}`, "");
    } else if (enums.has(ty)) {
      const lits = enums.get(ty)!.lits;
      lines.push(head, `    match v {`, ...lits.map((l) => `        ${ty}.${pascal(l)} => {\n            out.pushStr(${JSON.stringify(JSON.stringify(l))})\n        }`), `    }`, `}`, "");
    } else if (model.unions.has(ty)) {
      const u = model.unions.get(ty)!;
      lines.push(head, `    match v {`, ...u.variants.map((vt) => `        ${ty}.${pascal(vt.kind)}(p) => {\n            ${enc(vt.name)}(p, &mut out)\n        }`), `    }`, `}`, "");
    } else {
      const fs = (structFields.get(ty) ?? []).filter((f) => f.node && !f.fill && !/\bSpan\b/.test(f.ty));
      const un = variantOf.get(ty) ? model.unions.get(variantOf.get(ty)!)! : null;
      const kind = un ? un.variants.find((vt) => vt.name === ty)!.kind : null;
      lines.push(head, `    out.pushStr("{")`);
      let first = true;
      const key = (k: string) => { lines.push(`    out.pushStr(${JSON.stringify((first ? "" : ",") + JSON.stringify(k) + ":")})`); first = false; };
      if (un) { key(un.field); lines.push(`    out.pushStr(${JSON.stringify(JSON.stringify(kind))})`); }
      for (const f of fs) { key(f.name); lines.push(`    ${enc(f.ty)}(v.${field_(f.name)}, &mut out)`); }
      lines.push(`    out.pushStr("}")`, `}`, "");
    }
    e.push(...lines);
    return name;
  };
  const encRoots = roots.filter((r) => model.fileOf.get(r) === astFile && !incomplete.has(r));
  const encRootFns = encRoots.map((r) => enc(r));
  const eout: string[] = ["// GENERATED by scripts/ts2milo.ts from the TypeScript types. Do not edit; change the TypeScript.", `from "./ts2milo_runtime" import { jsonQuote, Span }`];
  for (const [m, names] of [...mods.entries()].sort(([a], [b]) => a.localeCompare(b))) { const used_ = [...names].filter((n) => edone.has("enc_" + n)).sort(); if (used_.length) eout.push(`from "${m}" import { ${used_.join(", ")} }`); }
  eout.push("", ...e);
  encRoots.forEach((r, i) => eout.push(`pub fn encode${r}(v: &${r}, out: &mut string) {`, `    ${encRootFns[i]}(v, &mut out)`, `}`));
  return { types: t.join("\n") + "\n", decoder: out.join("\n") + "\n", encoder: eout.join("\n") + "\n", typeNames, dropped, sizeBoxed, foreign };
}
