# Milo language/runtime friction — from building milojs

Collected building `examples/apps/milojs/` (a pure-Milo JS engine: lexer, parser,
AST, tree-walking evaluator with closures, mark-sweep GC, CommonJS module loader —
targeting the express/tRPC bundle). Complements the emulator friction docs; where
an item there also bit here I note it as recurring (higher priority).

---

## 1. Flat namespace is a footgun that scales badly (bit me 3×, once broke std internally)

Every top-level `fn` shares one global namespace, so a name I picked collided with
an existing one and the *later* definition silently won — no error at the def site.
Hit it three times:
- `strIndexOf` / `strTrim` vs the same names in `std/string`
- `charAt` vs `charAt` in `repl.milo`
- and the dangerous one: my function **rebound a name std itself calls internally**,
  so std's own call resolved to *my* body → std broke from the inside, far from any
  code I wrote.

The eventual diagnostic is excellent, but you only see it after the collision
already changed behavior; in the std case the failure surfaced nowhere near the
cause. This gets worse as a program grows and as it pulls in more std.
**Cost:** repeated debugging of "std is misbehaving" that was really my shadow.
**Proposed fix:** at minimum a **shadowing warning** when a user def has the same
name as a std/imported symbol (or any prior top-level def). Better: real
module-scoped namespacing so a local `charAt` can't rebind std's. A warning alone
would have caught all three.

**RESOLVED (2026-07-18):** the resolver already *errored* on a user fn shadowing a
stdlib fn with a **different** signature (`shadows-stdlib`) — the arity/type-mismatch
trap. The silent case that bit here was a **same-signature, different-body** shadow:
it type-checks, so it was the "documented last-wins override" path and warned about
nothing, yet it silently rebinds the library's own internal calls to the user's body
(exactly how std broke from the inside). Now emits `shadows-stdlib-override`
(`src/resolver.ts` collects it, `src/checker.ts` warns), **on by default**,
suppressible with `--allow=shadows-stdlib-override` and escalatable with `--deny`.
Covered by `tests/shadowStdlibLint.test.ts` + updated `tests/modules.test.ts`. Full
module-scoped namespacing (so a local `charAt` can't rebind std's *at all*) remains
the bigger fix, not done — but the silent footgun is now surfaced.

## 2. No `break` / `continue` — the single biggest readability hit — ✅ SHIPPED (already landed in 8e7b4c8)

Without loop control I write `var going = true` flag-loops everywhere, which is
exactly the unstructured pattern the flags are meant to avoid. Ironic: I hit this
hardest *while implementing* `break`/`continue` for the JS engine — Milo can't
express what its own guest language now can.
**Cost:** every non-trivial loop is longer and less readable; early-exit intent is
buried in a sentinel var.
**Proposed fix:** `break` / `continue` (labeled optional). Highest-value ergonomic
item in this doc.

**RESOLVED (verified 2026-07-18):** `break`/`continue` are fully wired through the
compiler (lexer→parser→ast→checker→hir→lower→codegen) and work in `while`,
`for`-range, and `for`-in loops, incl. nested loops (break/continue target the
*innermost* loop) and correct iterator-advance on `continue`. Checker rejects them
outside a loop (`'break' outside of loop`). Covered by fixtures `breakContinue`,
`forBreak`, `forContinue`, `break_drop`, `loopBreakDrop`, and error fixtures
`breakOutsideLoop`/`continueOutsideLoop`; formatter round-trips them. This session
closed the one remaining definition-of-done gap: added `break`/`continue`/`for`
productions to `docs/grammar.ebnf` (they were undocumented). Labeled break/continue
not implemented and not needed so far. Nothing more to do here.

**Follow-up (2026-07-18): the milojs codebase still uses the old flag-loops — convert
them, they're no longer needed.** ~65 `var going = true` sites remain across milojs
(`eval.milo` 19, `parser.milo` 16, `regex.milo` 12, `builtins.milo` 5, `lexer.milo`
0 — converted). Conversion is mechanical: `going = false` → `break`, and
`if done { going = false } else { <body> }` → `if done { break }` + de-indent the
body. Done for `lexer.milo` (`scanTmplChunk`/`scanRegexLit`/radix scan, byte-identical
to bun, commit `89a5736`). The rest are best done when the concurrent milojs agent is
idle — it actively rewrites `eval.milo`/`parser.milo`, so edits there collide.

**On the milojs agent's "mis-indented `} else {`" note — NOT a language/formatter bug.**
It came from scripted text-substitution edits that didn't reindent. `milo fmt` already
fixes it: the formatter re-derives indentation from brace depth, and the committed
milojs files are fmt-clean (`milo fmt parser.milo` = 0 changes). The `}` immediately
above a `} else {` at a shallower indent is *correct* nesting (inner block closes, then
the `if` closes into `else`) — it only reads dense. Just run `milo fmt` (or rely on the
pre-commit hook). This is distinct from the still-open struct-literal formatter bug (#4).

## 3. `from` / `in` as reserved words collide with parameter names (papercut)

`from` and `in` are reserved (import syntax / for-in), so natural parameter and
variable names like `from`, `in` are rejected. Surprising because they read as
ordinary identifiers everywhere except the two constructs that use them.
**Cost:** rename churn (`from` → `src`/`start`) with no semantic reason.
**Proposed fix:** make them contextual keywords (reserved only in import / for-in
position), or at least list them in the reference's reserved-word set so it's not a
surprise.

**RESOLVED (2026-07-18):** `from` and `in` are now contextual (soft) keywords —
ordinary identifiers everywhere except their one keyword position each. Dropped both
from `KEYWORDS` (lexer emits them as `Ident`); the parser recognizes the keyword role
by position via `atSoftKw`/`expectSoftKw` (`src/parser.ts`). `from` is an import only
when followed by the path string, so a top-level `from` binding still parses as an
expression. `fn pick(from: i64, in: i64)` and `let in = 5` now compile. Covered by
`tests/fixtures/softKeywordFromIn.milo`; formatter round-trips them, LSP unaffected.

## 4. Formatter puts `}` / `)` on their own line after a struct literal (reads oddly)

After a struct literal the formatter breaks the closing `}` / `)` onto its own line
in cases where the inline form read fine, producing dangling-bracket layout that
looks off.
**Cost:** cosmetic, but it's every struct literal, so it's constant low-grade noise.
**Proposed fix:** keep the closer on the same line for short/inline struct literals
(match the threshold the rest of the formatter uses for collapsing). Needs a repro
snippet — capture one next time it triggers.

**REPRO (captured 2026-07-18):** `bun run src/main.ts fmt` on
```milo
let p = Point { x: 1, y: 2 }
foo(Point { x: 5, y: 6 })
```
yields
```
let p = Point {
    x: 1, y: 2
}
foo(Point {
    x: 5, y: 6
}
)                  <-- the dangling ')' — worst part
```
**ROOT CAUSE:** the formatter (`examples/cli-tools/fmt.milo`, built to `bin/milo-fmt`)
is a token-stream reflow pass, not AST-based. Every `{` unconditionally forces
`\n`+indent and every `}` forces `\n` (see the `LBrace`/`RBrace` blocks ~line
1113-1159) — it does NOT distinguish a *block* brace from a *struct-literal* brace, so
literals always explode, and a `}` mid-call pushes the trailing `)` onto its own line.
**FIX (scoped, DEFERRED — not a quick edit):** teach the reflow pass to keep a
struct-literal `{...}` inline when it fits. Two hard parts, both real regression risk
on a 1000-line formatter locked by `tests/fmtCorpus.test.ts`:
  1. *Classify the brace.* A struct-lit `{` follows a type name (Ident / generic `>`)
     in value position, but so does a control-flow header (`if x {`, `for i in xs {`).
     Token-stream disambiguation needs to know whether a governing control keyword
     opened the current logical line — the formatter tracks keywords but not this.
  2. *Fits-on-one-line test.* Need matching-`}` lookahead + a width budget (and bail
     to multiline if the span contains a nested `{` or a line comment).
Deferred deliberately: low value (cosmetic) vs high risk (must regenerate the corpus
and not collapse literals that legitimately span lines). Do it as its own focused
change, not tacked onto unrelated work.

---

# Second pass (2026-07-18) — from async/await, classes, destructuring, bitwise

Everything above was already resolved or deliberately deferred before this batch.
These are new, and each was verified with a minimal repro before filing.

## 5. `match` on a by-value enum consumes it whenever *any* variant is non-Copy

The single biggest friction in this batch. Matching an enum by value moves it —
even when the arm actually taken binds only an `i64`, and even when the payload
you touch is Copy. It is the *declaration* that decides: one `Str(string)` variant
makes the whole enum move-on-match.

```milo
enum V { A, S(string), N(i64) }
let v = V.N(7)
match v { V.N(x) => {...} _ => {} }
match v { V.N(x) => {...} _ => {} }   // error: use of moved variable 'v'
```
Drop the `S(string)` variant and both matches compile.

There is no inline escape hatch. `&v` is not an expression ("borrows are
implicit"), and binding it another way yields `*V`, which `match` rejects:
`match subject must be an enum, integer, float, string, or bool, got *V`.

The only workaround is to push the match into a function taking `&V`, which does
*not* move. So every shape test becomes a one-line accessor:
```milo
fn objHandle(v: &JSValue): i64 {
    match v { JSValue.Obj(o) => { return o } _ => { return -1 } }
}
```
`milojs` now carries `objHandle` and `funcHandle` (`value.milo`) that exist purely
to ask "what shape is this value" without consuming it. `JSValue` is matched
constantly, so this recurs.

**RESOLVED (verified 2026-07-18):** matching an owned enum local to inspect its
shape no longer consumes it. Verified beyond what the fix claimed — it holds when
the arm *binds* a Copy payload, not only when payloads are ignored with `_`:

```milo
enum V { A, S(string), N(i64) }
let v = V.N(7)
match v { V.N(x) => {...} _ => {} }
match v { V.N(x) => {...} _ => {} }   // was: use of moved variable 'v'
```

`objHandle`/`funcHandle` remain in milojs because they read well at call sites,
but they are no longer forced.
**Cost:** boilerplate accessors, and the failure lands as "use of moved variable"
far from the `match` that caused it.
**Proposed fix:** allow `match` through a borrow — either implicitly when no arm
binds a non-Copy payload by value, or explicitly via a borrow-match form. Even
just allowing `match` on a `&T` subject would remove the helper-fn tax.

**RESOLVED (2026-07-18) — the implicit-borrow option, conservatively.** Matching an
owned enum *local* now borrows instead of moving **when no arm binds a non-Copy
payload to a named binding** — i.e. every non-Copy payload is a `_` (or the payload is
Copy). The subject stays usable afterward. The doc's exact repro compiles as-written
(the `_` arm covers `S(string)`), and a "what shape" match that reads only Copy
payloads never consumes. Mechanically this reuses the existing place-match machinery
(`match s.field` / `v[i]` / `*h` already borrow): `checkMatchLike` sets `subjBorrows`
for the owned-Ident case, so non-Copy `_` payloads bind as `&T` and the subject isn't
`tryMove`d (`src/checker.ts`); codegen reads the local in place with no zeroing, so the
owned local's normal scope-end drop still fires exactly once (verified leak/double-free
clean over 100k heap-payload iterations). Fixture `tests/fixtures/matchOwnedInspect.milo`.

**What is NOT covered (deliberately):** a *named* non-Copy binding — `V.S(s)` where you
then only read `s` — still consumes, because a named binding is allowed to move the
payload out and the checker can't yet prove you didn't. The fix is purely additive (it
never changes a binding's type), so it can't break code that legitimately destructures
owned data. If you only want to inspect, bind the non-Copy payload as `_`. Full
match-ergonomics (bind `s` as `&string` when it isn't moved out) is the larger,
potentially-breaking change left for later; so is allowing `match &v` / a `*V` subject.
The `objHandle`/`funcHandle` helpers in `value.milo` can now be inlined where their
payloads are Copy or ignored.

## 6. No float exponent literals (`1.0e18`) — and the diagnostic depends on position

Exponent notation is not lexed. `1.0e18` becomes the number `1.0` followed by the
identifier `e18`, so the failure mode varies by where it appears:
- statement position → `undefined variable 'e18'` (correct, but points at name
  resolution rather than at the missing lexer feature)
- control-flow header → `expected '{', got IDENT ('e18')`, which is baffling:

```milo
if n > 1.0e18 { }        // expected '{', got 'IDENT' ('e18')
```
Not silent — the resolver always catches it, so no wrong values reach codegen.
**Cost:** in `milojs` this forced `1000000000000000000.0` spelled out in
`value.milo`'s ToInt32 range guard.
**Proposed fix:** lex `e`/`E` with optional sign as part of a float literal. Failing
that, have the lexer special-case a digit-adjacent `e<digits>` and say "exponent
notation is not supported" instead of surfacing it as an identifier.

**RESOLVED (2026-07-18):** `1e18`, `1.5e-3`, `2E+9` now lex as float literals.
`lexNumber` (`src/lexer.ts`) consumes `e`/`E`, an optional `+`/`-`, then digits — but
*only* when a digit actually follows, so a digit-adjacent identifier (`1x`, a bare
`1e`) is still left alone rather than mis-swallowed. Mirrored in the formatter's own
lexer (`examples/cli-tools/fmt.milo` `lexNumber`) — without that, `milo fmt` split
`1.0e18` into `1.0` + `e18` and corrupted the source (the "formatter is part of
definition-of-done" rule in action). Added `FLOAT` production to `docs/grammar.ebnf`
(floats were entirely undocumented) and fixture `tests/fixtures/floatExponent.milo`.
The `value.milo` spelled-out `1000000000000000000.0` can now be `1e18`.

## 7. `fn` is reserved, so it cannot be a struct field name (papercut)

`struct ClassMember { name: string, fn: i64, isStatic: bool }` is rejected with
`expected 'IDENT', got 'fn'`. Field position is unambiguous — no expression can
start there — so this is the same contextual-keyword issue resolved for `from`/`in`
in item 3, just for a different word. Renamed to `fnIdx`.
**Proposed fix:** allow keywords as struct field names (and as property names in
field-access position), the way item 3 made `from`/`in` contextual.

---

## Non-issues — checked and dismissed, recorded so they are not re-filed

- **Cast vs bitwise precedence.** `a & b as f64` parses as `a & (b as f64)`, same
  as C and Rust, and the mismatch is caught with a clear message
  (`type mismatch in '&': i64 vs f64`). Working as intended.
- **Compiler warnings polluting program output.** Warnings go to **stderr**;
  `milo run` keeps stdout clean. A milojs test harness that merged the streams with
  `2>&1` made all 16 fixtures appear to fail at once. Harness bug, not a Milo bug —
  commit ec61529's message describes this incorrectly.
- **Flag-loops / no `break`/`continue`.** Fixed long ago (item 2). `milojs` still
  has ~60 unconverted `var going = true` loops, but that is milojs debt, not a
  language gap.
- **Mis-indented `} else {` in milojs.** Not a formatter bug: indentation is derived
  from brace depth and `milo fmt` reports zero changes on the committed files. Any
  drift from scripted edits self-heals on the next format.

## 8. Pointer depth is a boolean, so `**T` is unspellable

`*T` is parsed as a flag rather than a level (`src/parser.ts:180`):

```ts
if (this.match(TokenKind.Star)) {
  const inner = this.parseType();
  return { ...inner, isPtr: true };   // already true for *u8 → no-op
}
```

so `**u8` and `*u8` produce the identical type, and `src/types.ts:45` wraps once
(`if (ty.isPtr) return { tag: "ptr", inner: result }`). The error direction
reverses depending on which side is which, which is the giveaway:

```
let pp: **u8 = <a **u8 value>   // declared as *u8 but got **u8
let pp: **u8 = <a *u8 value>    // declared as *u8 but got u8
```

The declared side collapses to `*u8` both times while the checker's inferred side
tracks true depth, so they can never agree. Parenthesised pointer types
(`**(*u8)`) are also a parse error.

**Cost:** any C API taking or returning `char **` is unreachable. Concretely,
`char **environ` and macOS's `_NSGetEnviron(): char***` cannot be declared, so
there is no way to enumerate the process environment from Milo. `milojs` had to
make `process.env` lazy (resolve unknown keys through `getEnv` on read) and still
cannot implement `Object.keys(process.env)` correctly.

**Proposed fix:** small — the checker's own `TypeKind` is already properly
recursive (`{tag:"ptr", inner}`); only the AST-facing `isPtr: boolean` is lossy.
Carry a depth (or nest the AST type) and have `typeFromAst` wrap N times. Also
allow parenthesised pointer types.

**RESOLVED (2026-07-18, commit `568f31c`):** exactly as proposed. `MiloType` now
carries `ptrDepth?: number` (`src/ast.ts`); the parser counts the stars
(`src/parser.ts`), `typeFromAst` wraps N times (`src/types.ts`), and both the
generic-substitution copy + the reverse `typeKindToMiloType` bridge and the LSP type
printer are depth-aware (`src/checker.ts`, `src/lsp.ts`). `*u8`, `**u8`, `***u8`,
`****u8` are now distinct; mismatches report the true depths (`declared as *u8 but got
**u8`). No codegen change — LLVM uses opaque `ptr`, so depth is a type-check-only
concern. A sanity cap errors past depth 16 (`pointer nesting too deep`) to catch
runaway `****…` typos; C99's ≥12 requirement and real uses (`char***`) sit well under
it. **Verified end-to-end:** `_NSGetEnviron(): ***u8` now type-checks and a real
environ walk (`envpp[0]` → `**u8`, `envp[i]` → `*u8`) enumerates the whole process
environment — so `Object.keys(process.env)` is now implementable. Fixtures
`tests/fixtures/ptrDepth.milo` + `tests/errors/ptrDepthMismatch.milo`.
**Still open (minor):** parenthesised pointer types (`**(*u8)`) — the star-counting
handles linear `***T` fine, so this wasn't needed for environ; left unspanned.
