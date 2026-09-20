// User-defined `@derive(Trait)` — the template mechanism that lets a derive ship in a
// package instead of a compiler PR.
//
// `@derive(Json)` is 366 lines of TypeScript in `src/derive-json.ts`, which makes every
// new derive a change to the compiler. A template is the same idea with the generator
// written in Milo:
//
//     derive Describe {
//         fn describe(self: &Self): string {
//             var out = "@Self { "
//             @fields {
//                 out.pushStr("@name=")
//                 out.pushStr("{self.@name}")
//                 out.pushStr(" ")
//             }
//             return out + "}"
//         }
//     }
//
// **Deliberately not a macro system.** There is no user-written code that RUNS at compile
// time: the only control construct is `@fields`, a repetition over a list whose length is
// fixed by the struct declaration, so expansion always terminates and always terminates in
// the same number of steps. Everything else is substitution. That keeps a derive from
// becoming a second, weaker language inside the first — the failure mode of every macro
// system that started as "just a template".
//
// Expansion is a TOKEN rewrite, and the result is handed to the ordinary `Parser`. So a
// template is bound by the same grammar and the same checker rules as hand-written code:
// there is no construct a derive can produce that a user could not have typed. That is the
// property `derive-json.ts` gets by emitting source text, kept here — tokens rather than
// text only because the parser has no guaranteed access to the original source.
import type { DeriveTemplate, ImplDecl, MiloType, Span, StructDecl } from "./ast";
import type { Token } from "./tokens";
import { TokenKind } from "./tokens";
import { Lexer } from "./lexer";
import { Parser } from "./parser";

// The written form of a type, as source. Shared with the LSP's hover rendering — a type
// spelled back differently in two places is a bug report waiting to happen.
export function formatMiloType(t: MiloType): string {
  if (t.isFn && t.fnParams && t.fnRet) {
    return `${t.isMoveFn ? "move " : ""}(${t.fnParams.map(formatMiloType).join(", ")}) => ${formatMiloType(t.fnRet)}`;
  }
  let base = t.name;
  if (t.rangeMin !== undefined && t.rangeMax !== undefined) base += `(${t.rangeMin}..${t.rangeMax})`;
  if (t.typeArgs?.length) base += `<${t.typeArgs.map(formatMiloType).join(", ")}>`;
  if (t.isArray) return t.arraySize !== null ? `[${base}; ${t.arraySize}]` : `[${base}]`;
  if (t.isRef) return `&${base}`;
  if (t.isRefMut) return `&mut ${base}`;
  if (t.isPtr) return `${"*".repeat(t.ptrDepth ?? 1)}${base}`;
  return base;
}

export class DeriveTemplateError extends Error {
  constructor(message: string, readonly hint?: string) { super(message); }
}

// `type` is the type in CODE position and `typeShown` the same type as a human reads it.
// They differ only when the per-module pass renamed the type (src/mangle.ts): generated
// code has to name the symbol, and a `@typeStr` baked into program output has to name
// what the programmer wrote.
interface FieldCtx { name: string; type: string; typeShown: string; index: number }

// Every hole the template language has. Kept as one list so the "unknown hole" diagnostic
// can name the alternatives — a template author has no other reference.
const FIELD_HOLES = ["name", "nameStr", "type", "typeStr", "index"];
const HOLES = ["Self", "SelfStr", "count", ...FIELD_HOLES, "fields"];

function tok(kind: TokenKind, value: string, at: Token): Token {
  return { kind, value, line: at.line, col: at.col };
}

// A hole inside a string literal. `"@name=" ` and `"{self.@name}"` are the two spellings
// that make a template readable, and both live inside a single String/FString token, so
// they cannot be reached by the token walk. Longest-name-first so `@nameStr` is not eaten
// as `@name` followed by a stray `Str`.
function substInString(s: string, ctx: FieldCtx | null, selfShown: string, count: number): string {
  return s.replace(/@@|@(SelfStr|Self|nameStr|typeStr|name|type|index|count)\b/g, (whole, hole?: string) => {
    if (whole === "@@") return "@";  // the escape, so a template can emit a literal '@'
    // Inside a string literal EVERY hole is display text (a string is program output,
    // never a symbol reference), so `@Self` and `@SelfStr` mean the same thing here.
    if (hole === "Self" || hole === "SelfStr") return selfShown;
    if (hole === "count") return String(count);
    // NOT left alone: leaving it would compile, print the hole's own spelling, and report
    // nothing — the exact failure the token walk rejects one line away. A template that
    // really wants the text writes '@@name'.
    if (!ctx) {
      throw new DeriveTemplateError(
        `'@${hole}' names a field, but it is not inside a '@fields { … }' block`,
        `wrap it in '@fields { … }' so there is a field for it to name, or write '@@${hole}' for the literal text`);
    }
    if (hole === "name" || hole === "nameStr") return ctx.name;
    if (hole === "type" || hole === "typeStr") return ctx.typeShown;
    if (hole === "index") return String(ctx.index);
    return whole;
  });
}

function lexType(spelling: string, at: Token): Token[] {
  const out = new Lexer(spelling, true).tokenize().filter(t => t.kind !== TokenKind.Eof);
  // Re-stamp the position so a diagnostic inside generated code points at the template,
  // not at column 3 of a one-line string the user never saw.
  return out.map(t => ({ ...t, line: at.line, col: at.col }));
}

// Substitute one pass over `body`. `ctx` is null outside a `@fields` block, which is what
// makes `@name` at the top level an error rather than a silent empty string.
function subst(body: Token[], ctx: FieldCtx | null, self: string, selfShown: string, fields: FieldCtx[], depth: number): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    if (t.kind === TokenKind.String || t.kind === TokenKind.FString) {
      const value = substInString(t.value, ctx, selfShown, fields.length);
      const raw = t.raw === undefined ? undefined : substInString(t.raw, ctx, selfShown, fields.length);
      out.push({ ...t, value, ...(raw !== undefined && { raw }) });
      continue;
    }
    if (t.kind !== TokenKind.At) { out.push(t); continue; }
    // `@@` is the escape for a literal `@` in token position, mirroring the string one.
    if (body[i + 1]?.kind === TokenKind.At) { out.push(t); i++; continue; }
    const next = body[i + 1];
    if (!next || next.kind !== TokenKind.Ident) {
      // `@` with no name is an attribute the template wants to emit verbatim (`@pure`
      // on a generated method reaches here as At + a keyword token). Pass it through.
      out.push(t);
      continue;
    }
    const hole = next.value;
    if (hole === "fields") {
      if (depth > 0) {
        throw new DeriveTemplateError(
          `'@fields' cannot be nested inside another '@fields'`,
          `a struct's fields are one flat list — there is no inner list to repeat over`);
      }
      const open = body[i + 2];
      if (!open || open.kind !== TokenKind.LBrace) {
        throw new DeriveTemplateError(`'@fields' must be followed by a '{ … }' block`);
      }
      let j = i + 3, brace = 1;
      const inner: Token[] = [];
      while (j < body.length && brace > 0) {
        if (body[j]!.kind === TokenKind.LBrace) brace++;
        else if (body[j]!.kind === TokenKind.RBrace && --brace === 0) break;
        inner.push(body[j]!);
        j++;
      }
      if (brace > 0) throw new DeriveTemplateError(`unterminated '@fields' block — no matching '}'`);
      for (const f of fields) out.push(...subst(inner, f, self, selfShown, fields, depth + 1));
      i = j; // the closing brace
      continue;
    }
    if (!HOLES.includes(hole)) {
      // Not a hole at all — an ordinary attribute on a generated declaration. Only
      // reject a name that LOOKS like a hole, so `@pure`/`@inline` still pass through.
      out.push(t);
      continue;
    }
    if (hole === "Self") { out.push(tok(TokenKind.Ident, self, t)); i++; continue; }
    if (hole === "SelfStr") { out.push(tok(TokenKind.String, selfShown, t)); i++; continue; }
    if (hole === "count") { out.push(tok(TokenKind.Int, String(fields.length), t)); i++; continue; }
    if (!ctx) {
      throw new DeriveTemplateError(
        `'@${hole}' names a field, but it is not inside a '@fields { … }' block`,
        `wrap it in '@fields { … }' so there is a field for it to name, or write '@@${hole}' for the literal text`);
    }
    if (hole === "name") out.push(tok(TokenKind.Ident, ctx.name, t));
    else if (hole === "nameStr") out.push(tok(TokenKind.String, ctx.name, t));
    else if (hole === "type") out.push(...lexType(ctx.type, t));
    else if (hole === "typeStr") out.push(tok(TokenKind.String, ctx.typeShown, t));
    else if (hole === "index") out.push(tok(TokenKind.Int, String(ctx.index), t));
    i++;
  }
  return out;
}

// Expand `tpl` for `s` into the impl block a user would have written by hand.
// Throws `DeriveTemplateError` for a template that cannot expand; a parse failure of the
// EXPANDED tokens throws whatever the parser throws, which is what carries the real
// diagnostic (`MILO_DUMP_DERIVES=1` prints the expansion so it can be read).
// `shown` maps a symbol to the name the programmer wrote, for the `@…Str` holes only:
// those end up as string literals in the running program, so a mangled name in one is
// program OUTPUT, not a symbol. Identity when nothing was renamed.
export function expandDeriveTemplate(tpl: DeriveTemplate, s: StructDecl, span?: Span, shown: (n: string) => string = (n) => n): ImplDecl {
  const fields: FieldCtx[] = s.fields.map((f, index) => {
    const type = formatMiloType(f.type);
    return { name: f.name, type, typeShown: shown(type), index };
  });
  const at: Token = { kind: TokenKind.Ident, value: s.name, line: span?.line ?? 1, col: span?.col ?? 1 };
  const inner = subst(tpl.body, null, s.name, shown(s.name), fields, 0);
  const tokens: Token[] = [
    tok(TokenKind.Impl, "impl", at), tok(TokenKind.Ident, tpl.name, at),
    tok(TokenKind.For, "for", at), tok(TokenKind.Ident, s.name, at),
    tok(TokenKind.LBrace, "{", at), ...inner, tok(TokenKind.RBrace, "}", at),
    tok(TokenKind.Eof, "", at),
  ];
  const prog = new Parser(tokens, undefined, span?.file).parse();
  const impl = prog.impls[0];
  if (!impl || prog.impls.length !== 1) {
    throw new DeriveTemplateError(
      `'derive ${tpl.name}' expanded to something that is not a single impl block`,
      `a derive body holds method declarations only`);
  }
  return impl;
}

// The text an expansion would have been, for `MILO_DUMP_DERIVES=1`. Reconstructed from
// tokens rather than kept alongside them: a template has no source text of its own once
// substitution has run, and a stale copy would be worse than none.
export function dumpTokens(tokens: Token[]): string {
  return tokens.map(t => (t.kind === TokenKind.String ? JSON.stringify(t.value) : t.value)).join(" ");
}
