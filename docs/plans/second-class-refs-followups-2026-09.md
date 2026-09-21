# Second-class references: follow-ups from the external review (2026-09-20)

An outside reading of the language pages (framed against Borretti's
"second-class references" essay) listed what it believed were open holes in
the reference model. Most were already closed in tree. This plan covers what
survived verification, with sequencing so agents can work it without
colliding.

## Verified state at HEAD ee3bcd5a

| Claim from the review | Repo reality | Status |
|---|---|---|
| Wrong-arena handle use is prose, not checked | `Handle<T>` carries `arenaId` + `generation` (`std/arena.milo:73`); identity check always on (`docs/safety-roadmap.md:43`) | closed |
| Callback zero-copy access is a proposal | `arenaWith` / `arenaRead` / `arenaModifyMut` ship (`std/arena.milo:282,317,339`) | closed |
| Closure capture of a borrow is unspecified | `docs/language-reference.md:2481`: borrow-capturing closure cannot escape; `move` required | closed |
| Ignoring `get -> None` is silent | `unused-result` warns on a discarded `Option`/`Result` (`src/checker.ts:5929`). Gap: `arenaFree`/`arenaSet`/`arenaModify` return `bool`, discarded silently | partial |
| Site says refs cannot be assigned to variables; patterns page shows `let key = line[0..4]` | `docs/site/language/ownership.md:60` says exactly that. Wrong: views bind to locals with a freeze (`language-reference.md:1554`) | open, doc |
| `Span._bufferId` forgeable, `Sealed._data` writable | True. `std/seal.milo:80` documents it: no per-field visibility, so `s._data = ...` on a `var` holder passes id and bounds and reads the wrong bytes | open, language |
| `unseal` leaves stale spans | Harmless: ids monotonic, `unseal` consumes the only `Sealed` with that id. Only the forge path above matters | closed |
| Handle typed by payload, not arena instance | True at the type level; runtime catches it | open, std |
| View of a non-self `&` param cannot be returned | True design limit (`language-reference.md:1554`) | open, design |

Not doing: first-class references / lifetimes. The docs already make that case.

## Work packages

### WP1. Docs: fix the site ownership page, extend the vs-rust matrix
Files: `docs/site/language/ownership.md`, `docs/site/language/vs-rust.md`,
`docs/memory-safety-vs-rust.md`.

- Rewrite the sentence at `ownership.md:60`. Correct rule: a reference is a
  parameter mode or a local view; a local view freezes its owner for the life
  of the binding; it cannot be stored in a struct or collection, captured by a
  closure, or returned except as a view of `self` from a method. Mirror
  `language-reference.md:1554`.
- Add matrix rows for: closure capturing a borrow (compile-time), zero-copy
  arena read via `arenaWith` (no interior alias), wrong-arena handle
  (runtime `None`). Readers concluded these were missing.
- Add a paragraph after `language-reference.md:1554` stating that a free
  function cannot return a view and naming the two spellings that work: a
  method on a wrapper type, or return offsets and slice in the caller.
  (WP5 dropped; this is its replacement.)
- Done: the three pages agree with `language-reference.md`; no sentence says
  references cannot be bound to a local.
- Verify: `bun test tests/docs*.test.ts` if it exists, else build the site
  (`docs/site`, `bun run docs:build` or whatever `package.json` names).

### WP2. `@mustUse` on functions; apply to arena and seal
Files: `src/parser.ts` (fn attributes), `src/checker.ts` (ExprStmt at
~5926), `docs/language-reference.md` (attributes section),
`std/arena.milo`, `std/seal.milo`, `tests/errors/`, `tests/fixtures/`.

- Add fn attribute `@mustUse`. In `ExprStmt`, if the callee is `@mustUse`,
  emit the existing `unused-result` warning with the same `let _ =` hint.
  Warning by default. Under the DO-178C / NASA safety profiles
  (`milo safety --safety=...`) a discarded `@mustUse` or `Option`/`Result`
  is an error, matching how those profiles make contracts mandatory
  (decided 2026-09-20). Pin with a `tests/safety/` case per profile.
- Annotate: `arenaFree`, `arenaSet`, `arenaModify`, `arenaModifyMut`,
  `arenaRead`, `arenaValid`, `frozenHolds`, seal `eq`/`text` if they return
  a bool or Option not already covered.
- Do not touch the existing Option/Result branch; `@mustUse` is for `bool`
  and `void`-looking results that encode failure.
- Self-host: fn attributes already parse in `src-milo/parser.milo`
  (see `@derive`, `@copyOnly`); confirm an unknown fn attribute is tolerated
  by the frozen `milo-self` before annotating std, or std stops compiling
  under selfhost (backlog #22 constraint).
- Done: `tests/errors/mustUseDiscarded.milo` pins the warning,
  `tests/fixtures/mustUseBound.milo` pins that `let ok = arenaFree(...)`
  is silent. `bun test` green, `bun run scripts/run-examples.ts` green
  (checker rule changed: mandatory per `AGENTS.md:32`).

### WP3. Per-field privacy: `_`-prefixed fields are file-private
Files: `src/checker.ts` (field access, field assign, struct literal),
`src/resolver.ts` if field names cross files there,
`docs/language-reference.md` (Visibility, ~2620), `std/seal.milo`
(delete the "cannot enforce until fields can be private" paragraph),
`docs/site/language/structs.md`, tests.

Design (decided 2026-09-20, replaces the `@private` attribute proposal):
- A struct field whose name begins with `_` can be read, written, or named
  in a struct literal only inside the file that declares the struct.
  Elsewhere: error `field '_data' of 'Sealed' is private to
  'std/seal.milo'`. Struct-literal construction of a type with any `_`
  field is therefore file-local; other files go through constructors.
- No syntax. Nothing for the frozen self-host to learn. Method and fn names
  are unaffected (`_sendFrame` is an ordinary name; fn visibility stays
  `pub`).
- Migration cost measured at HEAD: 47 distinct `_field` names across std,
  src-milo, examples; zero cross-file accesses (every `._x` hit outside the
  declaring file is a same-file method). Std already follows the
  convention; the compiler starts holding it.
- Derives (`Eq`, `Clone`, `Json`) are generated in the declaring file's
  scope and keep access. `@derive(Json)` keeps serializing `_` fields:
  serialization is not access. State that in the reference.
- Done: `tests/errors/privateFieldRead.milo`, `privateFieldWrite.milo`,
  `privateFieldLiteral.milo` (each: second file reaches a `_` field of a
  `pub struct` from the first); `tests/fixtures/privateFieldSameFile.milo`
  and `privateFieldDeriveJson.milo`. `bun test`, `run-examples.ts`,
  `sh scripts/selfhost.sh` + guarded selfhost
  tests (std changed).

### WP4. `TaggedArena<T, Tag>`: DROPPED to an idiom (decided 2026-09-20)
Built on `refs-wp4`, then evaluated before merge. Corpus: 35 arena-using programs
across the org, 29 with one arena, zero real programs with two arenas of one
payload type (the four that exist are `std/arena`'s own fixtures exercising the
runtime id check). Prior art: slotmap, generational-arena, id-arena, Bevy all
rely on the runtime check; none brand per instance. One recorded incident ever,
the 2026-07-22 library gap that `arenaId` closed. Cost was 229 std lines,
and the `with` method had to be dropped because
milo-self cannot build a method-level generic in std. Shipped instead: the
paragraph in `docs/milo-idioms.md` (phantom brand) showing the two-struct wrapper,
and `tests/errors/arenaBrandMixup.milo` pinning the compile error. Review row
closed by idiom.

### WP5. `lend` on a free function: DROPPED (decided 2026-09-20)
No keyword exists today; a method returning a view of `self` uses a plain
`&[T]` return type and the checker infers the freeze. `lend` would be new
syntax that widens the one place a reference leaves a function, which is
the region the review called the soundness knife-edge. Measured payoff is
small: 30 `substr` sites and 28 `(&string) -> string` free fns in std, most
building a genuinely new string. Replace with a paragraph at
`docs/language-reference.md:1554` naming the two spellings that work: a
method on a wrapper type, or return offsets and slice in the caller.
Reopen only when a real program hits the copy tax. Fold that paragraph
into WP1.

### WP7. Corpus census as a maintenance sweep (added 2026-09-20; SHIPPED 2026-09-20)
Shipped as `scripts/corpus-census.ts` + `scripts/corpus-census.baseline.json`; the
script classifies `exit`/`close` as FFI, so its split is 620/37 where the hand count
below said 594/62. Both recorded in the doc section.

Files: new `scripts/corpus-census.ts`, `docs/memory-safety-vs-rust.md` (new
section "What the corpus says"), `AGENTS.md` router row.

Source: the 2026-09-20 census over every `.milo` file in the org (~290k lines:
milo std/examples/src-milo/fixtures, milojs, emulators, dapweb, aws, postgres,
redis, toml, yaml, markdown, json-rpc, gl, sdl; worktrees and node_modules
excluded). Findings to record verbatim, they are the falsifier for the
second-class-reference bet:
- 656 `unsafe` blocks; 594 (91%) contain an extern call or pointer cast (FFI).
  Of the 62 non-FFI, 35 are outside std: `exit(1)` in src-milo (12), fd/pty
  ownership in dapweb (8), giflib buffer handoff (4), raw read/napi in milojs
  (4), GL buffers (3), SDL host pointers (2). Zero blocks exist because the
  ownership model rejected the program.
- `.clone()` per kLOC: src-milo 58, redis 41, dapweb 37, aws 25, milojs 12.5,
  std 5, examples 3.8, emulators 0.6. Receivers are strings (`name`, `ty`,
  `key`); the tax is string clones and owned-copy accessors, not pointers.
- 22 friction comments outside std name a Milo limit: 10 are second-class refs
  (all restructured to owned/pool/index, none to unsafe); 12 are missing
  features: derive Clone for enums, method-level generics (4 in std alone),
  default field values, Ord trait, import aliasing, extern variables, bitcast.
- Attributes user code actually uses outside std/fixtures/src-milo: `cValue`,
  `embedFile`, `cSig`, `externalLinkage`, `sym`, `link`, `wrapping`, `derive`,
  `cLayout`, `noCopy`. Every soundness-sweep attribute (`copyOnly`, `copyOut`,
  `thread`, `parks`, `synchronized`, `pure`, `iter`, `cOpaque`) is std-only.

Work:
- Port the census (python in the session scratchpad; the metrics above) to
  `bun scripts/corpus-census.ts [--json]`. Roots: `std`, `examples`,
  `src-milo`, `tests/fixtures` here, plus every sibling under
  `~/git/milo-language/` that exists (missing checkouts skip, like
  `check-packages.sh`). Per root: kloc, fns, unsafe blocks split
  ffi/rawptr/other with the preceding comment for each non-FFI block,
  clone/kLOC, substr/kLOC, `arenaGet` vs borrowing-read count, `.ptr()`,
  `.addrOf()`, `Heap<`, attribute histogram, friction comments (the regex from
  the session: workaround / can't|cannot return|store|borrow|hold / no
  lifetimes / second-class / Milo has no|does not|can't). Print the table;
  `--json` dumps everything.
- Gate that cannot be gamed: `--check` compares `unsafe_nonffi` per root and
  the count of non-FFI unsafe blocks outside std against a committed baseline
  `scripts/corpus-census.baseline.json`; may shrink, never grow. Refresh with
  `MILO_CENSUS_UPDATE=1`.
- Record the findings in `docs/memory-safety-vs-rust.md` as a dated section
  and add the script to the AGENTS.md router and the maintenance sweep list in
  `docs/testing.md` (or wherever the fuzzers are listed).
- Done: `bun scripts/corpus-census.ts --check` green; the doc section cites
  the numbers above; `bun test tests/docs.test.ts` green.

### WP8. Census follow-ups in std (revised 2026-09-20; SHIPPED 2026-09-20, `7fd24906`)
`Arena.with<R>` added; `selectRecv`/`selectSend` became `Select.onRecv`/`onSend`
(free fns removed, 7 callers swept); `recvTimeout` stays free with the real reason
(Channel lives in std/sync, an extension impl here would be import-order visible).

Both candidate backlog entries already exist or are shipped:
- derive `Clone`: backlog Tier 1 #31 (filed 2026-08-17). Add the census
  evidence to that entry (redis `RedisValue.clone` hand-written, src-milo
  `ast.milo:342` "no auto-derive for Clone; deep clones are hand-written",
  58 clones/kLOC in src-milo), do not file a duplicate.
- method-level generics: SHIPPED 2026-08-17 (backlog #22). Verified
  2026-09-20: `impl Box2<T> { fn with<R>(self: &Self, f: (&T) => R): R }`
  infers `R` at the call site, on a generic struct. So three std comments
  are stale and one API is missing:
  - `std/arena.milo:302` ("arenaWith ... cannot be a method: a method's own
    type parameter is never inferred") and the `get` doc at ~680 that repeats
    it: add `Arena.with<R>(self: &Self, h: Handle<T>, f: (&T) => R): Option<R>`
    delegating to `arenaWith`, fix both comments, mention it in the WP1 matrix
    row.
  - `std/timer.milo:180` and `std/select.milo:22` ("Milo has no method-level
    generics"): convert to methods if the surrounding API wants it, otherwise
    fix the comment to state the real reason.
  Files: `std/arena.milo`, `std/timer.milo`, `std/select.milo`,
  `docs/backlog.md`, `tests/fixtures/arenaWithMethod.milo`. Runs after WP3
  merges (std sweep overlap). Done: fixture green, `sh scripts/selfhost.sh`
  green, `docs/std/arena.md` regenerated (`bun scripts/gen-std-docs.ts`).

### WP9. Stale workaround in emulators (added 2026-09-20; SHIPPED 2026-09-20, emulators `fe12009`)
ROM clone removed, `fxRun(&mut m.fx, m.rom, burst)`; Star Fox frame hash identical
at 300 and 1200 frames before/after, verify-contracts 4/4, web core still emits.

Repo: `~/git/milo-language/emulators`, file `snes/superfx.milo:8`: "ROM is
cloned in (read-only) ... sidesteps the second-class-ref rule against
borrowing two &mut Mem fields at once". Disjoint field borrows compile today
(verified 2026-09-20: `step(m.rom, m.ram)` and `both(m.rom, m.ram)` with two
`&mut` params both type-check). Remove the ROM clone and borrow the field;
run the emulators' own test suite and the SNES test ROMs it names. If the
clone turns out to exist for another reason (the comment also names core
isolation for the since-removed JS backend), fix the comment instead and say so.
Done: suite green, comment true.

### WP6 (deferred). Safety-profile lint: no bare integer index into a pool
Wait for backlog E6 (collection-declared key type). Not scheduled.

## Dependencies

```
WP1 (docs)            independent of everything
WP2 (@mustUse)        checker.ts ExprStmt, parser fn-attrs
WP3 (@private)        checker.ts field access, parser field-attrs, std sweep
WP4 (TaggedArena)     std only; wants WP3 for a strippable-brand fix
WP5 (lend)            dropped; see WP5
```

Conflicts: WP2 and WP3 both edit `src/checker.ts` and `src/parser.ts`.
Different regions, but the merge risk and the shared `run-examples` gate
make them serial. WP3 and WP4 both edit `std/arena.milo` if WP4 lives there;
put WP4 in its own file to avoid that.

## Sequencing

Recommended: two waves, then a serial tail.

**Wave 1 (concurrent, three worktrees):**
- WP1 docs
- WP2 `@mustUse`
- WP4 `TaggedArena` in its own std file, without `@private`

Merge order inside wave 1: WP2 first (checker gate), then WP4, then WP1.
Rebase each on the previous before its gate run.

**Wave 2 (single worktree, after wave 1 merged):**
- WP3 `@private`. Its std sweep also covers WP4's wrapper and removes the
  TODO. Largest change; gets the full gate set including selfhost.

**Tail:** none. WP5 dropped.

If running one agent at a time (default per the orchestrator rules), order is
WP2, WP3, WP1 (WP4 dropped to an idiom, see its section).
Then WP8 (std follow-ups), WP7 (census script), WP9 (emulators, other repo). WP1 sits third so its matrix rows can cite WP2 and
WP4 by their shipped names.

Every package: own worktree, small green commits, gates listed under its
"Done" before merge. Any checker change runs `bun run scripts/run-examples.ts`.
Any std change runs `sh scripts/selfhost.sh` before the selfhost tests.

## Unresolved questions

1. Resolved 2026-09-20: `_`-prefixed fields are file-private, no syntax.
2. Resolved 2026-09-20: `lend` dropped. WP1 absorbs the reference paragraph.
3. Resolved 2026-09-20: `@mustUse` is an error under the DO-178C / NASA
   safety profiles. Folded into WP2.
