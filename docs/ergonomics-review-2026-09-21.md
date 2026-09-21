<!-- doc-meta
system: ergonomics-review
purpose: two outside ergonomics reviews of Milo (2026-09-21), merged into one list to walk and implement; status column says what already exists
key-files: docs/backlog.md, docs/milo-idioms.md, CONVENTIONS.md, examples/
update-when: an item ships (mark it), or a status claim is found wrong
last-verified: 2026-09-21
-->

# Ergonomics review, 2026-09-21

Two independent reads of the repo, both asking "would a TS / Go / C / Rust / Python
developer find this ergonomic?". Both landed on the same verdict: **the surface is
ergonomic, the ownership bet is coherent, and daily code in the examples reads like C with
a move checker.** The corpus teaches a different language than the book: `while pos <
s.len`, `ch == 10`, `s = s + t`, index soup, match pyramids over `Option<Handle>`.

The plan is to keep second-class references and make every replacement pattern as short
as the borrow would have been.

## Per-background verdict (both reviews agree)

| Background | Verdict |
|---|---|
| TypeScript | Syntax feels native (`let`/`var`, `=>`, `??`, `$"..."`, `from ... import`). Bounces on moves and on move-out-of-container zeroing a slot with no diagnostic. Likes `webserver.milo`, dislikes `linkedList.milo`. |
| Go | Closest cousin on the app side: `Result` is a typed `err != nil`, explicit `&mut`, static binary. Alien on memory: first stored `&T` is rejected. |
| C | Strongest yes. `grep`/`jq`/`htmlParse` are C programs in a different spelling, with a seatbelt. Misses returning a pointer into a buffer; `arenaModify` by value is the worst sample. |
| Rust | Understands it in five minutes, argues all afternoon. Wants `Some`/`Ok` unqualified, nested patterns, borrowing iterators. Honest census (13% stored-view shapes) is the right pitch. |
| Python | Hardest onboarding. Types everywhere, `Result` on every I/O call, moves. Softer on-ramp than Rust until the first move error. |

## Items

Status: **exists** = the language/std already has it and the examples do not use it;
**partial** = some of it shipped; **open** = not started. Backlog numbers refer to
`docs/backlog.md`.

### In flight (this session)

| # | Item | Status |
|---|---|---|
| S1 | Compound assignment `+=` etc. | **exists** (parser + formatter). Was undocumented and unused: 0 uses in std, 189 `i = i + 1`. Docs and corpus migrated 2026-09-21. |
| S2 | Formatter: one-line brace groups stay inline; `}` hugs a following `)`, `]`, `,`, `.` (170 `}` / `)` splits in examples) | in progress |
| S3 | Prelude `Some`/`None`/`Ok`/`Err` resolving to the `Option`/`Result` variants when nothing else in scope has the name | in progress |
| S4 | `&self` receiver: no sugar; a targeted diagnostic ("write `self: &Self`") like the `++` one | in progress |
| S5 | **Safety**: `let s = v[i].text` moves and zeroes the slot silently while `let m = v[i]` deep-clones (lint `index-clone`). Needs a diagnostic at the field-through-index move. | **shipped** `67677389`: `cannot move 'v[...].text' out of 'v'`, hint names `.clone()`, `remove`/`pop`, `replace`. Zero hits in std, examples, sibling packages and milojs. |

### Language

| # | Item | Status / notes |
|---|---|---|
| L1 | In-place arena mutation: `arena.modify(h, (n: &mut T) => ...)` | **exists**: `arenaModifyMut` and `Arena.modifyMut` in `std/arena`. `linkedList` and `depgraph` use it since 2026-09-21; two copy-out `arenaModify` sites remain elsewhere. Deprecating the by-value form still open. |
| L2 | Flatten handle walks: `while let`, `for i, x in v` | **exists** (both). Used by the five rewritten examples; see E1. Rewriting them found three compiler bugs (below), which is the argument for finishing E1. |
| L3 | Default field values / `..base` struct update / `@derive(Default)` | **open**, backlog #9. Pick one shape; move interaction is the real work. |
| L4 | Named enum variant fields `ForEach { varName: string, body: Handle<Stmt> }` | **open**. Payoff in src-milo, minilang, htmlParse. |
| L5 | Nested patterns `Ok(Some(x))` | **open**. Docs say "patterns are one level deep". Forces the pyramids the idioms doc warns against. |
| L6 | Closure call forms `v[0]()`, `(makeFn())()`; once-typed move closures | **partial**: once-typing shipped (`callsOnce`). Parse holes per backlog #29. |
| L7 | Generic struct literal with explicit args `And<i64, bool> { ... }` | **open**, backlog #40. |
| L8 | Named arguments for adjacent same-type params (lint first) | **open**. |
| L9 | Typed handles / `Index<K>` so `nodes[h]` accepts only that arena's handle | **partial**: brand-by-wrapper pattern documented in idioms; no std helper on purpose. |
| L10 | `@embedDir("assets")` | **open**. |
| L11 | FFI pointer sugar: `ptr == null`, `ptr.offset(n)`, keep `unsafe` | **open**. |

### Stdlib

| # | Item | Status / notes |
|---|---|---|
| T1 | Take `&string` at library boundaries (`fromJson`, `jsonStringify`, path helpers); `readDir` names without a clone to recurse | **open**, backlog #14. |
| T2 | One string story: `String.builder()` or a plus-in-loop lint; byte vs text split in names; `codePoints()` in examples | **partial**: `pushStr`, `codePoints()`, `std/unicode` exist. Lint `string-concat-in-loop` shipped 2026-09-21, off by default: 91 sites in examples (`pushStr` had 3 uses in the whole corpus). Flip it on once those are migrated. |
| T3 | Cursor protocol as a type: `interface Scan<S, T> { fn next(self: &mut Self, store: &S): Option<T> }`, `for e in store.scan()` | **open**. `kvstore.milo` is the hand-rolled exhibit. |
| T4 | JSON: byte-feed/incremental parser; `jq.milo` on `std/json` (`strPath`, cursor API) | **partial**: `strPath` and `curRoot` family exist; `jq.milo` is on `std/json` since 2026-09-21 (379 to 120 lines, `Step` enum). Incremental parser open. |
| T5 | `.clone()` exists whenever a diagnostic says to clone: derive on enums, `index-clone` semantic half | **partial**: `@derive(Clone)` on enums shipped. `let m = v[i]` still clones silently (lint on by default); see S5 for the field case. |
| T6 | Contracts in something people run: `requires`/`ensures` in `std/path`, `kvstore` page math; `milo prove` in CI for them | **partial**: `kvstore` carries them since 2026-09-21, but `milo prove` marks every one `unknown`: the SMT translation has no model for `Vec` length or indexing, so contracts over collections are debug-build assertions only. Making T6 real is prover work (a length symbol per Vec), not example work. |

### Diagnostics / tooling

| # | Item | Status / notes |
|---|---|---|
| D1 | Stable error codes (`E-MOVE-USE`, `E-REF-STORED`, `E-INDEX-CLONE`, ...) and `milo fix` for the common clone/borrow fixes | **partial**: `milo fix` exists for mechanical diagnostics; no codes. Backlog A6. |
| D2 | Move-out-of-container diagnostic | see S5 |

### Examples / product

| # | Item | Status / notes |
|---|---|---|
| E1 | Rewrite the example corpus to CONVENTIONS: `pushStr`, `for x in xs`, `while let`, `arenaModifyMut`, `jq` on `std/json`, no `entries[i].name.clone()` once T1 lands | **partial**. `linkedList` (157 to 80 lines), `kvstore`, `depgraph`, `tree`, `jq` rewritten 2026-09-21. Census of the other 197 files that day: 814 qualified `Option.Some`, 398 `ch == 10` byte numerals, 32 `0 - 1` sentinels, 14 `var done = false` loops, 91 string `+=` in loops. The mechanical rows are being swept; `pushStr` adoption is the lint's worklist. |
| E2 | One short "patterns without lifetimes" example: kv scan, AST handles, sealed spans | **open**. |
| E3 | Fix `return 0 - 1 as i64` and similar in showcase files | **shipped** for `kvstore` (`slotIn` returns `Option<i64>`); the other 32 sentinels are in the mechanical sweep. |

### Compiler bugs the rewrites exposed (all fixed 2026-09-21)

| Commit | Bug | How it pushed code toward the anti-idiom |
|---|---|---|
| `1039d2fd` | An `Option`-valued `if`/`match` expression warned "unused Option value" on every arm tail | `cur = if fwd { n.next } else { n.prev }` warned twice, so people wrote the statement form |
| `83343b2f` | An `if let` body that always returns leaked its moves past the if | `if let Some(i) = find() { v[i] = value  return }` then `push(value)` was "use of moved variable", so people kept the `-1` sentinel and `if slot >= 0` |
| `386a643c` | A statement `match` demanded braced arms (the grammar never did), and a `match` at the tail of an if-expression block was a statement, not the value | `let x = if c { match ... } else { ... }` did not parse, so the `var x = ""` then assign shape stayed |

The S5 handoff note about a silent zero through `o!.text` on an owned binding did not reproduce: `let`, `var`, struct-field and `&`/`&mut` roots all reject or move the whole binding.

### Do not spend on

First-class stored `&T` or lifetimes. Copy that says Milo "feels like TypeScript". A
trait/HKT system. Async coloring. Self-host work ahead of these.

## Suggested order

1. S1-S5, E3: done.
2. L1 adoption + E1 for `linkedList`, `depgraph`, `tree`, `jq`, `kvstore`: done. Next: the mechanical sweep of the other 197 files, then the 91 `pushStr` sites, then flip `string-concat-in-loop` on.
3. T1 (`&string` boundaries): clone tax drops with no new concepts.
4. L3 defaults, L5 nested patterns, L4 named variant fields.
5. D1 error codes, T3 cursor protocol, L6/L7 parse holes.
6. L10, L11, T4, T6.
