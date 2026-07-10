# Self-Hosting Plan (v2 — 2026-07-08)

Goal: `milo-self` (the Milo compiler written in Milo, in `src-milo/`) compiles
itself, and the bootstrap converges. This doc is written to be executable by an
implementing agent with no other context: every milestone has a command-line
acceptance test, and the rules in "Working Agreement" are mandatory.

## Current State (verified empirically 2026-07-08)

- `src-milo/` is ~8,220 lines across 18 files. Pipeline in `main.milo`:
  `tokenize → parse → resolveImports → checkProgram → genProgram(AST)`.
  Commands: `build`, `run`, `emit-ir`, `check`.
- **It compiles** with the TS compiler (`bun run src/main.ts build
  src-milo/main.milo -o milo-self`, ~2.3s) **but crashes at runtime on every
  input**, including `fn main(): i32 { return 0 }` — varying signals
  (SIGSEGV/SIGABRT/SIGKILL) suggest memory corruption or runaway allocation.
  Last src-milo commit (c7ef5ea, 2026-07-07, "checker state reworked to
  copy-back lookups") is the prime suspect but is unverified — there is no
  test harness, so the breakage landed silently.
- Phase completeness: lexer/parser done; checker largely done (expr, stmt,
  mono, traits); codegen is **AST-directed and partial** — no `for`-in, no
  `if let`, no `!` (unwrap), no `?` (propagate), no index assignment
  (TODOs at `codegen/stmt.milo:33,237,267`, `codegen/expr.milo:392,396`).
- `hir.milo` + `lower.milo` (~1,000 lines) are **dead code**: scaffolded but
  never imported; codegen consumes the AST directly.
- TS oracle sizes: checker.ts 4,749 / codegen.ts 7,379 / total core ~15.4K
  lines. milo0's checker is a real port; its codegen is ~1,400 lines vs the
  TS 7,400 — the gap is mostly language *breadth*, which bootstrap does not
  fully need (see below).

### The two goals, in order

1. **Bootstrap** — milo-self compiles `src-milo/` itself and converges.
   Requires only the language subset milo0 is *written in*: Vec (incl.
   nested `Vec<Heap<Expr>>`), HashMap<string,V>, Heap-based recursive enums,
   payload enums + match, Option/Result with `!`/`?`, for-in, if-let,
   strings, structs, impl blocks. **Not required:** closures, user-defined
   generic fns/structs, traits beyond `impl Clone for X`, threads, green
   runtime. Do not build what bootstrap doesn't need.
2. **Parity** — milo-self passes the fixture suite (`tests/fixtures/`,
   `tests/errors/`). Full language. Comes after bootstrap; tracked by
   ratchet, may ship incomplete with an explicit exclusion list.

## Working Agreement (mandatory for the implementing agent)

- **Oracle**: the TS compiler (`src/*.ts`) is ground truth. Never change TS
  compiler behavior and milo0 behavior in the same commit. If the oracle
  itself is wrong, stop and flag it.
- **Ratchet**: `tests/selfhost-manifest.txt` lists fixtures milo-self must
  pass. Every commit must keep the manifest green; grow it, never shrink it
  (a temporary shrink requires a `# SHRUNK: <reason>` comment line and a plan
  to restore).
- **Commit cadence**: one green milestone (or sub-task) per commit, direct to
  main, one-line lowercase message. Run `bun test tests/selfhost.test.ts`
  before every commit; run the full `bun test` before ending a session.
- **When stuck >2 sessions on one task**: don't grind. Options in order:
  (a) shrink the repro with `emit-ir` diffing, (b) extract the failing
  pattern into a new fixture and fix the milo0 phase it exposes,
  (c) mark deferred in this doc with the repro path, move on.
- **Memory guard (MANDATORY)**: milo-self can allocate without bound, and
  macOS enforces no rlimits — an unguarded run has consumed all system RAM
  and crashed the machine (twice). Defense in depth now makes the default
  paths safe: `.selfhost/milo-self` is a self-guarding wrapper (real binary:
  `milo-self.bin` — NEVER run the `.bin` bare), `milo run`/`milo test` guard
  their children by default, guardedRun plants an in-pgid shell watchdog that
  survives even the death of the bun process that spawned it, and the sweep
  caps concurrency×mem below half of RAM. Manual guarded run of anything else:
  `bun scripts/guard.ts [--mem-mb N] [--timeout-s N] -- <cmd> <args>`.
  **RSS alone is not enough** (learned 2026-07-09: a sweep runaway reached
  ~80GB phys_footprint while its RSS sat under cap — the compressor absorbs a
  runaway's pages under pressure, so RSS plateaus exactly when the machine is
  dying; only the 60s wall timeout ended it, after the OS hit the
  "out of application memory" dialog). guard.ts therefore also enforces the
  per-tree cap against **phys_footprint** (footprint(1), includes compressed,
  1Hz) and sheds guarded trees on **system memory pressure**
  (`kern.memorystatus_vm_pressure_level`: critical → kill all, sustained
  warning → kill largest per tick; both watchdog layers check it). Pressure
  kills are fail-closed on purpose: guarded children die even when another app
  caused the pressure.
  Binaries **compiled by** milo-self are equally untrusted — run them through
  guard.ts too. The test harnesses already do all of this.
- **Debugging playbook**: crash → `lldb -b -o run -o bt ./milo-self.bin <cmd>`
  (lldb runs can't be guard-wrapped — watch Activity Monitor and keep inputs
  tiny); wrong output → `diff <(bun run src/main.ts emit-ir f.milo)
  <(.selfhost/milo-self emit-ir f.milo)` (wrapper self-guards); regression →
  `git log --oneline -- src-milo/` and bisect by rebuilding milo-self at each
  candidate commit.
- Known runtime gotcha already fixed in TS codegen: allocas are hoisted to
  the entry block (loop-body allocas leak stack). milo0's codegen must do the
  same from day one (`codegen/emit.milo` — see `hoistAllocas` in
  `src/codegen.ts` for the invariant and `tests/allocaHoist.test.ts`).

## Data-Structure Guidance (read before touching checker state)

Milo has no stored/returned references, so the TS compiler's core idiom —
`map.get(name)` returns a live object, mutate it in place — cannot be
translated literally. src-milo currently uses **copy-back**: clone the entry
out, mutate the clone, re-insert (`checker/state.milo:169` `lookup` returns a
cloned `VarInfo`; the write-backs are the `ck.scopes[i].insert(name.clone(),
updated)` calls at `state.milo:188` and `:206`). Copy-back done ad hoc is
both slow (every `VarInfo` clone deep-clones its recursive `TypeKind`) and
bug-prone (stale write-backs; clone/drop interactions on `Heap` payloads) —
and it is the prime suspect for the current crash. Do not extend the pattern.
Two sanctioned replacements, in order of preference:

1. **Intern types; index everything.** The single highest-leverage change.
   Add a type interner to `Checker`: `typeTable: Vec<TypeKind>` plus
   `type TypeId = i64` handles. Interned equal types share one id, so
   `typeEq` on interned types becomes integer compare, and `VarInfo.ty`
   becomes a Copy `TypeId` — after which cloning a `VarInfo` is trivially
   cheap and copy-back loses most of its danger and all of its cost. This is
   not a workaround: rustc interns all types in `TyCtxt` for the same reason
   (reference graphs fight the ownership model even *with* lifetimes).
   Compilers are table-shaped; lean into it. Same trick applies to any other
   hot recursive value (e.g. monomorphization keys in `checker/mono.milo`).

2. **`std/arena` for mutate-in-place.** Already shipped: generational
   `Arena<T>` / `Handle<T>` (Copy, storable — legal where `&T` is not).
   The API that kills copy-back is `arenaModifyMut(a, h, (v: &mut T): void
   => { ... })` — in-place mutation through a closure, no clone-out, no
   write-back, no stale-copy window. `arenaWith(a, h, (v: &T): R => ...)`
   for reads, `arenaGet` where a clone is genuinely wanted. Usage example:
   `tests/fixtures/closureCaptureMutableLocal.milo`. Good fit for scope
   entries: store `VarInfo` in an arena, keep `HashMap<string, Handle>`
   per scope, mutate flags (`moved`, `borrowed`, `read`) via `modifyMut`.
   Caveat: `arenaGet` clones `T` out — keep arena'd structs small (which
   interning already does).

Sequencing: don't refactor preemptively. M1 first diagnoses the crash; if
the root cause is copy-back/clone corruption (likely), fix *forward* by
converting the offending table to pattern 1 or 2 rather than patching the
clone. Perf gate at M4: if self-compiling src-milo takes >60s, intern types
before optimizing anything else.

Other pre-approved escape hatches (from v1, still valid):
- HashMap codegen too hard for milo-self → sorted `Vec` + binary search
  (localized to `checker/mono.milo` tables).
- Recursive-enum ergonomics → `Heap<T>` is the answer; if a specific
  clone/drop pattern miscompiles, extract it to a fixture and fix the
  compiler — do not contort the milo0 source around it.
- String building too verbose → byte-index loops and `String.push`; no
  iterator machinery needed.

## Milestones

### M0 — Differential harness (do this first, nothing else until green)

The root cause of today's silent breakage. Build the safety net before
touching src-milo.

- `scripts/selfhost.sh`: builds milo-self via the TS compiler into
  `.selfhost/milo-self`, exits nonzero on failure.
- `tests/selfhost.test.ts` (bun test, mirrors `tests/run.test.ts`):
  1. build milo-self;
  2. smoke: `milo-self check` + `run` on `fn main(): i32 { return 0 }`;
  3. for each fixture in `tests/selfhost-manifest.txt`: compile with
     milo-self, execute, compare stdout against the fixture's `// @expect:`
     lines (same parser as run.test.ts — factor it out, don't duplicate);
  4. report manifest coverage count.
- Seed the manifest with whatever passes today (likely zero — that's fine;
  the harness must exist and run in CI regardless).
- Wire into CI next to the existing test job.

**Accept**: `bun test tests/selfhost.test.ts` runs, builds milo-self, and
reports manifest status. Committed and in CI.

### M1 — Fix the crash

`./milo-self check min.milo` currently dies on the most trivial input, so the
fault is in startup or the shared front path (readFile → tokenize → parse →
newChecker).

**Bisection is not available (verified 2026-07-09).** There is no last-good
revision: at `6e987e7` src-milo does not compile with its own contemporaneous
TS compiler (`use of moved variable 'firstName'`, `'iterableOrStart'`,
`cannot use '==' on enum 'Option_i64' with payload-bearing variants`).
`c7ef5ea` is the first commit where milo-self *builds*, and it has never run.
So M1 is direct debugging, not a bisect.

Symptoms — memory corruption, signal varies per run and per opt level:
- `-O2`: `SIGABRT`, `malloc: pointer being freed was not allocated` on a
  **stack** address (a drop calling `free()` on a stack slot).
- `-O0`: `SIGSEGV` in `checkExpr`.
- also seen: `SIGUSR1`. Backtraces are unwalkable (frame chain clobbered).

Suspect the copy-back / deep-clone rework: hand-written `impl Clone` helpers on
recursive `Heap<T>` enums are exactly where a double-free or a free-of-stack
would live. Note `milo-self` with no args prints usage and exits 0, so the
fault is on the path that reads a file and type-checks it.
If the bug turns out to be a *TS codegen* bug miscompiling valid milo0 code,
extract a minimal fixture, fix the TS compiler first (separate commit), then
return.

**Accept**: smoke test in M0 green (`check` exit 0, `run` of return-0 works);
flip `SMOKE_MUST_PASS = true` in `tests/selfhost.test.ts`. Seed the manifest
with all fixtures that pass.

#### Root cause (2026-07-09): move-out-of-index is unsound

Narrowed by input-bisection (`check` on an empty file, `fn main() {}`, and a
bare struct all pass; **any program containing an expression** crashed), then by
`eprint` tracing: the fault was in `resolveImports`, not the checker.

`v[i]` on a **non-Copy** element yields a *shallow copy* while the container
goes on owning it. `resolveImports` did this twice in a row:

```milo
rs.functions.push(program.functions[fi])   // rs aliases program's heap
...
result.push(arr[i])                        // result aliases rs's heap
```

`dedupFunctions` drops `arr` and frees the `Heap<Stmt>` payloads; `resolveImports`
then drops `program` and frees them again → invalid free. Minimal repro (no
struct needed; `St.Ret`, a variant with no `Heap` payload, does **not** crash,
which is what pins it to nested drop glue):

```milo
enum Ex { Lit(i64) }
enum St { Let(Heap<Ex>), Ret }
fn dedup(arr: Vec<Heap<St>>): Vec<Heap<St>> { /* result.push(arr[i]) */ }
fn resolve(program: Vec<Heap<St>>): Vec<Heap<St>> { /* rs.push(program[fi]) */ }
```

**Fixed forward in milo0** (`src-milo/resolver.milo` clones at every index-move;
added `impl Clone` for `TraitMethod`/`TraitDecl`/`ImplDecl`). `check` on a
trivial program is now deterministic and gated by `CHECK_MUST_PASS`.

#### Second root cause (2026-07-09): enum payload sizing — an *oracle* miscompile

`milo-self run` emitted corrupted IR (`trunc i64 0 to <NUL><NUL>…`,
`trunc %String %t2 to i32`). That was **not** a milo0 bug. Minimal repro:

```milo
enum Outer { Wrap(Option<i64>), Nop }
fn f(o: &Outer): i64 { match o { Outer.Wrap(v) => …, Outer.Nop => -2 } }
f(Outer.Wrap(Option.Some(42)))   // → -2: the OUTER match took the wrong arm
```

`%Outer = type { i32, [1 x i64] }` — an 8-byte payload holding a 16-byte
`%Option_i64`. Enum layouts were registered in one pass, and monomorphized
generics (`Option_i64`) are appended *after* the enums that reference them, so
`typeSize()` hit its 8-byte fallback and every store scribbled past the slot.
Non-generic payloads (`Wrap(Inner)`) worked only by luck. Fixed in `ee5d379`:
seed all layouts, then grow payload sizes to a fixpoint (monotone → terminates;
recursion goes through `Heap`, a pointer). This shape is exactly milo0's
`Stmt.Return(Option<Heap<Expr>>, …)`, so the oracle was corrupting the
self-hosted compiler's own AST.

Also landed (`7ad21dd`): milo0's codegen now **borrows** the AST (`&Stmt`,
`&Expr`) instead of taking `Heap<Stmt>`/`Heap<Expr>` by value — previously every
callee dropped (freed) the node it was handed, the same bug class as the
resolver fix, at six call sites. This mirrors what the checker already does.

#### Third root cause (2026-07-09): deref of a borrowed `Heap` in an argument position

`emit-ir` produced `ret i32 0` for `return 4095` — every integer literal reached
codegen as 0. Traced with read-only borrow probes (note: a probe that *binds* an
element, e.g. `fns[0].clone()`, perturbs the very bug it is measuring) to
`checkExpr(ck, *expr)` inside `checkReturn`, and reproduced with an empty callee:

```milo
enum Ex { IntLit(i64), Name(string) }   // any drop glue at all
fn noop(e: &Ex): i64 { return 0 }
fn f(h: &Heap<Ex>): void { let r = noop(*h) }   // frees/zeroes the Heap box
```

`genExpr(HeapDeref)` zeroes the source slot after loading — correct for a move
(`let x = *h`), wrong for a borrow. `genLValueForArg` handled `Ident` /
`FieldAccess` / `IndexAccess` and *fell through to `genExpr`* for `HeapDeref`, so
every auto-borrowed `*h` argument destroyed the pointee. `enum E { A(i64), B }`
(no drop glue) was fine; adding a `string` variant broke it. Fixed in `a49bfad`.

**M1 is done.** `milo-self check` and `milo-self run` are both deterministic,
gated by `CHECK_MUST_PASS` / `RUN_MUST_PASS`, and `run` propagates the exit code
(`return 7` → rc 7). `build -o` works.

**Manifest: 48 fixtures and growing.** `bun test tests/selfhost.test.ts` → 53 pass,
0 fail. `findStdlibRoot` is wired: milo-self injects the prelude, type-checks it,
codegens it, and `run min.milo` exits 0 (and `return 7` → rc 7).

### What M1 actually cost, and what it bought

Every one of the five M1 root causes was a **miscompile in the TS oracle**, not a
milo0 bug. They are all fixed and shipped to every Milo user:

| commit | bug |
|---|---|
| `ee5d379` | enum payload sizing undersized a payload that was itself an enum |
| `a49bfad` | deref of a borrowed `Heap` in an argument position moved *and zeroed* the caller's box |
| `1cd6e27` | `HashMap.get` returned a shallow copy; `emitDeepCloneFromPtr` punted on enums |
| `400a71f` | clone helper bodies bypassed `hoistAllocas` — a Vec clone allocated per loop iteration |
| `234204f` | `h.m()` on a `Heap<T>` receiver passed the *slot address* (ptr-to-ptr) as `&T` |

Self-hosting is doing its job: it is the most brutal integration test this compiler
has. The heisenbug phase is over — what remains is mechanical porting.

Debugging playbook that actually worked:
- `check … 2>&1 | wc -l` returning `0` means *no output* — a crash — not "zero errors".
- Plain `lldb` on the release build hangs and won't unwind. Build with
  `--debug --sanitize`; ASan makes the fault deterministic. If the PC is garbage,
  walk the frame-pointer chain by hand (`ReadPointerFromMemory(fp)` / `fp+8`).
- `opt -O2 -S` reports IR bugs (*"PHI node entries do not match predecessors"*)
  that clang only reports as `Bus error: 10`.
- A probe that *binds* a container element (`v[0].clone()`) perturbs the bug it is
  measuring. Probe read-only through borrows.

### M3 — codegen gaps (in progress)

Landed: Vec runtime (`%Vec = {ptr,i64,i64}`, `new`/`push`/`len`/index, element size
via `getelementptr T, ptr null, i32 1` so `%String` and structs work); string `push`
(cap==0 means a `.rodata` literal — malloc+memcpy, don't realloc); `astTypeStr`
(codegen keyed off `MiloType.name`, dropping type args, so `Vec<string>` sized its
elements as i64); `ptrtoint`/`inttoptr` (`intBits("ptr")` is 64, so `p as i64` hit
the bitcast branch); bounds-safe `peek`/`peekN`/`advance`; f-strings end-to-end
(`parseFString` stringified the *byte value* of each literal char; `format` was
implemented nowhere).

`genMethodCall` and `genFieldAccess` now **fail loud** on an unknown method/field
instead of returning `Val{v:"0"}`, which used to surface 400 lines later as
`trunc i64 0 to %String`. Each remaining gap names itself.

Landed since (2026-07-10): `Self` substitution in impl-method ASTs (cleared the
24-fixture `unknown struct 'Self'` bucket); bool prints as `true`/`false`;
**for-in codegen** (range/vec/string-bytes, continue goes to the step block);
**if-let codegen** (one-pattern match with a real else path).

Oracle miscompiles #6 and #7 (2026-07-10), both found because milo-self hung
checking ANY enum match — the entire ~40-fixture guard-kill bucket was ONE bug:

| commit | bug |
|---|---|
| `d0e4e76` | deep clone of a hashmap fell back to a *shallow load*; the clone's drop freed the shared entry buffer and the next probe loop walked freed memory forever |
| `1411df6` | `match` on a place (`s.field`, `v[i]`) consumed the subject: codegen zeroed the container slot behind an untrackable projection, so a second match read tag 0 with empty payloads, silently |

Place-match semantics are now: borrow the subject, non-Copy payload bindings
bind as `&T` (same as ref-match). Fixtures: hashmapCloneNested,
matchPlaceBorrows.

Failure census 2026-07-10 (post-fixes), manifest 69/340, serial sweep
(`MILO_SWEEP_CONCURRENCY=1` — parallel sweeps flip a few fixtures
nondeterministically; serial is the ratchet ground truth):

- **138** "other" — lost type info in codegen (`no field 'len' on i64`,
  `cannot index type i64`, bad IR types); generics-not-wired is the big theme.
- **18** `unknown struct` / `undefined function` each — arena*, extern-struct,
  closure-heavy stdlib fixtures.
- **18** `unsupported method` — String.slice, HashMap insert/get/iterate
  (the M4 hard spot, next up).
- **8** output mismatch — includes the user-`Drop`-not-firing-at-scope-end gap
  (dropUser prints "using 1 2" but no "drop" lines).
- **5** SIGSEGV, **1** run-crash. Guard-kill buckets: **zero**.

Artifact paths are pid-suffixed (`/tmp/milo_out_<pid>.ll`): they were shared, so
concurrent milo-self builds clobbered each other's IR — this undercounted a
parallel sweep 34 vs the true 48.

> **Corpus change 2026-07-10 (concurrency surface reduction, commit e0c40bd).**
> The public OS-thread tier was removed: `std/thread.milo` deleted, public
> `Mutex`/`RwLock` dropped from `std/sync.milo`, and the `parallel` block removed
> from the grammar. `Promise.blocking(fn)` (new, in `std/runtime.milo`) is now the
> sole OS-thread escape hatch. Impact on the sweep:
> - Fixture count moved (now 338 fixtures / 72 errors): deleted `threadBasic`,
>   `rwLock`, `rwLockThreaded`, `withLock`, `parallelBlock`; added `promiseBlocking`,
>   `promiseBlockingAll`, `promiseBlockingTask`, `promiseBlockingNotSend`; migrated
>   the `channel*`/`atomics*`/`waitGroup*`/`spawnMove*`/`*CrossThreadPark`/
>   `sendAnnotation` fixtures from `Thread.spawn` to `Promise.blocking`. Re-baseline
>   the "/340" denominator against the new count.
> - None of these are in `selfhost-manifest.txt` or the exclusion list — all sit in
>   the expected **threads/green-runtime** gap, so the 69-fixture ratchet is
>   unaffected (verified: selfhost.test.ts green post-change).
> - **Scope shrank for milo-self:** it never has to implement `Thread`/`Mutex`/
>   `RwLock`/`parallel`. `Promise.blocking` is the only new construct in that space,
>   and like the rest of the green runtime it stays an expected M6 gap for now.

The `emit-ir` diffing playbook works:
`diff <(bun run src/main.ts emit-ir f.milo) <(.selfhost/milo-self emit-ir f.milo)`.

### M2 — Retire the dead HIR path (decision, then mechanical)

Decision (made here, don't relitigate): **bootstrap on the AST-directed
codegen**. The HIR port (`hir.milo`, `lower.milo`, ~1,000 lines) stays
unwired; move both files to `src-milo/attic/` with a header comment pointing
at this section. Rationale: the live pipeline works end-to-end for stage-0
programs, HIR adds a whole extra phase to debug through, and nothing about
bootstrap requires typed IR. Revisit HIR after F-convergence if checker-info
plumbing into codegen becomes painful (the TS compiler does AST+CheckResult →
HIR → IR; milo0's codegen re-deriving types from the AST is the known cost of
this shortcut — pay it until it actually hurts).

**Accept**: attic move committed, milo-self still builds, manifest unchanged.

### M3 — Close the codegen gaps (bootstrap subset)

Order chosen so each step unlocks fixtures for the ratchet. For each: port
the corresponding TS codegen logic (reference points below), add/enable
fixtures, grow the manifest.

- M3a `for i in A..B` and `for x in vec` — `codegen/stmt.milo:237` TODO;
  TS reference: `src/codegen.ts` ForIn cases (range at ~1448, vec/string
  iteration nearby). Range first (milo0 uses it since fbc44f3), vec second.
- M3b `if let` — `codegen/stmt.milo:267`; TS reference: IfLet lowering
  (match-with-one-arm desugar is acceptable if simpler).
- M3c `!` unwrap and `??` default — `codegen/expr.milo:392`; panic path
  must print the same "unwrap on None/Err" message shape as TS.
- M3d `?` propagate — `codegen/expr.milo:396`; requires the enclosing
  function's Result type from the checker — plumb via the checker tables
  (this is the first place M2's shortcut costs; if it takes >2 sessions,
  reconsider a minimal HIR for just this).
- M3e index assignment `v[i] = x` — `codegen/stmt.milo:33`.
- M3f sweep: grep src-milo for every construct it uses
  (`rg 'for |if let |[!?]\.|\?\?' src-milo --type-add 'milo:*.milo'` plus a
  read of each file's imports) and fixture-test each against milo-self.
  Anything unsupported gets a task appended here.

**Accept** per sub-task: named fixtures added to manifest and green.
**Accept** for M3 overall: every syntactic construct used by src-milo itself
has a green fixture in the manifest.

### M4 — Self-compile ratchet

File-by-file: `milo-self build` each src-milo file's standalone test driver,
starting with the leaves (tokens → lexer via `lexTest.milo` → ast → parser →
resolver → checker → codegen → main). For each file that fails, minimize the
failing construct into a fixture, fix, ratchet. Two known hard spots:

- Hand-written `impl Clone` deep-clones of recursive Heap enums — heavy
  recursion + drop interaction; if milo-self miscompiles drops here, isolate
  with tiny recursive-enum fixtures before debugging in the large.
- HashMap<string, V> in `checker/mono.milo` — milo-self's codegen must
  support the built-in HashMap fully (insert/get/iterate). Escape hatch if
  blocked: swap mono tables to sorted Vec + binary search (localized change).

**Accept**: `.selfhost/milo-self build src-milo/main.milo -o milo-self2`
succeeds and `milo-self2` passes the M0 smoke test.

### M5 — Bootstrap convergence

- `milo-self2 build src-milo/main.milo -o milo-self3`.
- `milo-self3` must be functionally identical to `milo-self2`: same manifest
  results, and `diff <(milo-self2 emit-ir f) <(milo-self3 emit-ir f)` empty
  for every manifest fixture (IR text equality is the convergence test —
  stronger and cheaper than binary identity, which clang timestamps break).
- Add the three-stage bootstrap as a CI job (allowed to be slow; nightly ok).

**Accept**: convergence green in CI. **This is the credibility milestone —
announce it in the README with the benchmark table.**

### M6 — Fixture parity (post-bootstrap, incremental forever)

Grow the manifest toward the full `tests/fixtures/` set (426 files). Track
the exclusion list explicitly at the bottom of this doc with reasons
(feature-gap vs bug vs deliberate-defer: closures, user generics, traits,
threads/green-runtime are the expected big remaining gaps). `tests/errors/`
parity (diagnostics) comes last — error-message equality is a polish task,
not a bootstrap requirement; parser still panics on mismatch
(`parser.milo:53`) and fixing that belongs here.

### M7 — (deferred, do not start) Retire TS

Unchanged from v1: dual-run CI diffing, LSP/formatter story, drop bun
requirement. Requires M6 substantially done. Not part of this plan's scope.

## Philosophy (unchanged from v1)

Self-hosting is a credibility milestone, not the product. If any milestone
stalls >2 weeks of active work, stop and reassess: skip the blocker, shrink
scope (a converging bootstrap on the milo0 subset is worth shipping even if
fixture parity never reaches 100%), or pause the track. Each milestone is
independently valuable. The worst outcome is months of compiler plumbing
while the language stagnates.

## Progress

| Milestone | Status | Date |
|---|---|---|
| M0 harness | **done** (`bun test tests/selfhost.test.ts`) | 2026-07-09 |
| M1 fix crash | **done** — `check` + `run` green and gated | 2026-07-09 |
| M2 attic HIR | not started | |
| M3 codegen gaps | in progress — manifest 99/339. Landed: unwrap/default (M3c) with oracle panic shape; resolveTyStr carries generic args through fn signatures; hashmap runtime; generics (mono on demand, builtin Option/Result, get→Option<V>; codegen resolves mangled names by single-instantiation prefix — multi-instantiation is the next wall); user Drop hooks at scope end/returns (ref params excluded via Local.isRef); fixed arrays on the Vec runtime; vec index assignment (M3e). Known gaps: ref params lower BY VALUE (astTypeStr strips ref-ness — mutation through &mut param is lost, works only for read-only refs); `!`/`?` codegen still TODO stubs; latent prelude strContains miscompile (`memcmp(i8 …)`). Oracle miscompile #8 fixed en route: match on `*h` consumed the pointee through a borrow (`7bb8432`). | 2026-07-10 |
| M4 self-compile | in progress — milo-self type-checks src-milo file-by-file: tokens/ast/lexer CLEAN; parser: string-literal enum-ctor arg misparsed as ident (`Expr.Ident(\"error_unexpected\", s)` → undefined variable, 6× from one site — runtime misparse, next lead) + `parseF64`/`tokenize` visibility; diagnostics/hir: deref-of-unknown; target/resolver/lexTest/main: checker runaway (guard-killed at 2-3GB — bisect which construct loops). Move checker gained oracle-parity flow handling: inReturn suppression, terminated-branch discard, branch-isolated any-path joins. | 2026-07-10 |
| M5 convergence | not started | |
| M6 parity | not started | |

### Exclusion list (fixtures milo-self is not expected to pass yet)

(populate at M0 seed time)
