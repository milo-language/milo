<!-- doc-meta
system: planning
purpose: work plan for closing backlog #31, uniform .clone() over enums, Option/Result and arrays, plus the explicit-derive ordering bug
key-files: src/checker.ts (processDerives, deriveClone, canAutoClone, monomorphizeEnum), tests/fixtures/cloneDerive*.milo, tests/errors/cloneDerive*.milo
update-when: a work package ships, is re-scoped, or its gate changes
last-verified: 2026-09-20 (WP1 48f1e14c, WP2 7a3344b4, WP3 4f88bae6, WP5 docs+backlog shipped; WP4 arrays deferred, zero census hits)
-->

# Derive Clone: close #31

Status 2026-09-20: `Clone` IS derivable and auto-derived for plain structs since
cbf680e7 (2026-08-24). Backlog #31 was never updated; WP8 added census evidence
to a stale title. What remains is coverage, so `.clone()` is one uniform
spelling the two diagnostics can name without a "for most types" footnote.

## Measured gaps (scratch probes, all with `milo run`)

| # | Shape | Result today |
|---|-------|--------------|
| G1 | `@derive(Clone) struct Q { p: P }`, `P` plain and NOT explicitly derived | `cannot derive Clone for 'Q': field 'p' of type 'P' has no clone`. Ordering bug: explicit derives are validated before the auto fixpoint runs, so `P` is not yet clonable. |
| G2 | `enum E { A, B(string) }`; `e.clone()` or a struct holding `E` | `no method 'clone'`. No enum derive, no enum auto-derive. Hand-written `impl Clone for E` works and IS honoured by a struct's derive once the struct is clonable. |
| G3 | `Option<string>.clone()`, `Option<P>` field | `no method 'clone'`. `Option`/`Result` are generic enums; falls out of G2 once monomorphized enums propagate derives like structs do (`monomorphizeStruct` does, `monomorphizeEnum` does not). |
| G4 | `[string; 2]` field | not clonable; `canAutoClone` has no `array` arm. |
| G5 | `struct Pair<T>` without `@derive(Clone)` | not auto-derived (`typeParams.length > 0` skip). Explicit `@derive(Clone)` works and propagates per instantiation. Matches Rust; keep. |

## Work packages, in order

WP1 G1. `processDerives`: stop synthesizing explicit `Clone` in the attribute
loop; put explicit names in the same fixpoint as auto (they are candidates that
must not be skipped, and that error instead of silently dropping out when the
fixpoint closes without them). After the loop, `deriveClone(s)` for any explicit
name not in `cloneDerived`, so the validation error names the field that
blocked it. `canAutoClone` in the validation path takes `cloneDerived` as
`pending`. Lock: `tests/fixtures/cloneDeriveExplicitOverAuto.milo`.

WP2 G2. `deriveCloneEnum(e)`: synthesize
`fn clone(self: &Self): E { match self { E.V(a, b) => E.V(a, b.clone()), E.U => E.U } }`
(Copy payload bare, else `.clone()`). Enter enums into the SAME fixpoint as
structs (`struct A { e: E }`, `enum E { X(A) }`, `enum T { N(Vec<T>) }` all
close). Exclusions mirror structs: `Drop` impl, `@noCopy`, hand-written `impl
Clone`, `isOpaque`, a closure or interface payload. `canAutoClone` gains an
`enum` arm: `typeImplementsTrait(name, "Clone") || pending.has(name)`. Explicit
`@derive(Clone)` on an enum goes through `synthesizeDeriveImpl` (needs an
EnumDecl overload; `Eq`/`Json` on enums stay as they are). Lock: fixtures for
payload enum, recursive enum, struct-of-enum; error tests for Drop enum and
closure payload.

WP3 G3. `Option`/`Result` are checker builtins (`registerBuiltinOption`, no
source decl, no attributes), so "propagate from the decl" has nothing to read.
Design, resolved 2026-09-20: a monomorphized generic enum whose base is
`Option`/`Result` (later: any generic enum or struct carrying `@derive(Clone)`)
gets Clone CONDITIONALLY, the way Rust's derive adds a `T: Clone` bound: only
when every payload type `canAutoClone`s, silently skipped otherwise (an
`Option<closure>` must stay legal, it just has no clone). Two entry points,
because instances appear at two times: (a) instances that already exist when
`processDerives` runs join the struct/enum fixpoint (iterate `this.enums`
whose `baseName` qualifies, concrete variant field types, `pending` honoured);
(b) instances monomorphized later (inside a body, `let o: Option<P>`) derive at
`monomorphizeEnum` time, mirroring the struct propagation at checker.ts:1967,
when every referenced type is already registered. A user's explicit
`@derive(Clone)` on their own generic enum keeps the struct rule: propagate per
instantiation and ERROR when a payload cannot clone. `canAutoClone` for an
enum instance of a qualifying base: all payload types clonable (structural,
so the fixpoint closes over `struct Q { o: Option<Q2> }` before the impl
exists). Lock: `Option<string>.clone()`, `Option<P>` field, `Result<P,
string>` field, `Option<closure>` field makes the struct non-clonable with
the explicit-derive error naming the field, and `Option<i32>` stays Copy.

WP4 G4. Arrays have NO builtin `.clone()` (checked: the array method site
knows `len`/`slice` only). Options: add a sized-array `.clone()` builtin
(checker method + codegen element loop, reusing whatever `indexAccessClones`
emits per element), or expand to an array literal of N per-element clones in
the synthesized body (no codegen work; AST grows with N, unacceptable for
`[string; 1024]`). Builtin is the honest one. Decide after WP3 lands; G4 has
zero census hits, so skipping is defensible.

WP5 Docs + backlog. `docs/language-reference.md` derive section: what Clone
covers, what it refuses and why. Backlog #31: strike, cite cbf680e7 + this
plan's commits, and note G5 as the one deliberate non-coverage. The two
diagnostics that name `.clone()` need no text change once coverage is uniform.

## Gates (every WP)

- `bun test tests/run.test.ts -t clone` (new fixtures + error tests)
- `bun test tests/indexCloneLint.test.ts`
- over-rejection sweep: `bun scripts/build-all-examples.sh` equivalent (see
  AGENTS.md), 7 sibling package suites, milojs. Zero new rejections; the auto
  fixpoint now synthesizes MORE impls, so watch for a synthesized body that
  fails to compile inside std (the Vec<closure> precedent).
- `index-clone` census: the 9 std sites listed in #31 must each accept
  `.clone()` (compile a synthetic file per site shape).
- self-host does not gate std (CLAUDE.md, 2026-09-20).

## Not in scope, stays open

The second half of #31: the implicit `v[i]` copy bypasses a hand-written
`clone` at every nesting level. Uniform `.clone()` makes the lint's escape
hatch honest; it does not make `v[i]` and `v[i].clone()` the same operation
when a user impl exists. File separately if it matters after this lands.

## Unresolved

1. Resolved: conditional derive for `Option`/`Result` (WP3 above).
2. WP4 arrays: skip if the compiler has no array clone builtin and the literal
   form needs codegen work; G4 has no census hits.
