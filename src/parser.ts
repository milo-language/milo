// Recursive-descent parser: token stream -> AST.
import type { Token } from "./tokens";
import { TokenKind } from "./tokens";
import { Lexer, FSTRING_LBRACE, FSTRING_RBRACE } from "./lexer";
import { ParseError } from "./diagnostics";
import type {
  MiloType, Param, Expr, Stmt, Function, Program, StructDecl, StructField,
  EnumDecl, EnumVariant, Pattern, MatchArm, Span, ImportDecl,
  TraitDecl, TraitMethod, ImplDecl, Attribute, TypeAlias, InterfaceDecl, GlobalDecl,
  DeriveTemplate,
} from "./ast";

// Whether an identifier is spelled like a TYPE, which is what tells `Foo { … }` from a
// control-flow brace and `Foo.Bar` from a field access. The test is on the segment after
// the last `$`: a mangled name (`http2$Client`, `gfx$User`) is capitalised at the part
// that names the type, while the prefix is a package or module id. Only compiler-generated
// source can contain one (the lexer rejects `$` in user source), and a derived `Json`
// codec is exactly that: it writes `Result.Ok(gfx$User { … })` for a struct the
// per-module pass had already renamed.
function typeSpelled(name: string): boolean {
  const head = name.charAt(name.lastIndexOf("$") + 1);
  return head >= "A" && head <= "Z";
}

export class Parser {
  private pos = 0;
  private codePointLoopCounter = 0;
  private moduleWrapping = false; // set by a file-level `@!wrapping` directive

  // Builtins that may be written with the `@` sigil in expression position. These
  // are compile-time-only: the compiler, not the runtime, does the work.
  private static SIGIL_BUILTINS = new Set(["embedFile", "targetOs", "targetArch"]);

  // `source`/`filePath` are optional — when provided, thrown ParseErrors carry them
  // so the CLI renders the offending file's source line + caret (essential for errors
  // inside imported files, which would otherwise render against the entry file).
  constructor(private tokens: Token[], private source?: string, private filePath?: string) {}

  private cloneExpr(e: Expr): Expr { return structuredClone(e); }
  // Clamped to the EOF sentinel. A truncated file (`struct P{x:`) lets some
  // production consume EOF as if it were content and walk `pos` past the end;
  // without the clamp the very next lookahead is `undefined.kind`, which reaches
  // the user as a raw TypeError instead of a diagnostic. Every read past the end
  // sees EOF, so the enclosing `expect` reports it properly.
  //
  // `peek` itself needs no bounds test: `advance` below is the only thing that
  // moves `pos`, and it stops on the EOF sentinel, so `pos` is always in range.
  // This is the parser's hottest call — a clamp here costs ~8% of parse time.
  private peek(): Token { return this.tokens[this.pos]!; }
  private peekN(n: number): Token { return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)]!; }
  // adjacent same-kind tokens with no intervening whitespace — used for << and >>
  private atAdjacent(k: TokenKind): boolean {
    const a = this.peek();
    const b = this.peekN(1);
    return a && b && a.kind === k && b.kind === k && a.line === b.line && b.col === a.col + 1;
  }
  // Never advances past EOF, so a loop that keeps consuming on malformed input
  // stalls on the sentinel and hits an `expect` failure instead of running off
  // the array.
  private advance(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }
  private span(tok: Token): Span { return { line: tok.line, col: tok.col, file: this.filePath }; }

  private at(kind: TokenKind): boolean { return this.peek().kind === kind; }

  // `from` and `in` are contextual (soft) keywords: keyword-meaning only in import
  // and for-in position, ordinary identifiers everywhere else (param/var names). The
  // lexer emits them as Ident; these check the keyword role by text.
  private atSoftKw(kw: string): boolean {
    const t = this.peek();
    return t.kind === TokenKind.Ident && t.value === kw;
  }
  private expectSoftKw(kw: string): Token {
    const tok = this.peek();
    if (tok.kind === TokenKind.Ident && tok.value === kw) return this.advance();
    this.error(`expected '${kw}', got '${tok.kind}' ('${tok.value}')`, tok);
  }

  // Whether a token can begin a top-level declaration — the lookahead that lets `pub`
  // stay a soft keyword. Deliberately includes forms `pub` may NOT mark (impl, import):
  // consuming the `pub` there yields a diagnostic naming the real rule, instead of a
  // bare "expected declaration" pointing at the `pub` itself.
  private startsDecl(t: Token): boolean {
    switch (t.kind) {
      case TokenKind.Struct: case TokenKind.Enum: case TokenKind.Extern:
      case TokenKind.Fn: case TokenKind.Trait: case TokenKind.Impl:
      case TokenKind.Type: case TokenKind.Interface: case TokenKind.Let:
      case TokenKind.Var: case TokenKind.Unsafe: case TokenKind.Import:
        return true;
      case TokenKind.Ident:
        return t.value === "thread_local" || t.value === "from" || t.value === "derive";
      default:
        return false;
    }
  }

  private match(kind: TokenKind): Token | null {
    if (this.at(kind)) return this.advance();
    return null;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.advance();
    if (tok.kind !== kind) this.error(`expected '${kind}', got '${tok.kind}' ('${tok.value}')`, tok, kind);
    return tok;
  }

  // Throw a parse error carrying a structured Diagnostic (span + message + hint).
  // `expected`, when given, drives a precise "expected X" hint; a ';' reaching here
  // is mid-expression (trailing/separating ';' is tolerated in parseStmts), so the
  // hint reflects that ';' is a statement separator, not valid inside an expression.
  private error(msg: string, tok: Token, expected?: TokenKind, hintOverride?: string): never {
    let hint = hintOverride;
    if (hint === undefined) {
      if (tok.kind === TokenKind.Semicolon) {
        hint = "';' separates statements and can't appear inside an expression — remove it";
      } else if (expected !== undefined) {
        hint = `expected '${expected}' here`;
      }
    }
    throw new ParseError({
      severity: "error",
      span: { line: tok.line, col: tok.col, file: this.filePath },
      message: msg,
      hint,
      code: "parse",
    }, this.source, this.filePath);
  }

  parse(): Program {
    const structs: StructDecl[] = [];
    const enums: EnumDecl[] = [];
    const functions: Function[] = [];
    const imports: ImportDecl[] = [];
    const traits: TraitDecl[] = [];
    const impls: ImplDecl[] = [];
    const typeAliases: TypeAlias[] = [];
    const interfaces: InterfaceDecl[] = [];
    const globals: GlobalDecl[] = [];
    const deriveTemplates: DeriveTemplate[] = [];
    while (!this.at(TokenKind.Eof)) {
      // trailing ';' after a top-level decl is a cosmetic no-op (see parseStmts)
      if (this.match(TokenKind.Semicolon)) continue;
      // collect attributes before struct/enum; `@!wrapping` is an inner (file-level)
      // directive, not a decl attribute — consume it separately so it never attaches.
      let attrs: Attribute[] | undefined;
      while (this.at(TokenKind.At)) {
        const a = this.parseAttribute();
        if (a.inner) {
          if (a.name !== "wrapping") this.error(`unknown module directive '@!${a.name}' — only '@!wrapping' is supported`, this.peek());
          else if (a.args.length > 0) this.error(`'@!wrapping' takes no arguments`, this.peek());
          else this.moduleWrapping = true;
          continue;
        }
        if (!attrs) attrs = [];
        attrs.push(a);
      }
      // `pub` is a soft keyword, not reserved: it only marks visibility when a
      // declaration actually follows, so a variable or fn named `pub` still parses
      // as an ordinary identifier. Same lookahead trick as `from` below.
      const pubTok = this.atSoftKw("pub") && this.startsDecl(this.peekN(1)) ? this.advance() : undefined;
      // `from` is an import only when followed by the path string; otherwise it's an
      // ordinary identifier (e.g. a top-level binding), so let it fall through.
      if (this.at(TokenKind.Import) || (this.atSoftKw("from") && this.peekN(1).kind === TokenKind.String)) {
        if (pubTok) this.error("'pub' cannot mark an import — it applies to declarations, and an import is not re-exported", pubTok);
        imports.push(this.parseImport());
      } else if (this.at(TokenKind.Struct)) {
        const s = this.parseStruct();
        if (attrs) s.attributes = attrs;
        s.isPub = !!pubTok;
        structs.push(s);
      } else if (this.at(TokenKind.Enum)) {
        const e = this.parseEnum();
        if (attrs) e.attributes = attrs;
        e.isPub = !!pubTok;
        enums.push(e);
      } else if (this.at(TokenKind.Extern)) {
        const nextTok = this.tokens[this.pos + 1];
        if (nextTok && nextTok.kind === TokenKind.Struct) {
          const s = this.parseExternStruct();
          if (attrs) s.attributes = attrs;
          s.isPub = !!pubTok;
          structs.push(s);
        } else if (nextTok && nextTok.kind === TokenKind.Type) {
          const s = this.parseExternType();
          s.isPub = !!pubTok;
          structs.push(s);
        } else {
          const f = this.parseExternFn();
          if (attrs) f.attributes = attrs;
          f.isPub = !!pubTok;
          functions.push(f);
        }
      } else if (this.at(TokenKind.Fn)) {
        const f = this.parseFn(!!attrs?.some(a => a.name === "externalLinkage"));
        if (attrs) f.attributes = attrs;
        f.isPub = !!pubTok;
        functions.push(f);
      } else if (this.at(TokenKind.Trait)) {
        const t = this.parseTraitDecl();
        t.isPub = !!pubTok;
        traits.push(t);
      } else if (this.at(TokenKind.Impl)) {
        if (pubTok) this.error("'pub' cannot mark an impl block — an impl's visibility follows the type it implements", pubTok);
        impls.push(this.parseImplDecl());
      } else if (this.at(TokenKind.Unsafe) && this.peekN(1).kind === TokenKind.Impl) {
        if (pubTok) this.error("'pub' cannot mark an impl block — an impl's visibility follows the type it implements", pubTok);
        this.advance();
        impls.push(this.parseImplDecl(true));
      } else if (this.at(TokenKind.Type)) {
        const t = this.parseTypeAlias();
        t.isPub = !!pubTok;
        typeAliases.push(t);
      } else if (this.at(TokenKind.Interface)) {
        const i = this.parseInterfaceDecl();
        i.isPub = !!pubTok;
        interfaces.push(i);
      } else if (this.at(TokenKind.Let) || this.at(TokenKind.Var)) {
        const g = this.parseGlobalDecl();
        if (attrs) g.attributes = attrs;
        g.isPub = !!pubTok;
        globals.push(g);
      } else if (this.atSoftKw("derive")
                 && this.peekN(1).kind === TokenKind.Ident && this.peekN(2).kind === TokenKind.LBrace) {
        // Contextual, not a keyword: `derive` stays a legal identifier, and the three-token
        // lookahead is what distinguishes the declaration from `derive(x)` or `let derive = …`.
        const d = this.parseDeriveTemplate();
        d.isPub = !!pubTok;
        deriveTemplates.push(d);
      } else if (this.at(TokenKind.Ident) && this.peek().value === "thread_local") {
        const g = this.parseGlobalDecl();
        if (attrs) g.attributes = attrs;
        g.isPub = !!pubTok;
        globals.push(g);
      } else {
        this.error(`expected declaration, got '${this.peek().kind}'`, this.peek());
      }
    }
    // Injected only when a `for .. in ..codePoints()` desugar actually fired.
    // Putting it in the prelude instead would cost every program the parse and
    // check of std/unicode (~10ms on a trivial build) to serve a rare construct.
    if (this.codePointLoopCounter > 0 && !imports.some(i => i.path === "std/unicode")) {
      imports.push({ kind: "ImportDecl", path: "std/unicode", names: ["CodePoint", "decodeCodepoint"] });
    }
    // A file-level `@!wrapping` stamps every one of this module's own (non-extern) fns so it
    // lowers as modular. Kept off `attributes` so the formatter reprints the directive once,
    // not `@wrapping` on every fn. Per-file: only fns parsed here, never imported ones.
    if (this.moduleWrapping) {
      for (const f of functions) if (!f.isExtern) f.fromWrappingModule = true;
    }
    return { structs, enums, functions, imports, traits, impls, typeAliases, interfaces, globals, deriveTemplates, ...(this.moduleWrapping && { moduleWrapping: true }) };
  }

  private parseImport(): ImportDecl {
    if (this.atSoftKw("from")) {
      const tok = this.advance();
      const pathTok = this.expect(TokenKind.String);
      this.expect(TokenKind.Import);
      // from "path" import { a, b, c }
      this.expect(TokenKind.LBrace);
      const names: string[] = [];
      const aliases: (string | undefined)[] = [];
      let anyAlias = false;
      while (!this.at(TokenKind.RBrace)) {
        names.push(this.expect(TokenKind.Ident).value);
        // `import { foo as bar }` — bind the exported `foo` under local name `bar`.
        // `as` is already a soft keyword (cast); reuse it here in import position.
        if (this.match(TokenKind.As)) {
          aliases.push(this.expect(TokenKind.Ident).value);
          anyAlias = true;
        } else {
          aliases.push(undefined);
        }
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RBrace);
      return { kind: "ImportDecl", path: pathTok.value, names, aliases: anyAlias ? aliases : undefined, span: { line: tok.line, col: tok.col, file: this.filePath } };
    }
    // bare import "path" → error with hint
    if (this.at(TokenKind.Import)) {
      const tok = this.advance();
      const pathTok = this.expect(TokenKind.String);
      this.error(`use 'from "${pathTok.value}" import { ... }'`, tok);
    }
    this.error("expected 'from' import declaration", this.peek());
  }

  // ── Types ──

  // `allowNullableRef` is true ONLY at the top level of a parameter type in an `extern` /
  // `@externalLinkage` fn signature. Every recursive call below leaves it at its default, so
  // `Vec<?&mut T>`, `(?&mut T) => R`, `[?&mut T; 2]` and a `?&mut T` return type are all
  // rejected here rather than needing a rule in the checker: the flag cannot reach any
  // position the ownership model does not already permit a `&mut T` in.
  private parseType(allowNullableRef = false): MiloType {
    // Bail before the fallback `advance()` below can accept EOF as a type name.
    // Several callers loop until a closing delimiter they will never see in a
    // truncated file, and a parseType that returns without consuming would spin.
    if (this.at(TokenKind.Eof)) this.error("expected a type, but the file ended here", this.peek());
    // ?&T or ?&mut T — the nullable extern reference. Prefix, unlike the postfix `T?`
    // (Option sugar) below and the postfix propagate operator in expression position, so
    // there is no ambiguity with either: no other type may begin with '?'.
    if (this.at(TokenKind.Question)) {
      const q = this.advance();
      if (!this.at(TokenKind.Amp)) {
        this.error("expected '&' or '&mut' after '?'", q, undefined,
          "'?&mut T' is the nullable extern reference; an optional value is spelled 'T?' or 'Option<T>'");
      }
      const inner = this.parseType();
      if (!allowNullableRef) {
        this.error("'?&mut T' is only legal on a parameter of an 'extern' or '@externalLinkage' function", q, undefined,
          "it is a signature spelling for a C 'T *', not a type: it cannot name a local, a field, a return type, a closure parameter or a type argument");
      }
      // Anything but a plain `&T`/`&mut T` has no one-pointer C spelling, which is the
      // whole content of the feature. A slice is a fat value, a `*T` is already nullable.
      if (!inner.isRef && !inner.isRefMut) this.error("'?' must be followed by '&T' or '&mut T'", q);
      if (inner.isArray) this.error("'?&[T]' is not a nullable extern reference: a slice is a fat (ptr, len) value, not one pointer", q);
      if (inner.isPtr || inner.isFn || inner.typeArgs?.length) {
        this.error("'?&' takes a plain named type: '?&mut GifFileType'", q);
      }
      return { ...inner, isNullableRef: true };
    }
    // &T or &mut T
    if (this.match(TokenKind.Amp)) {
      const isMut = !!this.match(TokenKind.Mut);
      const inner = this.parseType();
      return { ...inner, isRef: !isMut, isRefMut: isMut };
    }
    // *T — count nesting so `**u8` is depth 2, not a collapsed single level.
    // `char***` (depth 3, e.g. _NSGetEnviron) is real; only guard against runaway
    // typos like `********…`. 16 is far past any legitimate use (C99 requires ≥12).
    if (this.at(TokenKind.Star)) {
      const star = this.advance();
      const inner = this.parseType();
      const depth = (inner.ptrDepth ?? (inner.isPtr ? 1 : 0)) + 1;
      if (depth > 16) this.error(`pointer nesting too deep (${depth}); max is 16`, star);
      return { ...inner, isPtr: true, ptrDepth: depth };
    }
    // [T] or [T; N]
    if (this.at(TokenKind.LBracket)) {
      const lb = this.peek();
      this.match(TokenKind.LBracket);
      const inner = this.parseType();
      let arraySize: number | null = null;
      if (this.match(TokenKind.Semicolon)) {
        arraySize = parseInt(this.expect(TokenKind.Int).value);
      }
      this.expect(TokenKind.RBracket);
      // `MiloType` carries ONE `isArray` flag, so an array OF an array has nowhere to
      // record the inner one. This used to build the type from `inner.name` alone, which
      // silently dropped it: `var g: [[i64; 2]; 2] = [1, 2]` was ACCEPTED and `g` was an
      // `[i64; 2]`. The annotation meant something the writer never asked for, and the
      // mismatch surfaced far away as invalid LLVM IR when a nested literal was stored
      // into a flat slot. Say it instead.
      if (inner.isArray) {
        this.error(`a nested fixed array '[[T; N]; M]' is not supported: use 'Vec<[T; N]>' or 'Vec<Vec<T>>'`, lb);
      }
      // Same shape, different modifier: `[&string; 2]` silently became `[string; 2]`, an
      // OWNED array. References are second-class and cannot be stored, so an array of
      // them is not expressible at all.
      if (inner.isRef || inner.isRefMut) {
        this.error(`an array of references is not expressible: '&T' is second-class and cannot be stored, so '[&T; N]' has no representation`, lb);
      }
      // Spread rather than rebuild from `name`: this also carries `typeArgs`, which the
      // old form dropped, so `[Vec<i64>; 2]` lost its element type and reported the
      // baffling "cannot infer Vec element type" against an annotation that stated it.
      return { ...inner, isArray: true, arraySize };
    }
    // extern (T1, T2) => R — a C function pointer, e.g. the result of dlsym
    if (this.at(TokenKind.Extern)) {
      this.advance();
      const cf = this.parseType();
      if (!cf.isFn) this.error("expected a function type after 'extern'", this.peek());
      return { ...cf, isCFn: true };
    }
    // move (T1, T2) => R — an owning closure. Same keyword as the closure EXPRESSION
    // form (`move(): void => {…}`) because it marks the same thing on both sides: this
    // value took ownership of what it captured.
    if (this.at(TokenKind.Move)) {
      this.advance();
      const inner = this.parseType();
      if (!inner.isFn) this.error("expected a function type after 'move'", this.peek());
      return { ...inner, isMoveFn: true };
    }
    // (T1, T2) => R
    if (this.at(TokenKind.LParen) && this.isFnType()) {
      this.advance();
      const fnParams: MiloType[] = [];
      while (!this.at(TokenKind.RParen)) {
        fnParams.push(this.parseType());
        if (!this.at(TokenKind.RParen)) this.expect(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
      this.expect(TokenKind.FatArrow);
      const fnRet = this.parseType();
      return { name: "fn", isFn: true, fnParams, fnRet, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    const tok = this.advance();
    let typeArgs: MiloType[] | undefined;
    if (this.at(TokenKind.Lt)) {
      this.advance();
      typeArgs = [this.parseType()];
      while (this.match(TokenKind.Comma)) {
        typeArgs.push(this.parseType());
      }
      this.expect(TokenKind.Gt);
    }
    let result: MiloType = { name: tok.value, typeArgs, isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    // i32(0..50000) — range constraint on integer types (must be on same line to avoid ambiguity)
    if (this.at(TokenKind.LParen) && !typeArgs && this.peek().line === tok.line) {
      const isIntType = /^[iu]\d+$|^int$|^byte$/.test(tok.value);
      if (isIntType) {
        this.advance(); // consume (
        let negative = false;
        if (this.match(TokenKind.Minus)) negative = true;
        const minTok = this.expect(TokenKind.Int);
        const rangeMin = (negative ? -1 : 1) * parseInt(minTok.value);
        this.expect(TokenKind.DotDot);
        negative = false;
        if (this.match(TokenKind.Minus)) negative = true;
        const maxTok = this.expect(TokenKind.Int);
        const rangeMax = (negative ? -1 : 1) * parseInt(maxTok.value);
        this.expect(TokenKind.RParen);
        result.rangeMin = rangeMin;
        result.rangeMax = rangeMax;
      }
    }
    // T? desugars to Option<T>
    if (this.match(TokenKind.Question)) {
      result = { name: "Option", typeArgs: [result], isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    }
    return result;
  }

  // ── Type Alias ──

  private parseTypeAlias(): TypeAlias {
    const tok = this.expect(TokenKind.Type);
    const name = this.expect(TokenKind.Ident).value;
    // The same `<T, U>` a struct or fn declares. Bounds parse here because the shared
    // parser accepts them, and the checker rejects them: an alias is expanded rather
    // than instantiated, so there is no body whose uses a bound could be checked against.
    const typeParams = this.parseTypeParams();
    this.expect(TokenKind.Eq);
    const type = this.parseType();
    return { kind: "TypeAlias", name, ...(typeParams.length ? { typeParams } : {}), type, span: this.span(tok) };
  }

  // ── Struct ──

  private parseStruct(): StructDecl {
    const start = this.peek();
    this.expect(TokenKind.Struct);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenKind.LBrace);
    const fields: StructField[] = [];
    while (!this.at(TokenKind.RBrace)) {
      // Parsed here even though only `extern struct` fields can carry one: rejecting a
      // field attribute in the grammar would report `expected IDENT, got '@'`, when the
      // checker can say which attribute and why it doesn't belong.
      const fieldAttrs = this.parseFieldAttributes();
      const fieldName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Colon);
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType, ...(fieldAttrs ? { attributes: fieldAttrs } : {}) });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    // Trailing `invariant`/`decreases` clauses — the same position a fn's contracts occupy
    // relative to its signature. `decreases` is meaningless on a type; the checker rejects it
    // rather than the grammar, so the error names the clause instead of the token.
    const invariants = this.parseContracts();
    return { kind: "StructDecl", name, typeParams, fields, span: this.span(start), ...(invariants.length > 0 && { invariants }) };
  }

  // ── Enum ──

  private parseEnum(): EnumDecl {
    this.expect(TokenKind.Enum);
    const nameTok = this.expect(TokenKind.Ident);
    const name = nameTok.value;
    const typeParams = this.parseTypeParams();
    // `enum Kind: i32 { ... }` — an integer-repr'd (C-like) enum. The repr type is an int
    // sort name; the checker rejects payload-carrying variants on such an enum.
    let reprType: string | undefined;
    if (this.match(TokenKind.Colon)) reprType = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LBrace);
    const variants: EnumVariant[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const variantName = this.expect(TokenKind.Ident).value;
      const fields: MiloType[] = [];
      if (this.match(TokenKind.LParen)) {
        while (!this.at(TokenKind.RParen)) {
          fields.push(this.parseType());
          this.match(TokenKind.Comma);
        }
        this.expect(TokenKind.RParen);
      }
      // Optional explicit discriminant `= N` (repr'd enums only; enforced in the checker).
      // Supports sparse/non-contiguous values (`LDA = 169`), which is why tryFrom is generated.
      let discriminant: number | undefined;
      if (this.match(TokenKind.Eq)) {
        const neg = !!this.match(TokenKind.Minus);
        const numTok = this.expect(TokenKind.Int);
        discriminant = (neg ? -1 : 1) * parseInt(numTok.value.replace(/_/g, ""), 10);
      }
      variants.push({ name: variantName, fields, ...(discriminant !== undefined && { discriminant }) });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "EnumDecl", name, typeParams, variants, ...(reprType && { reprType }), span: { line: nameTok.line, col: nameTok.col, file: this.filePath } };
  }

  // ── Functions ──

  private parseParam(allowNullableRef = false): Param {
    this.rejectRustReceiver();
    const nameTok = this.expect(TokenKind.Ident);
    const name = nameTok.value;
    this.expect(TokenKind.Colon);
    const type = this.parseType(allowNullableRef);
    return { name, type, span: this.span(nameTok) };
  }

  // `&self`, `&mut self` and a bare `self` are the Rust receiver spellings. Milo's only
  // receiver form is an ordinary typed parameter (`self: &Self` etc.), so a Rust reflex
  // gets the exact replacement instead of "expected 'IDENT', got '&'".
  private rejectRustReceiver(): void {
    const tok = this.peek();
    const next = this.tokens[this.pos + 1];
    const next2 = this.tokens[this.pos + 2];
    const isSelf = (t: Token | undefined) => t?.kind === TokenKind.Ident && t.value === "self";
    if (tok.kind === TokenKind.Amp && isSelf(next)) {
      this.error(`Milo has no '&self' receiver`, tok, undefined, `write 'self: &Self'`);
    }
    if (tok.kind === TokenKind.Amp && next?.kind === TokenKind.Mut && isSelf(next2)) {
      this.error(`Milo has no '&mut self' receiver`, tok, undefined, `write 'self: &mut Self'`);
    }
    if (isSelf(tok) && next?.kind !== TokenKind.Colon) {
      this.error(`Milo has no bare 'self' receiver`, tok, undefined, `write 'self: Self'`);
    }
  }

  private parseParamList(allowNullableRef = false): { params: Param[]; variadic: boolean } {
    this.expect(TokenKind.LParen);
    const params: Param[] = [];
    let variadic = false;
    while (!this.at(TokenKind.RParen)) {
      if (this.at(TokenKind.DotDotDot)) {
        this.advance();
        variadic = true;
        break;
      }
      params.push(this.parseParam(allowNullableRef));
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    return { params, variadic };
  }

  private parseReturnType(): MiloType {
    if (this.match(TokenKind.Colon)) return this.parseType();
    return { name: "void", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
  }

  private parseExternFn(): Function {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Fn);
    const nameTok = this.expect(TokenKind.Ident);
    const name = nameTok.value;
    const { params, variadic } = this.parseParamList(true);
    const retType = this.parseReturnType();
    return { kind: "Function", name, typeParams: [], params, retType, contracts: [], body: [], isExtern: true, isVariadic: variadic, span: this.span(nameTok) };
  }

  private parseExternType(): StructDecl {
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Type);
    const name = this.expect(TokenKind.Ident).value;
    return { kind: "StructDecl", name, typeParams: [], fields: [], isExtern: true, isOpaque: true };
  }

  private parseExternStruct(): StructDecl {
    const start = this.peek();
    this.expect(TokenKind.Extern);
    this.expect(TokenKind.Struct);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    if (typeParams.length > 0) this.error(`extern structs cannot have type parameters`, this.peek());
    this.expect(TokenKind.LBrace);
    const fields: StructField[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const fieldAttrs = this.parseFieldAttributes();
      const fieldName = this.expect(TokenKind.Ident).value;
      this.expect(TokenKind.Colon);
      const fieldType = this.parseType();
      fields.push({ name: fieldName, type: fieldType, ...(fieldAttrs ? { attributes: fieldAttrs } : {}) });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "StructDecl", name, typeParams: [], fields, isExtern: true, span: this.span(start) };
  }

  // `externalLinkage` is decided by the caller, which is the only place the decl's
  // attributes have been read yet: `@externalLinkage` publishes a C symbol, so its
  // parameters may carry the `?&mut T` spelling that an ordinary Milo fn may not.
  private parseFn(externalLinkage = false): Function {
    this.expect(TokenKind.Fn);
    const nameTok = this.expect(TokenKind.Ident);
    const name = nameTok.value;
    const typeParams = this.parseTypeParams();
    const { params, variadic } = this.parseParamList(externalLinkage);
    const retType = this.parseReturnType();
    const contracts = this.parseContracts();
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "Function", name, typeParams, params, retType, contracts, body, isExtern: false, isVariadic: variadic, span: this.span(nameTok) };
  }

  private parseContracts(): import("./ast").Contract[] {
    const contracts: import("./ast").Contract[] = [];
    while (this.at(TokenKind.Requires) || this.at(TokenKind.Ensures)
        || this.at(TokenKind.Invariant) || this.at(TokenKind.Decreases)) {
      const s = this.span(this.peek());
      const kind = this.advance().value as "requires" | "ensures" | "invariant" | "decreases";
      const expr = this.parseExpr();
      contracts.push({ kind, expr, span: s });
    }
    return contracts;
  }

  private parseTypeParams(): import("./ast").TypeParam[] {
    const typeParams: import("./ast").TypeParam[] = [];
    if (this.match(TokenKind.Lt)) {
      typeParams.push(this.parseOneTypeParam());
      while (this.match(TokenKind.Comma)) {
        typeParams.push(this.parseOneTypeParam());
      }
      this.expect(TokenKind.Gt);
    }
    return typeParams;
  }

  private parseOneTypeParam(): import("./ast").TypeParam {
    const name = this.expect(TokenKind.Ident).value;
    const bounds: string[] = [];
    if (this.match(TokenKind.Colon)) {
      bounds.push(this.expect(TokenKind.Ident).value);
      while (this.match(TokenKind.Plus)) {
        bounds.push(this.expect(TokenKind.Ident).value);
      }
    }
    return { name, bounds };
  }

  // Attributes preceding a struct field — `@cOpaque` marks C-invisible padding.
  private parseFieldAttributes(): Attribute[] | undefined {
    let attrs: Attribute[] | undefined;
    while (this.at(TokenKind.At)) {
      if (!attrs) attrs = [];
      attrs.push(this.parseAttribute());
    }
    return attrs;
  }

  private parseAttribute(): Attribute {
    const at = this.expect(TokenKind.At);
    // `@!name` — an inner attribute (Rust `#![...]` analog) applies to the whole file, not
    // the next decl. The '!' must hug the '@' just like the name does.
    let inner = false;
    if (this.at(TokenKind.Bang) && this.peek().line === at.line && this.peek().col === at.col + 1) {
      this.advance();
      inner = true;
    }
    // The name must hug the '@' (or the '!') — `@derive`, not `@ derive`. Whitespace between
    // them is a mistake, not insignificant spacing, so reject it up front.
    const nameTok = this.peek();
    const expectedCol = at.col + (inner ? 2 : 1); // '@name' vs '@!name'
    // Attribute names live in their own namespace, so a keyword may name one: `@unsafe`
    // is the natural spelling for "calling this needs an unsafe block", and `unsafe`
    // lexes as a keyword rather than an Ident, so it would otherwise be unspellable.
    const isNameTok = nameTok.kind === TokenKind.Ident || nameTok.kind === TokenKind.Unsafe;
    if (isNameTok && (nameTok.line !== at.line || nameTok.col !== expectedCol)) {
      this.error(
        `no whitespace allowed between '${inner ? "@!" : "@"}' and attribute name — write '${inner ? "@!" : "@"}${nameTok.value}'`,
        nameTok, undefined, `attributes bind tightly: '@derive(...)', not '@ derive(...)'`,
      );
    }
    const name = this.at(TokenKind.Unsafe) ? this.advance().value : this.expect(TokenKind.Ident).value;
    const args: string[] = [];
    const argKinds: ("ident" | "string")[] = [];
    if (this.match(TokenKind.LParen)) {
      this.parseAttributeArg(args, argKinds);
      while (this.match(TokenKind.Comma)) {
        this.parseAttributeArg(args, argKinds);
      }
      this.expect(TokenKind.RParen);
    }
    return { name, args, argKinds, ...(inner && { inner: true }) };
  }

  private parseAttributeArg(args: string[], argKinds: ("ident" | "string")[]): void {
    if (this.at(TokenKind.String)) {
      args.push(this.advance().value);
      argKinds.push("string");
      return;
    }
    args.push(this.expect(TokenKind.Ident).value);
    argKinds.push("ident");
  }

  // `derive <Trait> { <impl methods> }` — a user-defined `@derive(Trait)`.
  //
  // The body is captured as TOKENS and never parsed here. A template is not code: `@name`
  // in expression position has no meaning until a field name is substituted for it, so
  // parsing it eagerly could only fail. Brace depth is counted over LBrace/RBrace tokens,
  // which is exact — an interpolated string is ONE token, so a `{` inside it cannot
  // unbalance the scan.
  private parseDeriveTemplate(): DeriveTemplate {
    const kw = this.advance(); // `derive`
    const nameTok = this.expect(TokenKind.Ident);
    const open = this.expect(TokenKind.LBrace);
    const body: Token[] = [];
    let depth = 1;
    while (true) {
      if (this.at(TokenKind.Eof)) {
        this.error(`unterminated 'derive ${nameTok.value}' block — no matching '}'`, open);
      }
      if (this.at(TokenKind.LBrace)) depth++;
      else if (this.at(TokenKind.RBrace)) {
        depth--;
        if (depth === 0) { this.advance(); break; }
      }
      body.push(this.advance());
    }
    return {
      kind: "DeriveTemplate", name: nameTok.value, body,
      span: { line: kw.line, col: kw.col, file: this.filePath },
    };
  }

  private parseTraitDecl(): TraitDecl {
    const tok = this.expect(TokenKind.Trait);
    const name = this.expect(TokenKind.Ident).value;
    const typeParams = this.parseTypeParams();
    const supertraits: string[] = [];
    if (this.match(TokenKind.Colon)) {
      supertraits.push(this.expect(TokenKind.Ident).value);
      while (this.match(TokenKind.Plus)) {
        supertraits.push(this.expect(TokenKind.Ident).value);
      }
    }
    this.expect(TokenKind.LBrace);
    const methods: TraitMethod[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      methods.push(this.parseTraitMethod());
    }
    this.expect(TokenKind.RBrace);
    return { kind: "TraitDecl", name, typeParams, supertraits, methods, span: this.span(tok) };
  }

  private parseTraitMethod(isInterface = false): TraitMethod {
    const tok = this.expect(TokenKind.Fn);
    const name = this.expect(TokenKind.Ident).value;
    // The method's own type parameters. Rejected for an interface, whose dispatch is a
    // vtable: a generic method has one address per instantiation and no slot can hold them.
    const typeParams = this.parseTypeParams();
    if (typeParams.length > 0 && isInterface) {
      this.error(`interface method '${name}' cannot take type parameters — an interface dispatches through a vtable, and a generic method has one address per instantiation`, tok);
    }
    const { params } = this.parseParamList();
    const retType = this.parseReturnType();
    let body: Stmt[] | null = null;
    if (this.at(TokenKind.LBrace)) {
      this.advance();
      body = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    return { name, ...(typeParams.length > 0 && { typeParams }), params, retType, body, span: this.span(tok) };
  }

  private parseInterfaceDecl(): InterfaceDecl {
    const tok = this.expect(TokenKind.Interface);
    const name = this.expect(TokenKind.Ident).value;
    this.expect(TokenKind.LBrace);
    const methods: TraitMethod[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      methods.push(this.parseTraitMethod(true));
    }
    this.expect(TokenKind.RBrace);
    return { kind: "InterfaceDecl", name, methods, span: this.span(tok) };
  }

  private parseImplDecl(isUnsafe = false): ImplDecl {
    const tok = this.expect(TokenKind.Impl);
    const firstName = this.expect(TokenKind.Ident).value;
    let traitName: string | null = null;
    let typeName: string;
    const leadingTypeParams = this.parseTypeParams();
    let typeParams = leadingTypeParams;
    if (this.match(TokenKind.For)) {
      traitName = firstName;
      typeName = this.expect(TokenKind.Ident).value;
      const targetTypeParams = this.parseTypeParams();
      if (targetTypeParams.length > 0) typeParams = targetTypeParams;
    } else {
      typeName = firstName;
    }
    this.expect(TokenKind.LBrace);
    const methods: Function[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      // Methods take the same attributes as free fns (`@pure`, `@wrapping`). An `@!`
      // directive is file-scoped and has no meaning here, so reject it rather than
      // silently attaching it to the method.
      let attrs: Attribute[] | undefined;
      while (this.at(TokenKind.At)) {
        const a = this.parseAttribute();
        if (a.inner) {
          this.error(`'@!${a.name}' is a module directive — it applies to a whole file, not a method`, this.peek(),
            undefined, `move it to the top of the file`);
          continue;
        }
        if (!attrs) attrs = [];
        attrs.push(a);
      }
      const m = this.parseFn();
      if (attrs) m.attributes = attrs;
      methods.push(m);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "ImplDecl", traitName, typeName, typeParams, methods, isUnsafe, span: this.span(tok) };
  }

  // ── Statements ──

  private parseStmts(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.at(TokenKind.RBrace) && !this.at(TokenKind.Eof)) {
      // ';' is cosmetic in Milo — statements are newline/grammar-delimited, so a
      // trailing (or same-line separating, or empty) ';' is a no-op. Tolerated at
      // boundaries only; a ';' inside an expression still errors in parseExpr.
      if (this.match(TokenKind.Semicolon)) continue;
      // A destructuring `let { a, b } = e` is several bindings; see parseDestructure.
      if ((this.at(TokenKind.Let) || this.at(TokenKind.Var)) && this.tokens[this.pos + 1]?.kind === TokenKind.LBrace) {
        stmts.push(...this.parseDestructure());
        continue;
      }
      stmts.push(this.parseStmt());
    }
    return stmts;
  }

  // `let { a, b: y } = e` / `var { … } = e`: bind fields of a struct value by name.
  // Desugared here, not a new statement kind: `let a = <place>.a` when the value is a
  // place (a partial move that leaves the other fields usable, exactly as writing it by
  // hand does), else the value goes into a hidden local first and each binding reads a
  // field of it, so the checker's move, borrow, Copy and Drop rules apply unchanged
  // (a field of a `Drop` struct cannot be moved out, a non-Copy field of a `&S` is a
  // move out of a borrow). The hidden local's unlisted fields drop with the block.
  private destructureCount = 0;
  private parseDestructure(): Stmt[] {
    const kw = this.advance();
    const mutable = kw.kind === TokenKind.Var;
    const s = this.span(kw);
    this.expect(TokenKind.LBrace);
    const fields: { field: string; name: string; span: Span }[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const fieldTok = this.expect(TokenKind.Ident);
      let name = fieldTok.value;
      if (this.match(TokenKind.Colon)) name = this.expect(TokenKind.Ident).value;
      fields.push({ field: fieldTok.value, name, span: this.span(fieldTok) });
      if (!this.at(TokenKind.RBrace)) this.expect(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    if (fields.length === 0) this.error(`'${kw.value} { }' binds nothing — name the fields to take`, kw);
    if (this.at(TokenKind.Colon)) this.error(`a destructuring binding takes no type annotation — the type is the value's`, this.peek());
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    const out: Stmt[] = [];
    let source: Expr;
    if (value.kind === "Ident" || value.kind === "FieldAccess" || value.kind === "IndexAccess") {
      source = value;
    } else {
      const tmp = `_destructure${this.destructureCount++}`;
      out.push({ kind: "LetDecl", name: tmp, type: null, value, span: s });
      source = { kind: "Ident", name: tmp, span: s };
    }
    for (const f of fields) {
      const read: Expr = { kind: "FieldAccess", object: source, field: f.field, span: f.span };
      out.push(mutable
        ? { kind: "VarDecl", name: f.name, type: null, value: read, span: f.span }
        : { kind: "LetDecl", name: f.name, type: null, value: read, span: f.span });
    }
    return out;
  }

  private parseStmt(): Stmt {
    if (this.at(TokenKind.Let)) return this.parseLet();
    if (this.at(TokenKind.Var)) return this.parseVar();
    if (this.at(TokenKind.Return)) return this.parseReturn();
    if (this.at(TokenKind.If)) return this.parseIf();
    if (this.at(TokenKind.While)) return this.parseWhile();
    if (this.at(TokenKind.For)) return this.parseFor();
    if (this.at(TokenKind.Match)) return this.parseMatch();
    if (this.at(TokenKind.Break)) { const s = this.span(this.advance()); return { kind: "BreakStmt", span: s }; }
    if (this.at(TokenKind.Continue)) { const s = this.span(this.advance()); return { kind: "ContinueStmt", span: s }; }
    if (this.at(TokenKind.Unsafe)) {
      const s = this.span(this.advance());
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      return { kind: "UnsafeBlock", body, span: s };
    }

    const expr = this.parseExpr();
    // assignment: x = ..., x.field = ..., x[i] = ...
    if (this.at(TokenKind.Eq)) {
      this.advance();
      const value = this.parseExpr();
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    // compound assignment: x += ..., x -= ..., etc.
    const compoundOps: Record<string, string> = {
      [TokenKind.PlusEq]: "+", [TokenKind.MinusEq]: "-",
      [TokenKind.StarEq]: "*", [TokenKind.SlashEq]: "/", [TokenKind.PercentEq]: "%",
      [TokenKind.AmpEq]: "&", [TokenKind.PipeEq]: "|", [TokenKind.CaretEq]: "^",
    };
    const op = compoundOps[this.peek().kind];
    if (op) {
      this.advance();
      const rhs = this.parseExpr();
      const value: Expr = { kind: "BinOp", op, left: this.cloneExpr(expr), right: rhs, span: expr.span };
      return { kind: "Assign", target: expr, value, span: expr.span };
    }
    return { kind: "ExprStmt", expr, span: expr.span };
  }

  private parseGlobalDecl(): GlobalDecl {
    const s = this.span(this.peek());
    // optional `thread_local` modifier (contextual keyword) → per-thread storage
    let threadLocal = false;
    if (this.at(TokenKind.Ident) && this.peek().value === "thread_local") {
      threadLocal = true;
      this.advance();
    }
    const mutable = this.at(TokenKind.Var);
    this.advance();
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    const value = this.parseExpr();
    return { kind: "GlobalDecl", name, type, value, mutable, threadLocal, span: s };
  }

  // Tokens that can never begin an expression. Seeing one where a binding's
  // value should be means the value is missing (e.g. `let x =` then `return`).
  private static readonly NON_EXPR_START = new Set<TokenKind>([
    TokenKind.Let, TokenKind.Var, TokenKind.Return, TokenKind.Else,
    TokenKind.While, TokenKind.For, TokenKind.Break, TokenKind.Continue,
    TokenKind.Semicolon, TokenKind.RBrace, TokenKind.Eof,
  ]);

  // After consuming `=`, error if no expression follows. Anchored at the binding
  // keyword, not the unrelated next token: the real cause is the dangling
  // `let x =` a line earlier, so pointing the caret there (with the offending
  // token named in the message) is what makes the diagnostic land.
  private requireBindingValue(kw: "let" | "var", name: string, kwTok: Token): void {
    const next = this.peek();
    if (Parser.NON_EXPR_START.has(next.kind)) {
      this.error(
        `${kw} binding '${name}' has no value after '='`,
        kwTok, undefined,
        `expected an expression after '=' — found '${next.value}'; e.g. '${kw} ${name} = 0'`,
      );
    }
  }

  private parseLet(): Stmt {
    const letTok = this.expect(TokenKind.Let);
    const s = this.span(letTok);
    // let-else: `let Enum.Variant(b) = value else { ... }`. A binding name is
    // always `IDENT =` or `IDENT :`; an enum pattern is `IDENT . Variant` or, with the
    // enum name elided (`let Some(b) = …`), `IDENT (`, so the token after the first
    // ident disambiguates without lookahead ambiguity.
    const afterIdent = this.tokens[this.pos + 1]?.kind;
    if (this.at(TokenKind.Ident) && (afterIdent === TokenKind.Dot || afterIdent === TokenKind.LParen)) {
      const pattern = this.parsePattern();
      this.expect(TokenKind.Eq);
      const value = this.parseExpr();
      this.expect(TokenKind.Else);
      this.expect(TokenKind.LBrace);
      const elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
      return { kind: "LetElseStmt", pattern, value, elseBody, span: s };
    }
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    this.requireBindingValue("let", name, letTok);
    const value = this.parseExpr();
    // `let g = p else { … }` — the nullable-extern-reference unwrap. No pattern, because
    // there is no enum: the only thing being matched is "is this pointer null". `else`
    // cannot continue an expression, so seeing one here is unambiguous. The checker
    // rejects the form on anything but a `?&mut T` / `?&T` parameter.
    if (this.at(TokenKind.Else)) {
      if (type) this.error(`'let ${name} = … else { … }' takes no type annotation — the type comes from the parameter being unwrapped`, letTok);
      this.advance();
      this.expect(TokenKind.LBrace);
      const elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
      return { kind: "LetElseStmt", pattern: { kind: "WildcardPattern", span: s }, value, elseBody, bindName: name, span: s };
    }
    return { kind: "LetDecl", name, type, value, span: s };
  }

  private parseVar(): Stmt {
    const varTok = this.expect(TokenKind.Var);
    const s = this.span(varTok);
    const name = this.expect(TokenKind.Ident).value;
    let type: MiloType | null = null;
    if (this.match(TokenKind.Colon)) type = this.parseType();
    this.expect(TokenKind.Eq);
    this.requireBindingValue("var", name, varTok);
    const value = this.parseExpr();
    return { kind: "VarDecl", name, type, value, span: s };
  }

  private parseReturn(): Stmt {
    const s = this.span(this.peek());
    const tok = this.expect(TokenKind.Return);
    // Statements are newline-delimited in Milo, and a return value is no exception:
    // an expression on a LATER line is the next statement, not this return's value.
    // Without the line check, `return` followed by `print(x)` on the next line
    // silently parsed as `return print(x)` — the call still ran, and a value-typed
    // one produced IR that stored into a void slot.
    if (this.at(TokenKind.RBrace) || this.at(TokenKind.Semicolon) || this.peek().line !== tok.line) {
      return { kind: "Return", value: null, span: s };
    }
    return { kind: "Return", value: this.parseExpr(), span: s };
  }

  private parseIf(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.If);
    if (this.at(TokenKind.Let)) {
      return this.parseIfLet(s);
    }
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    let elseBody: Stmt[] | null = null;
    if (this.match(TokenKind.Else)) {
      if (this.at(TokenKind.If)) {
        elseBody = [this.parseIf()];
      } else {
        this.expect(TokenKind.LBrace);
        elseBody = this.parseStmts();
        this.expect(TokenKind.RBrace);
      }
    }
    return { kind: "IfStmt", cond, thenBody, elseBody, span: s };
  }

  private parseIfExpr(s: Span): Expr {
    this.expect(TokenKind.If);
    const cond = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    this.expect(TokenKind.Else);
    let elseBody: Stmt[];
    if (this.at(TokenKind.If)) {
      const innerSpan = this.span(this.peek());
      elseBody = [{ kind: "ExprStmt" as const, expr: this.parseIfExpr(innerSpan), span: innerSpan }];
    } else {
      this.expect(TokenKind.LBrace);
      elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    // An arm block whose tail is a statement-form `if/else` still yields that
    // if's value in expression context. parseStmts parsed it as an IfStmt (no
    // value); reinterpret it as an if-expression so nested `if c { a } else { b }`
    // arms typecheck and codegen as values. Scoped to if-expr arms, so plain
    // statement-ifs elsewhere are untouched.
    this.valueTailToExpr(thenBody);
    this.valueTailToExpr(elseBody);
    return { kind: "IfExpr", cond, thenBody, elseBody, span: s };
  }

  // Rewrite a block's trailing statement-form if/else into an if-expression, in
  // place, recursing so deeply-nested arms convert too.
  private valueTailToExpr(body: Stmt[]): void {
    if (body.length === 0) return;
    const last = body[body.length - 1];
    if (last.kind === "IfStmt" && last.elseBody) {
      this.valueTailToExpr(last.thenBody);
      this.valueTailToExpr(last.elseBody);
      const asExpr: Expr = { kind: "IfExpr", cond: last.cond, thenBody: last.thenBody, elseBody: last.elseBody, span: last.span };
      body[body.length - 1] = { kind: "ExprStmt", expr: asExpr, span: last.span };
    } else if (last.kind === "MatchStmt") {
      // Same for a tail `match`; its arms become value arms in turn.
      for (const arm of last.arms) this.valueTailToExpr(arm.body);
      const asExpr: Expr = { kind: "MatchExpr", subject: last.subject, arms: last.arms, span: last.span };
      body[body.length - 1] = { kind: "ExprStmt", expr: asExpr, span: last.span };
    }
  }

  private parseIfLet(s: Span): Stmt {
    this.expect(TokenKind.Let);
    const pattern = this.parsePattern();
    this.expect(TokenKind.Eq);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const thenBody = this.parseStmts();
    this.expect(TokenKind.RBrace);
    let elseBody: Stmt[] | null = null;
    if (this.match(TokenKind.Else)) {
      this.expect(TokenKind.LBrace);
      elseBody = this.parseStmts();
      this.expect(TokenKind.RBrace);
    }
    return { kind: "IfLetStmt", pattern, subject, thenBody, elseBody, span: s };
  }

  private parseWhile(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.While);
    // `while let P = subj { body }` desugars to
    //   `while true { if let P = subj { body } else { break } }`
    // so the existing if-let + while machinery handles binding and exhaustion.
    if (this.at(TokenKind.Let)) {
      this.expect(TokenKind.Let);
      const pattern = this.parsePattern();
      this.expect(TokenKind.Eq);
      const subject = this.parseExpr();
      const invariants = this.parseContracts().filter(c => c.kind === "invariant" || c.kind === "decreases");
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      const ifLet: Stmt = {
        kind: "IfLetStmt", pattern, subject, thenBody: body,
        elseBody: [{ kind: "BreakStmt", span: s }], span: s,
      };
      return { kind: "WhileStmt", cond: { kind: "BoolLit", value: true, span: s }, invariants, body: [ifLet], span: s };
    }
    const cond = this.parseExpr();
    const invariants = this.parseContracts().filter(c => c.kind === "invariant" || c.kind === "decreases");
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    return { kind: "WhileStmt", cond, invariants, body, span: s };
  }

  private parseFor(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.For);
    const varName = this.expect(TokenKind.Ident).value;
    let varName2: string | null = null;
    if (this.match(TokenKind.Comma)) {
      varName2 = this.expect(TokenKind.Ident).value;
    }
    this.expectSoftKw("in");
    const iterableOrStart = this.parseExpr();
    let iterable: Expr;
    if (this.match(TokenKind.DotDot)) {
      const end = this.parseExpr();
      iterable = { kind: "RangeExpr", start: iterableOrStart, end, span: iterableOrStart.span };
    } else {
      iterable = iterableOrStart;
    }
    const invariants = this.parseContracts().filter(c => c.kind === "invariant" || c.kind === "decreases");
    this.expect(TokenKind.LBrace);
    const body = this.parseStmts();
    this.expect(TokenKind.RBrace);
    if (iterable.kind === "MethodCall" && iterable.method === "codePoints" && iterable.args.length === 0) {
      return this.desugarCodePointsLoop(varName, varName2, iterable.object, body, s, invariants);
    }
    return { kind: "ForInStmt", varName, varName2, iterable, invariants, body, span: s };
  }

  // `for cp in s.codePoints() { .. }` → a byte-cursor while loop over
  // decodeCodepoint. Iterating a string directly yields BYTES (the right default
  // for scanning ASCII delimiters); this form yields decoded codepoints without
  // materializing a Vec<i32>, so the UTF-8-correct loop is no more expensive to
  // write than the byte shortcut.
  //
  // Desugared here rather than in the checker because `for` has no iterator
  // protocol to hook: every iterable shape is hardcoded per builtin type. The
  // cost is that `codePoints` is effectively reserved as a for-in iterable
  // method name — a user type defining one gets this rewrite instead.
  private desugarCodePointsLoop(
    varName: string, varName2: string | null, subject: Expr, body: Stmt[], s: Span | undefined,
    invariants: import("./ast").Contract[] = [],
  ): Stmt {
    const i64Type: MiloType = { name: "i64", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null };
    const int = (n: number): Expr => ({ kind: "IntLit", value: BigInt(n), span: s });
    const id = (name: string): Expr => ({ kind: "Ident", name, span: s });
    // Unique-ish names: a nested codePoints loop must not shadow the outer
    // cursor, and neither may collide with a user binding.
    const uid = this.codePointLoopCounter++;
    const cursor = `__cpAt${uid}`;
    const decoded = `__cp${uid}`;

    const pre: Stmt[] = [];
    // A place expression is read in situ; anything else is a temporary that must
    // be bound once, or `.len` and each decode would re-evaluate it. Binding a
    // place would MOVE it — and a borrow can't be bound to a local at all.
    let src = subject;
    if (subject.kind !== "Ident" && subject.kind !== "FieldAccess" && subject.kind !== "IndexAccess") {
      const tmp = `__cpSrc${uid}`;
      pre.push({ kind: "LetDecl", name: tmp, type: null, value: subject, span: s });
      src = id(tmp);
    }
    pre.push({ kind: "VarDecl", name: cursor, type: i64Type, value: int(0), span: s });

    const loopBody: Stmt[] = [
      { kind: "LetDecl", name: decoded, type: null,
        // cloned: the checker keys its per-expression maps (types, moves,
        // auto-borrows) by node identity, so one node cannot sit in two places
        value: { kind: "Call", func: "decodeCodepoint", args: [this.cloneExpr(src), id(cursor)], span: s }, span: s },
    ];
    // The index binding is the offset of the codepoint just decoded, so it must
    // be taken BEFORE the cursor advances.
    if (varName2) {
      loopBody.push({ kind: "LetDecl", name: varName, type: null, value: id(cursor), span: s });
      loopBody.push({ kind: "LetDecl", name: varName2, type: null,
        value: { kind: "FieldAccess", object: id(decoded), field: "value", span: s }, span: s });
    } else {
      loopBody.push({ kind: "LetDecl", name: varName, type: null,
        value: { kind: "FieldAccess", object: id(decoded), field: "value", span: s }, span: s });
    }
    // Advance BEFORE the body: a `continue` in the body would otherwise skip the
    // increment and spin forever.
    loopBody.push({
      kind: "Assign", target: id(cursor),
      value: { kind: "BinOp", op: "+", left: id(cursor),
               right: { kind: "FieldAccess", object: id(decoded), field: "size", span: s }, span: s },
      span: s,
    });
    loopBody.push(...body);

    pre.push({
      kind: "WhileStmt",
      cond: { kind: "BinOp", op: "<", left: id(cursor), right: { kind: "FieldAccess", object: this.cloneExpr(src), field: "len", span: s }, span: s },
      invariants, body: loopBody, span: s,
    });
    // `if true` is just a scope: it keeps the cursor and any subject temporary
    // from leaking into the enclosing block. There is no bare-block statement.
    return { kind: "IfStmt", cond: { kind: "BoolLit", value: true, span: s }, thenBody: pre, elseBody: null, span: s };
  }

  // ── Match ──

  private parseMatch(): Stmt {
    const s = this.span(this.peek());
    this.expect(TokenKind.Match);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const arms: MatchArm[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const pattern = this.parsePattern();
      this.expect(TokenKind.FatArrow);
      arms.push({ pattern, body: this.parseArmBody(false) });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "MatchStmt", subject, arms, span: s };
  }

  // A match arm is a braced block or a bare expression (`P => print(x)`), in
  // statement and expression position alike; the statement form used to demand the
  // braces, so a `match` at the tail of an if-expression block (parsed as a statement)
  // rejected the expression arms every other match accepts.
  private parseArmBody(yieldsValue: boolean): Stmt[] {
    if (this.at(TokenKind.LBrace)) {
      this.expect(TokenKind.LBrace);
      const body = this.parseStmts();
      this.expect(TokenKind.RBrace);
      if (yieldsValue) this.valueTailToExpr(body);
      return body;
    }
    const es = this.span(this.peek());
    return [{ kind: "ExprStmt", expr: this.parseExpr(), span: es }];
  }

  // Expression-position match: each arm yields a value. Accepts both a braced
  // block (`P => { stmts; value }`) and a bare expression (`P => value`) with an
  // optional trailing comma, so `match o { Some(x) => x, None => 0 }` works.
  private parseMatchExpr(s: Span): Expr {
    this.expect(TokenKind.Match);
    const subject = this.parseExpr();
    this.expect(TokenKind.LBrace);
    const arms: MatchArm[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const pattern = this.parsePattern();
      this.expect(TokenKind.FatArrow);
      arms.push({ pattern, body: this.parseArmBody(true) });
      this.match(TokenKind.Comma); // optional separator between arms
    }
    this.expect(TokenKind.RBrace);
    return { kind: "MatchExpr", subject, arms, span: s };
  }

  private parsePattern(): Pattern {
    const tok = this.peek();
    const s = this.span(tok);
    if (tok.kind === TokenKind.Ident && tok.value === "_") {
      this.advance();
      return { kind: "WildcardPattern", span: s };
    }
    // Literal patterns: integers, floats, strings, chars, bools
    if (tok.kind === TokenKind.Int) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "int", span: s };
    }
    if (tok.kind === TokenKind.Float) {
      this.advance();
      return { kind: "LiteralPattern", value: Number(tok.value), literalKind: "float", span: s };
    }
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "string", span: s };
    }
    if (tok.kind === TokenKind.Char) {
      this.advance();
      return { kind: "LiteralPattern", value: tok.value, literalKind: "char", span: s };
    }
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "LiteralPattern", value: true, literalKind: "bool", span: s };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "LiteralPattern", value: false, literalKind: "bool", span: s };
    }
    // Negative integer/float literal
    if (tok.kind === TokenKind.Minus) {
      const next = this.tokens[this.pos + 1];
      if (next && (next.kind === TokenKind.Int || next.kind === TokenKind.Float)) {
        this.advance(); // consume -
        const numTok = this.advance();
        const lk = numTok.kind === TokenKind.Int ? "int" as const : "float" as const;
        return { kind: "LiteralPattern", value: -Number(numTok.value), literalKind: lk, span: s };
      }
    }
    // `Enum.Variant` or, when the enum is obvious from the subject, bare `Variant`.
    // An elided name is left blank here and filled in by the checker from the
    // subject's type — the parser has no types to resolve it with.
    const first = this.expect(TokenKind.Ident).value;
    let enumName = "";
    let variant = first;
    if (this.match(TokenKind.Dot)) {
      enumName = first;
      variant = this.expect(TokenKind.Ident).value;
    }
    const bindings: string[] = [];
    const bindingSpans: Span[] = [];
    if (this.match(TokenKind.LParen)) {
      while (!this.at(TokenKind.RParen)) {
        const bindTok = this.expect(TokenKind.Ident);
        bindings.push(bindTok.value);
        bindingSpans.push(this.span(bindTok));
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
    }
    return { kind: "EnumPattern", enumName, variant, bindings, bindingSpans, span: s };
  }

  // ── Expression parsing (precedence climbing) ──

  // Recursion-depth guard. parseExpr is the chokepoint every nested expression
  // (parens, calls, indexes, unary chains) recurses through, so bounding it turns a
  // pathological input like `((((…))))` 5000-deep from a raw `RangeError: Maximum
  // call stack` into a clean diagnostic. 2000 is far past any human-written nesting.
  private static readonly MAX_EXPR_DEPTH = 2000;

  private parseExpr(): Expr {
    if (++this.exprDepth > Parser.MAX_EXPR_DEPTH) {
      this.error(`expression nesting too deep (>${Parser.MAX_EXPR_DEPTH})`, this.peek(), undefined,
        `deeply nested expressions exceed the parser's depth limit — flatten the expression`);
    }
    try {
      return this.parseExprInner();
    } finally {
      this.exprDepth--;
    }
  }

  private exprDepth = 0;

  private parseExprInner(): Expr {
    let left = this.parseOr();
    if (this.at(TokenKind.QuestionQuestion)) {
      this.advance();
      const defaultExpr = this.parseOr();
      left = { kind: "DefaultValue", operand: left, default: defaultExpr, span: left.span };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.at(TokenKind.PipePipe)) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "BinOp", op: "||", left, right, span: left.span };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseBitOr();
    while (this.at(TokenKind.AmpAmp)) {
      this.advance();
      const right = this.parseBitOr();
      left = { kind: "BinOp", op: "&&", left, right, span: left.span };
    }
    return left;
  }

  private parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.at(TokenKind.Pipe)) {
      this.advance();
      const right = this.parseBitXor();
      left = { kind: "BinOp", op: "|", left, right, span: left.span };
    }
    return left;
  }

  private parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.at(TokenKind.Caret)) {
      this.advance();
      const right = this.parseBitAnd();
      left = { kind: "BinOp", op: "^", left, right, span: left.span };
    }
    return left;
  }

  private parseBitAnd(): Expr {
    let left = this.parseComparison();
    // single & between exprs (&& already consumed at higher level)
    while (this.at(TokenKind.Amp) && this.peekN(1).kind !== TokenKind.Mut) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "BinOp", op: "&", left, right, span: left.span };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseShift();
    if (this.at(TokenKind.Is)) {
      this.advance();
      const pattern = this.parsePattern();
      return { kind: "IsExpr", operand: left, pattern, span: left.span };
    }
    while (this.peek().kind === TokenKind.EqEq || this.peek().kind === TokenKind.Neq ||
           this.peek().kind === TokenKind.LtEq || this.peek().kind === TokenKind.GtEq ||
           // single Lt/Gt only when not part of an adjacent shift pair (handled at parseShift)
           (this.peek().kind === TokenKind.Lt && !this.atAdjacent(TokenKind.Lt)) ||
           (this.peek().kind === TokenKind.Gt && !this.atAdjacent(TokenKind.Gt))) {
      const opTok = this.advance();
      const right = this.parseShift();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseShift(): Expr {
    let left = this.parseAdditive();
    while (this.atAdjacent(TokenKind.Lt) || this.atAdjacent(TokenKind.Gt)) {
      const isLeft = this.peek().kind === TokenKind.Lt;
      this.advance(); this.advance();
      const right = this.parseAdditive();
      left = { kind: "BinOp", op: isLeft ? "<<" : ">>", left, right, span: left.span };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === TokenKind.Plus || this.peek().kind === TokenKind.Minus) {
      const opTok = this.advance();
      const right = this.parseMultiplicative();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === TokenKind.Star || this.peek().kind === TokenKind.Slash || this.peek().kind === TokenKind.Percent) {
      // `*` on a new line is unary dereference, not binary multiply
      if (this.peek().kind === TokenKind.Star && this.pos > 0 && this.tokens[this.pos - 1].line < this.peek().line) break;
      const opTok = this.advance();
      const right = this.parseUnary();
      left = { kind: "BinOp", op: opTok.value, left, right, span: left.span };
    }
    return left;
  }

  private parseUnary(): Expr {
    // `&mut x` is the explicit mutable-borrow marker on a call argument. Parsed anywhere
    // an expression can start; the checker decides whether the position is allowed.
    if (this.peek().kind === TokenKind.Amp && this.peekN(1).kind === TokenKind.Mut) {
      const tok = this.advance();
      this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op: "&mut", operand, span: this.span(tok) };
    }
    if (this.peek().kind === TokenKind.Minus || this.peek().kind === TokenKind.Bang || this.peek().kind === TokenKind.Star || this.peek().kind === TokenKind.Tilde || this.peek().kind === TokenKind.Amp) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return { kind: "UnaryOp", op: tok.value, operand, span: this.span(tok) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at(TokenKind.Dot)) {
        this.advance();
        const fieldTok = this.expect(TokenKind.Ident);
        const field = fieldTok.value;
        if (this.at(TokenKind.LParen) && this.peek().line === fieldTok.line) {
          this.advance();
          const args: Expr[] = [];
          while (!this.at(TokenKind.RParen)) {
            args.push(this.parseExpr());
            this.match(TokenKind.Comma);
          }
          this.expect(TokenKind.RParen);
          expr = { kind: "MethodCall", object: expr, method: field, args, span: expr.span };
        } else {
          expr = { kind: "FieldAccess", object: expr, field, span: expr.span };
        }
      } else if (this.at(TokenKind.LBracket)) {
        this.advance();
        const first = this.parseExpr();
        if (this.at(TokenKind.DotDot)) {
          this.advance();
          const end = this.parseExpr();
          this.expect(TokenKind.RBracket);
          // s[a..b] desugars to s.slice(a, b) — zero-copy &string
          expr = { kind: "MethodCall", object: expr, method: "slice", args: [first, end], span: expr.span };
        } else {
          this.expect(TokenKind.RBracket);
          expr = { kind: "IndexAccess", object: expr, index: first, span: expr.span };
        }
      } else if (this.at(TokenKind.Bang)) {
        this.advance();
        expr = { kind: "Unwrap", operand: expr, span: expr.span };
      } else if (this.at(TokenKind.Question)) {
        this.advance();
        expr = { kind: "Propagate", operand: expr, span: expr.span };
      } else if (this.at(TokenKind.As)) {
        this.advance();
        const targetType = this.parseType();
        expr = { kind: "CastExpr", operand: expr, targetType, span: expr.span };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    const s = this.span(tok);

    // `@embedFile("path")` — the sigil spelling of a compile-time builtin. `@` is
    // otherwise unused in expression position (attributes only precede decls and
    // struct fields), so there is nothing to disambiguate against here.
    if (tok.kind === TokenKind.At) {
      this.advance();
      const nameTok = this.peek();
      if (nameTok.kind !== TokenKind.Ident) {
        this.error(`expected a compile-time builtin name after '@'`, nameTok, undefined,
          `'@' expressions are '@embedFile("path")', '@targetOs()' and '@targetArch()'`);
      }
      // Same tight-binding rule as attributes: `@embedFile`, never `@ embedFile`.
      if (nameTok.line !== tok.line || nameTok.col !== tok.col + 1) {
        this.error(`no whitespace allowed between '@' and '${nameTok.value}'`, nameTok, undefined,
          `write '@${nameTok.value}(...)'`);
      }
      if (!Parser.SIGIL_BUILTINS.has(nameTok.value)) {
        this.error(`unknown compile-time builtin '@${nameTok.value}'`, nameTok, undefined,
          `'@' expressions are '@embedFile("path")', '@targetOs()' and '@targetArch()'`);
      }
      this.advance();
      const args: Expr[] = [];
      this.expect(TokenKind.LParen);
      while (!this.at(TokenKind.RParen)) {
        args.push(this.parseExpr());
        this.match(TokenKind.Comma);
      }
      this.expect(TokenKind.RParen);
      return { kind: "Call", func: nameTok.value, args, sigil: true, span: s };
    }
    if (tok.kind === TokenKind.Int) {
      this.advance();
      // lexer already normalized hex/binary to a plain decimal string and
      // stripped underscores, so BigInt() parses it losslessly.
      return { kind: "IntLit", value: BigInt(tok.value), span: s };
    }
    if (tok.kind === TokenKind.Float) {
      this.advance();
      return { kind: "FloatLit", value: parseFloat(tok.value), span: s };
    }
    if (tok.kind === TokenKind.True) {
      this.advance();
      return { kind: "BoolLit", value: true, span: s };
    }
    if (tok.kind === TokenKind.False) {
      this.advance();
      return { kind: "BoolLit", value: false, span: s };
    }
    if (tok.kind === TokenKind.Null) {
      this.advance();
      return { kind: "EnumLit", enumName: "Option", variant: "None", args: [], span: s };
    }
    if (tok.kind === TokenKind.String) {
      this.advance();
      return { kind: "StringLit", value: tok.value, span: s };
    }
    if (tok.kind === TokenKind.FString) {
      this.advance();
      return this.parseFString(tok.value, s);
    }
    if (tok.kind === TokenKind.Char) {
      this.advance();
      return { kind: "CharLit", value: parseInt(tok.value), span: s };
    }
    if (tok.kind === TokenKind.Ident) {
      this.advance();
      // enum variant: Name.Variant or Name.Variant(args)
      if (this.at(TokenKind.Dot) && typeSpelled(tok.value)) {
        this.advance();
        const variant = this.expect(TokenKind.Ident).value;
        const args: Expr[] = [];
        if (this.match(TokenKind.LParen)) {
          while (!this.at(TokenKind.RParen)) {
            args.push(this.parseExpr());
            this.match(TokenKind.Comma);
          }
          this.expect(TokenKind.RParen);
        }
        return { kind: "EnumLit", enumName: tok.value, variant, args, span: s };
      }
      // Turbofish: an ident directly followed by `<TypeArgs>` and then either
      //   `.method(args)` — generic static call:  Name<T>.run(...)
      //   `(args)`        — generic free call:     promiseAll<T>(...)
      // This is speculative because `<` is also less-than; if the tail doesn't
      // resolve to one of those two shapes we restore and let `<` parse as a
      // comparison. The trailing `.`/`(` requirement is the disambiguator.
      if (this.at(TokenKind.Lt)) {
        const saved = this.pos;
        let structTurbofish: { typeArgs: import("./ast").MiloType[]; pos: number } | null = null;
        try {
          this.advance(); // consume <
          const typeArgs: import("./ast").MiloType[] = [this.parseType()];
          while (this.match(TokenKind.Comma)) {
            typeArgs.push(this.parseType());
          }
          this.expect(TokenKind.Gt);
          if (this.at(TokenKind.Dot)) {
            this.advance();
            const variant = this.expect(TokenKind.Ident).value;
            const args: Expr[] = [];
            if (this.match(TokenKind.LParen)) {
              while (!this.at(TokenKind.RParen)) {
                args.push(this.parseExpr());
                this.match(TokenKind.Comma);
              }
              this.expect(TokenKind.RParen);
            }
            return { kind: "EnumLit", enumName: tok.value, variant, args, typeArgs, span: s };
          }
          if (this.at(TokenKind.LParen) && this.peek().line === tok.line) {
            this.advance(); // consume (
            const args: Expr[] = [];
            while (!this.at(TokenKind.RParen)) {
              args.push(this.parseExpr());
              this.match(TokenKind.Comma);
            }
            this.expect(TokenKind.RParen);
            return { kind: "Call", func: tok.value, args, typeArgs, span: s };
          }
          // `Pair<i64, string> { … }`: a struct literal with its type arguments spelled,
          // the same way `Pair<i64, string>.new()` and `f<i64>(x)` spell them. Recorded
          // and parsed after the speculative block rather than inside it: a mistake in a
          // field would otherwise be swallowed by the `catch`, which falls back to `<` as
          // a comparison and reports `unexpected token ','` at the type-argument comma.
          if (this.at(TokenKind.LBrace) && typeSpelled(tok.value)) {
            structTurbofish = { typeArgs, pos: this.pos };
          }
          this.pos = saved; // not a turbofish — fall through to `<` as comparison
        } catch {
          this.pos = saved;
        }
        if (structTurbofish) {
          this.pos = structTurbofish.pos;
          return this.parseStructLit(tok.value, s, structTurbofish.typeArgs);
        }
      }
      // struct literal: Name { field: value, ... }
      // disambiguate from control-flow braces via lookahead: empty `{}`, `{ IDENT :`,
      // or field shorthand `{ IDENT ,` / `{ IDENT }` (desugars to `{ IDENT: IDENT }`).
      if (this.at(TokenKind.LBrace) && typeSpelled(tok.value)
          && (this.peekN(1).kind === TokenKind.RBrace
              || (this.peekN(1).kind === TokenKind.Ident
                  && (this.peekN(2).kind === TokenKind.Colon
                      || this.peekN(2).kind === TokenKind.Comma
                      || this.peekN(2).kind === TokenKind.RBrace)))) {
        return this.parseStructLit(tok.value, s);
      }
      // sizeOf<Type>() / zeroed<Type>() / offsetOf<Type>("field") — builtins with explicit type arg
      if ((tok.value === "sizeOf" || tok.value === "zeroed" || tok.value === "offsetOf") && this.at(TokenKind.Lt)) {
        this.advance(); // consume <
        const typeArg = this.parseType();
        this.expect(TokenKind.Gt);
        this.expect(TokenKind.LParen);
        const args: Expr[] = [];
        if (!this.at(TokenKind.RParen)) {
          args.push(this.parseExpr());
        }
        this.expect(TokenKind.RParen);
        return { kind: "Call", func: tok.value, args, typeArgs: [typeArg], span: s };
      }
      // function call: name(args) — `(` must be on same line to avoid cross-line ambiguity
      if (this.at(TokenKind.LParen) && this.peek().line === tok.line) return this.parseCall(tok.value, s);
      return { kind: "Ident", name: tok.value, span: s };
    }
    // array literal: [a, b, c]
    if (tok.kind === TokenKind.LBracket) {
      return this.parseArrayLit();
    }
    if (tok.kind === TokenKind.Move) {
      this.advance(); // consume 'move'
      if (this.at(TokenKind.LParen) && this.isArrowClosure()) {
        const closure = this.parseClosure(s);
        (closure as any).isMove = true;
        return closure;
      }
      this.error("'move' must precede a closure", tok);
    }
    if (tok.kind === TokenKind.LParen) {
      if (this.isArrowClosure()) {
        return this.parseClosure(s);
      }
      this.advance();
      const expr = this.parseExpr();
      this.expect(TokenKind.RParen);
      return expr;
    }

    // anonymous struct literal: { field: value, ... }
    if (tok.kind === TokenKind.LBrace && this.peekN(1).kind === TokenKind.Ident && this.peekN(2).kind === TokenKind.Colon) {
      return this.parseStructLit("", s);
    }

    if (tok.kind === TokenKind.If) {
      return this.parseIfExpr(s);
    }

    if (tok.kind === TokenKind.Match) {
      return this.parseMatchExpr(s);
    }

    // Two shapes worth naming rather than reporting as a stray operator: both are
    // reflexes from other C-family languages, and both have an exact Milo spelling.
    // `i++` reaches here as the second '+' of `i + +?`; `a ? b : c` as the ':' left
    // over after '?' was taken as the propagate operator.
    const prevKind = this.pos > 0 ? this.tokens[this.pos - 1]!.kind : null;
    if (tok.kind === TokenKind.Plus && prevKind === TokenKind.Plus) {
      this.error(`unexpected token '${tok.kind}'`, tok, undefined, "Milo has no '++' — write 'i += 1'");
    }
    // A ':' with a '?' earlier on the same line is a ternary: the '?' was already
    // taken as the propagate operator, leaving the ':' with nothing to attach to.
    if (tok.kind === TokenKind.Colon) {
      for (let i = this.pos - 1; i >= 0 && this.tokens[i]!.line === tok.line; i--) {
        if (this.tokens[i]!.kind === TokenKind.Question) {
          this.error(`unexpected token '${tok.kind}'`, tok, undefined,
            "Milo has no '?:' — 'if' is an expression: 'let y = if cond { a } else { b }'");
        }
      }
    }
    this.error(`unexpected token '${tok.kind}'`, tok);
  }

  private parseStructLit(name: string, span: Span, typeArgs?: import("./ast").MiloType[]): Expr {
    this.expect(TokenKind.LBrace);
    const fields: { name: string; value: Expr }[] = [];
    while (!this.at(TokenKind.RBrace)) {
      const nameTok = this.expect(TokenKind.Ident);
      const fieldName = nameTok.value;
      // Field shorthand: `{ key }` desugars to `{ key: key }` (value is the
      // in-scope binding named `key`). Span points at the field-name token so
      // hover/goto-definition resolve the local.
      const value = this.match(TokenKind.Colon)
        ? this.parseExpr()
        : { kind: "Ident", name: fieldName, span: this.span(nameTok) } as Expr;
      fields.push({ name: fieldName, value });
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBrace);
    return { kind: "StructLit", name, fields, ...(typeArgs && { typeArgs }), span };
  }

  private parseCall(name: string, span: Span): Expr {
    this.expect(TokenKind.LParen);
    const args: Expr[] = [];
    while (!this.at(TokenKind.RParen)) {
      args.push(this.parseExpr());
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    return { kind: "Call", func: name, args, span };
  }

  private parseArrayLit(): Expr {
    const s = this.span(this.peek());
    this.expect(TokenKind.LBracket);
    const elements: Expr[] = [];
    while (!this.at(TokenKind.RBracket)) {
      elements.push(this.parseExpr());
      // [value; count] repeat syntax
      if (elements.length === 1 && this.match(TokenKind.Semicolon)) {
        const count = parseInt(this.expect(TokenKind.Int).value);
        this.expect(TokenKind.RBracket);
        return { kind: "ArrayRepeat", value: elements[0], count, span: s };
      }
      this.match(TokenKind.Comma);
    }
    this.expect(TokenKind.RBracket);
    return { kind: "ArrayLit", elements, span: s };
  }

  // lookahead: is this ( a function type like (T1, T2) => R?
  private isFnType(): boolean {
    let i = this.pos + 1;
    let depth = 1;
    while (depth > 0 && i < this.tokens.length) {
      if (this.tokens[i].kind === TokenKind.LParen) depth++;
      else if (this.tokens[i].kind === TokenKind.RParen) depth--;
      i++;
    }
    return i < this.tokens.length && this.tokens[i].kind === TokenKind.FatArrow;
  }

  // lookahead: is this ( the start of an arrow closure?
  // () =>  or  (ident : ...) =>
  private isArrowClosure(): boolean {
    const saved = this.pos;
    this.advance(); // skip (
    if (this.at(TokenKind.RParen)) {
      this.advance();
      if (this.at(TokenKind.FatArrow)) { this.pos = saved; return true; }
      if (this.at(TokenKind.Colon)) { this.pos = saved; return true; }
      this.pos = saved;
      return false;
    }
    if (this.at(TokenKind.Ident)) {
      this.advance();
      if (this.at(TokenKind.Colon)) { this.pos = saved; return true; }
      // untyped params: (x) => ..., (x, y) => ...
      if (this.at(TokenKind.Comma) || this.at(TokenKind.RParen)) {
        while (!this.at(TokenKind.RParen) && !this.at(TokenKind.Eof)) this.advance();
        if (this.at(TokenKind.RParen)) {
          this.advance();
          if (this.at(TokenKind.FatArrow) || this.at(TokenKind.Colon)) {
            this.pos = saved;
            return true;
          }
        }
      }
    }
    this.pos = saved;
    return false;
  }

  // (params) => expr  or  (params): RetType => { body }
  private parseClosure(span: Span): Expr {
    this.expect(TokenKind.LParen);
    const params: Param[] = [];
    while (!this.at(TokenKind.RParen)) {
      const nameTok = this.expect(TokenKind.Ident);
      const name = nameTok.value;
      const type = this.at(TokenKind.Colon) ? (this.advance(), this.parseType()) : null;
      params.push({ name, type, span: this.span(nameTok) });
      if (!this.at(TokenKind.RParen)) this.expect(TokenKind.Comma);
    }
    this.expect(TokenKind.RParen);
    const retType = this.at(TokenKind.Colon) ? (this.advance(), this.parseType()) : null;
    this.expect(TokenKind.FatArrow);
    let body: Stmt[];
    if (this.match(TokenKind.LBrace)) {
      body = this.parseStmts();
      this.expect(TokenKind.RBrace);
    } else {
      const expr = this.parseExpr();
      body = [{ kind: "Return" as const, value: expr, span: expr.span }];
    }
    return { kind: "Closure", params, retType, body, span };
  }

  // $"hello {name}, you are {age} years old" → format("hello ", name, ", you are ", age, " years old")
  // Recursively overwrite every span in a parsed subtree. Generic over node
  // shape so it can't miss a variant the way a hand-written per-kind walk would.
  private stampSpan(node: unknown, span: Span): void {
    if (Array.isArray(node)) {
      for (const child of node) this.stampSpan(child, span);
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.kind === "string") rec.span = span;
    for (const key of Object.keys(rec)) {
      if (key !== "span") this.stampSpan(rec[key], span);
    }
  }

  private parseFString(raw: string, span: Span): Expr {
    const args: Expr[] = [];
    // Resolve the lexer's escaped-brace sentinels only when a literal run is
    // flushed. Doing it up front would put real `{`/`}` back into `raw` and
    // reintroduce the ambiguity the sentinels exist to remove.
    const unescape = (s: string) => s.split(FSTRING_LBRACE).join("{").split(FSTRING_RBRACE).join("}");
    let lit = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "{") {
        if (lit.length > 0) { args.push({ kind: "StringLit", value: unescape(lit), span, fromFString: true }); lit = ""; }
        i++;
        let depth = 1;
        let exprStr = "";
        while (i < raw.length && depth > 0) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") { depth--; if (depth === 0) { i++; break; } }
          exprStr += raw[i];
          i++;
        }
        const tokens = new Lexer(exprStr).tokenize();
        // Same restamping problem as the spans below, one step earlier: a sub-parse that
        // THROWS carries the fragment's own 1:col, which points at the first line of the
        // file and a column past the end of it. That is a diagnostic the reader cannot
        // act on and what the frontend fuzzer's bad-span check reports. Re-anchor to the
        // f-string before it leaves this frame.
        let expr: Expr;
        try {
          expr = new Parser(tokens).parseExpr();
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          throw new ParseError({ ...e.diagnostic, span }, this.source, this.filePath);
        }
        // The sub-parser lexes a bare fragment, so every span in it starts over
        // at 1:1 — any later error on an interpolated expression pointed at the
        // first line of the FILE. Restamp to the f-string's own span. Columns
        // within the fragment aren't recoverable here (the lexer already
        // resolved escapes, so offsets into `raw` don't map back to source
        // columns), but the line and the statement are now right.
        this.stampSpan(expr, span);
        args.push(expr);
      } else {
        lit += raw[i];
        i++;
      }
    }
    if (lit.length > 0) args.push({ kind: "StringLit", value: unescape(lit), span, fromFString: true });
    if (args.length === 1 && args[0].kind === "StringLit") return args[0];
    return { kind: "Call", func: "format", args, span };
  }
}
