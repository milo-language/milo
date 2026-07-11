# Self-Hosting Plan (v2 — 2026-07-08)

Goal: `milo-self` (the Milo compiler written in Milo, in `src-milo/`) compiles
itself, and the bootstrap converges. This doc is written to be executable by an
implementing agent with no other context: every milestone has a command-line
acceptance test, and the rules in "Working Agreement" are mandatory.

## STATUS: bootstrap converges at -O2 (M5 done)

`milo0` compiles its own source to a byte-identical fixed point at the
production `-O2` level: `stage1 == stage2 == stage3`. Verified empirically
2026-07-10 (`b8e8acc`, payloadBytes alignment fix) and re-verified from the
current tree: `stage1 emit-ir src-milo/main.milo` == `stage2 emit-ir …`,
byte-identical. Manifest-wide: 212/339 fixtures emit identical IR stage1↔stage2,
0 divergences. Reproduce: `sh scripts/selfhost.sh` (stage1 is gitignored — this
is required), then `bun test tests/selfhost.test.ts`.

**Everything below the "Current State (2026-07-08)" heading is the historical
milestone log (M0→M5) — read it for the debugging record, not for current
status.** The `-O2` saga in particular is RESOLVED: earlier sections describe it
as open (last section "M5 follow-on: `-O2` miscompile — FIXED ✅" is the
conclusion). M6 (fixture parity) is the only open track.

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
| M4 self-compile | **RUNAWAY SOLVED — self-build now runs leak-free + deterministic through the whole graph, gated only by mechanical codegen gaps.** Root cause of the "nondeterministic runaway" was an **oracle O(n²) memory leak**: assigning to a non-Copy struct **field** (`cg.body = cg.body + s`, every `emit()`) never dropped the old field buffer — `case "Assign"` only dropped/append-optimized `Ident` targets, not `FieldAccess`/`IndexAccess`. Leaked buffers summed to N²/2 → GBs while the *final* field stayed ~400KB (why `cg.body>20MB` guards never tripped, why ASan never fired, why crash-fn varied by timing). Fixed in the TS oracle (`f644ad7`, `lvalueMatches` + drop-old-value + append-opt for any place). With it, `build` is bounded (<1.5GB) and deterministic. Then a run of milo0 codegen gaps, each fixture-extracted and fixed: String.slice/parseInt/parseF64, Vec.reverse, Vec.pop, static-methods-on-structs→`Type$method`, `?`-propagate, raw-ptr index r/w, `*p`/`a[i]` lvalues, call-results carry surface type, struct+enum-payload types keep full args, **enum payload mangling moved to read-time** (mono `Option_i64` registers after its container, so `%Option<i64>` was leaking into match GEPs). **Current gap:** `.clone()` on a `Heap<T>` value (deep-clone the box) in `checkForIn`. Next: implement Heap.clone (malloc + deep-clone pointee), keep grinding to first full self-build. | 2026-07-10 |
| M4 (earlier notes) | `milo-self check` deterministic/clean (3/3). `build` now runs codegen through the whole graph (front→lexer→parser layers→stdlib) after a batch of genExpr type-tracking fixes. Landed this session (all in `codegen/`): mangle generic **struct field** types via resolveTyStr (Option<Span> field → Option_Span, so match-on-field resolves payloads); **call results carry surface type** not %Vec (Val.ty=retTy — `.len`/index on a returning-Vec call); **static methods on structs** route EnumLit form → `Type$method` call (File.openRead → the `?` chain); **raw-pointer index read+write** (`p[i]`/`p[i]=x` for `*T`); **`*p` and `a[i]` as lvalues** in genLvalue (`(*inner).field=x`), plus an rvalue-materialize fallback so `peek(p).kind` addresses a call result; **cast keeps pointer-ness** (`x as *i64` was dropping `*`→i64; Vec/String decay to data ptr); **string methods → str* std fns** (parseInt/toInt→strParseInt, parseF64→strtod, `str`+Capitalized for the rest). **WALL (next up): a cumulative transient-memory LEAK in codegen (oracle miscompile), NOT an infinite loop and NOT parse desync.** Nailed down empirically: (1) `check` is deterministic+clean → AST stable; (2) `build` grows RSS monotonically with codegen work — at a 3.5GB cap it dies compiling `nextToken` (fn #414/~600), at 6GB it reaches `parseComparison` (#472); (3) genExpr/genStmt/genLvalue call-counters never trip (3M) and ASan never fires → it's leaked heap, not recursion/overflow; (4) `cg.body`/`cg.globals` stay tiny (~375KB at #414) → the leaked memory is **transient** (Vals, cloned strings, cloned Heap subtrees), discarded but never freed; (5) skipping `nextToken`'s genFn only shifts the death #414→#440 → the leak is **spread across all functions**, ~KB/dispatch-node, biggest functions leak most. Four minimal repros do NOT reproduce it (all ran 200k–2M iters flat under 800MB): `for k,v in HashMap<string,i64/string>`, deep-recursive struct-of-strings returning `a.v+b.v`, recursive `Heap<Ex>` enum with `match &Ex { walk(*l) }` borrow. So the leaking construct is some *combination* codegen hits, not any of those alone. **Next: run milo-self.bin under macOS `leaks`/`MallocStackLogging` (or heaptrack) on a mid-size input to get the leak allocation stack** — small-repro bisection has been exhausted. Suspects still open: the `for k,v in cg.fnRets` prefix scans (hot: every call/method), and Val/borrowed-Heap-deref temporaries in the genExpr recursion. | 2026-07-10 |
| M4 self-compile | **DONE (functional): `milo-self build src-milo/main.milo -o milo-self2` produces a linked binary that type-checks correctly.** Whole graph → valid 139K-line IR → binary. Landed since: Heap.clone (deref-and-clone semantics, returns T not Heap<T>), String/double `toString` (snprintf), **15 runtime builtins** (`_cstrToString`/`_strDataPtr`/`_loadU8/I32`/`_scheduler{Get,Set}`/`_callClosureVoid`/atomics/`_miloArg{Count,At}`) + argc/argv/scheduler globals + C `main(i32,ptr)` wrapper, `eprint`→dprintf(2), **generic enum-literal hint resolution** (`Result.Ok` picks its instantiation from the return type), **param-type arg hints** (`error(_,_,Option.None)`), int-width coercion in binops, `&` address-of, ptr-null literals, wildcard match→switch-default, hashmap-get option mangling, ssl/crypto link detection, extern fns keep pointer return type, **`is` expr** (was defaulting to false → hung the lexer's EOF loop), and the big one — **ref params (`&T`/`&mut T`) lower as `ptr`** and pass args/self/drop-hooks by address (were by-VALUE, discarding every mutation-through-ref; `emit(&mut Cgen)` mutated a copy). Plus **short-circuit `&&`/`||`** (were eager). Manifest stays 122-green throughout. | 2026-07-10 |
| **M5 CONVERGED ✅** | **SELF-HOSTING FIXED POINT REACHED at `f6b9784` (verify after `sh scripts/selfhost.sh` — milo-self.bin is gitignored/stale-prone).** stage1-output == stage2-output == stage3-output for `src-milo/main.milo`, **byte-identical** (157161 lines). Manifest-wide: **212/339 fixtures emit byte-identical IR between stage1 and stage2, 0 diverge, 0 compilability disagreements** (127 both-fail = unimplemented features). The final four milo0 codegen fixes (all this session, exposed only at self-compile scale, all found via `clang -O0 -fsanitize=address` on the self-IR): (1) `c4b45c0` **`emitStringLit` re-decoded runtime bytes** — a literal backslash byte from source `"\\00"` got re-interpreted as an escape and baked a real NUL, truncating emitted IR at the first `%s`-print; also switched 3 format-string sites from literal `"\\n"` to real `"\n"`. (2) `bd02cf8` **append-opt** for `place = place + rhs` strings (`genStringAppendInPlace`, amortized doubling + `lvalueMatches`) — the naive store leaked the old buffer every `cg.body = cg.body + s`, O(n²) time+memory → OOM at 148k lines (stage1 does it in 0.13s because the oracle already had this opt, `f644ad7`). (3) `f6b9784` **`%String` builders set the `cap` field** (was `undef` in clone/concat/int-to-str/float-to-str/slice) — harmless until the append-opt read `cap` to size the grow: a clone's garbage cap skipped the grow → heap-buffer-overflow in `resolvePath`'s `withExt + ".milo"` → corrupted mangled-name buffers (`Option_Vec_Heap_Opti`) + phantom `undefined variable` errors. (4) earlier `4f9d443` genHashMapGet deep-clone. The "annotated-var `var x: i64` reads i32" and "generic annotation → `<unknown>`" bugs were **symptoms of (1)+(3)'s heap corruption**, not checker bugs — both repros exit 0 on the fixed stage2. | 2026-07-10 |
| M5 convergence | **Stage2 now: reads files, type-checks simple programs, converges on min.milo, processes the prelude, and correctly stores struct-in-enum values. Blocked on a checker runaway on a large program.** Since first convergence, fixed the biggest corruption: **enum payload slots were undersized for `Option<Struct>`/`Result<Struct>`** because enums registered before structs — so the mono enum couldn't see the struct's size and fell back to 8 bytes, truncating any struct value (garbage `TypeKind` bits, garbage `FnSig.params.len`). Fixed (`dc68742`) by registering ALL enum+struct metadata first, then sizing (payloadBytes recurses via variant payload types → order-independent), then emitting. This also fixed the earlier "tokenize crashes on std/string.milo" (same corruption in the checker's tables). **RUNAWAY FIXED (`4f9d443`): it was `genHashMapGet` doing a SHALLOW load of the found value.** The returned `Option<FnSig>` shared the `FnSig`'s `params` Vec buffer with the entry still in `ck.functions`; when that Option dropped at scope exit it freed the buffer, leaving the map entry dangling, so the next `.get(name)` read freed memory → garbage `params.len` → `checkIdent`/`typeName`/clone spun on it → the ~1.5GB "allocation". Exactly oracle `1cd6e27`. Fixed by deep-cloning the value via `genCloneOfLoaded` (also fixed that helper to pass `&self` as a ptr to impl-Clone methods post-ref-param-change) — applied to both `genHashMapGet` and `genHashMapGetOrDefault`. **milo-self2 now type-checks the full prelude deterministically (no runaway).** **New current bug (residual, clean repro `/tmp/n3.milo`): `fn f(): i64 { var x: i64 = 0; return x }` — milo-self2 reports `return type mismatch: expected i64, got i32`, i.e. the `: i64` annotation on a `var` is not being stored (x reads back as i32).** Works standalone in milo-self.bin, and milo-self2 coerces a bare `return 0`/`return -1` fine — so it's specifically the annotated-var path (`checkLetDecl`'s `valType = hint`, or `resolveAstType("i64")`, mis-set in stage2). ~44 such i32/i64 errors across the prelude. Likely more shallow-copy sites (HashMap `for k,v` iteration, `genHashMapInsert` found-path) or a TInt-payload read. (Superseded pre-fix characterization below.) ~~**a single ~1.5GB allocation inside `checkFunction(vecJoin)`** Confirmed via markers: `checkFunction` reaches its body (`CFbody len=3`) then dies. NOT caught by ANY of these guards (all added, none tripped): checkExpr/checkStmt op-counters (lowered to 100k), `monomorphizeFn`/`monomorphizeStruct` count guards, `snapshotMoves` HashMap-iteration guard, TypeKind `TFn` clone loop (`for 0..params.len`), `typeName` TFn loop, `checkFieldAccess` struct-field loop, `checkIdent` function-value TFn-build loop. Also ruled out via runtime IR guards (emit `if size>2GB: exit(N)` at each alloc site — none fired, still SIGKILL 137): Vec push-grow realloc, String concat malloc, String clone malloc, HashMap insert-grow realloc. So it is NOT any of the 4 growable-container allocations, and NOT any counted loop — it is an unguarded single alloc (genArrayRepeat / _cstrToString / snprintf buffer / a raw memcpy) OR a small-alloc infinite loop in a helper not on the checkExpr/checkStmt path — the op-counters don't fire because the runaway is one loop/alloc INSIDE a single check call, not a chain of calls. Related evidence: `/tmp/req2.milo` (`f(5)`, no prelude) earlier reported `f expects 4343263508 args` = garbage `FnSig.params.len`; that specific case was fixed by the payload-sizing commit, but a residual FnSig/type corruption clearly persists in the full-prelude context. **Next (needs tooling this session couldn't safely run — OOM risk): build milo-self2's IR with `clang -g`, run under a strict `ulimit -v` so it can't crash the machine, then `sample`/lldb to get the exact allocation stack.** Then fix the residual sizing/corruption. (Superseded characterization below.) ~~**runs away (SIGKILL) inside `checkFunction(vecJoin)`** — the 24th prelude fn, `fn vecJoin(parts: &Vec<string>, sep) { for i in 0..parts.len { result = result + parts[i] } }`. Isolated `joinit` (same body) compiles+runs fine via milo-self.bin, so the runaway is context-dependent — likely a generic/mono loop that only triggers with the full prelude's type set registered (`parts[i]` on `Vec<string>` may re-trigger monomorphization). Probe stack that got here: `compile→resolveImports(prelude+std/string, 32 fns)→checkProgram phase3→checkFunction #24`. Next: bisect the mono/generic path in the checker under the full prelude (add a mono-instantiation counter/guard, or diff milo-self.bin vs milo-self2 checker behavior on vecJoin-in-context). | 2026-07-10 |
| M5 (first convergence) | **FIRST CONVERGENCE ACHIEVED (trivial programs): `milo-self2 emit-ir min.milo` is BYTE-IDENTICAL to `milo-self.bin emit-ir min.milo`, and `milo-self2 run min.milo` → rc 7.** The self-compiled compiler reads, compiles, and runs correctly for programs with no prelude. Two decisive fixes got here (both were silent data corruption in stage2): (1) **string/Vec args now decay to their data pointer for pointer params** — `open(path: *u8, …)` was passed the whole `%String`, shifting the ABI so `open`'s flags = the path's length → O_WRONLY when len&3==1 → read EBADF (files whose path len mod 4 was RDONLY-compatible worked, which is why it looked intermittent); (2) **enum payload slots now size %String/%Vec/%HashMap as 24 bytes not 8, with cg-aware nested enum/struct sizing** — `Result<string>` had a 1-word payload holding a 3-word String, truncating len/cap → every file read came back empty. Method: bisect with `eprint` probes down the real call stack (`compile→readFile→readAll→readFd→read`), read the emitted IR, and use `clang -O0 -fsanitize=address` on the self-IR for overflows. **Remaining before full convergence:** (a) `open(path, flags, MODE)` variadic mode arg is ABI-shifted (openWrite creates the temp .ll with mode 015 not 0644 → clang "permission denied" → blocks stage2 `build`/`run`, though `emit-ir` is unaffected); (b) **function signatures corrupt for real programs** — `f(5)` reports `f expects 4343263508 args` (garbage `sig.params.len`), so any program that calls a user function with args mis-checks; clean repro `/tmp/req2.milo`, no prelude needed. Fix these two, then diff stage2 vs stage1 emit-ir across the fixture set. | 2026-07-10 |
| M5 (earlier) | **stage2 grind via ASan; UB fixes.** milo-self2 links + type-checks but MIScompiles: opt-level-sensitive **UB** (proven -O0 empty vs -O2 partial). **Working method: `clang -O0 -fsanitize=address` the milo-self self-IR, run it; ASan names the overflow.** Fixed #1 (`bf3f292`): `genStringEq` ran `memcmp(a,b,aLen)` unconditionally (result AND-ed with lenEq) → overflowed the shorter buffer → `min(aLen,bLen)`. **Open #2 (narrowed, NOT yet fixed): milo-self2's `readFd` returns -1/EBADF on the FIRST file read only** (stdlib reads 2..N succeed). Bisected with eprint probes down the stack: `compile→readFile→File.readAll→readFd→read(3,buf,65536)=-1 errno=9`. fd=3 is valid during `File.size()` (lseek returns 32) but EBADF at the very next `read` — **the fd is closed between size() and read()**, i.e. a File `Drop`(close) fires on a stale copy. So `source` comes back empty → 1 token (EOF) → 0 parsed fns → genProgram emits only globals (why "body is lost"). readFile/readAll IR *looks* correct on inspection (drop of `f` is correctly after readAll; no double-drop visible), so it's a drop-timing/aliasing UB, likely tied to the new ref-param path or genMethodCall's dead `%t0 = load %File, ptr %self` receiver-load. **Next: minimal repro compiled by milo-self.bin of `struct+impl Drop(close) / Type.openRead()? / &self method that reads fd` (the fdtest.milo attempt hit a resolver quirk with extern imports — build it using File from std/io instead of raw externs), then bisect which construct emits the early close.** Also backfill manifest fixtures for the behavioral fixes (Vec.pop panic, Heap.clone, ref-mut, short-circuit, string-eq-unequal-len). | 2026-07-10 |
| M6 parity | not started | |

### Independent verification (2026-07-10 ~20:30, at `f6b9784`): M5 convergence NOT reproducible

Ran the full chain from a clean HEAD checkout, guarded (4GB/300s):
TS→stage1 OK; stage1→stage2 OK; **stage2 `build src-milo/main.milo` FAILS in
type-check with thousands of errors** — dominated by the open annotated-var bug
(`return type mismatch: expected i64, got i32`, `cannot assign i64 to i32`)
plus its cascade: annotated vars of generic/container types come back
`<unknown>` (`no method 'push' on type <unknown>`, `cannot assign Option_… to
<unknown>`), and `[i32; 16]` vs `&[u8; 16]` (array element annotations lost
too). So the `/tmp/n3.milo` bug is THE gate to stage3 — nothing else is
reachable behind it. If a convergence run succeeded somewhere, it wasn't from
committed state; do not mark M5 done until
`stage2 build src-milo/main.milo -o stage3` + manifest-wide
`diff <(stage2 emit-ir f) <(stage3 emit-ir f)` pass from a clean checkout, and
the doc's Progress row links the exact commit it was reproduced at.

### Reconciliation (2026-07-10 ~20:45, at `f6b9784`): M5 convergence IS reproducible — stale-binary trap

The "NOT reproducible" result above came from a **stale stage1 binary**.
`.selfhost/milo-self.bin` is **gitignored** — a `git checkout f6b9784` does NOT
rebuild it, so a chain that skips `sh scripts/selfhost.sh` runs stage2 built off
whatever old (pre-fix) `milo-self.bin` was on disk. That old stage1 predates
`c4b45c0` (emitStringLit), `bd02cf8` (append-opt), `f6b9784` (String cap), which
are exactly the fixes that clear the annotated-var / `<unknown>` cascade. Build
stage2 from a *stale* stage1 and you reproduce the explosion verbatim.

Re-ran the full chain from committed `f6b9784`, **rebuilding stage1 from source
first** (all guarded):

```
sh scripts/selfhost.sh                                        # oracle → stage1 (REQUIRED; gitignored artifact)
guard -- milo-self.bin emit-ir src-milo/main.milo > A.ll      # stage1 output of the compiler
clang -O0 A.ll -o stage2 -lm -lssl -lcrypto -lsqlite3         # stage2 = the compiler, self-shaped
guard -- stage2 emit-ir src-milo/main.milo > B.ll             # stage2 output of the compiler
cmp A.ll B.ll                                                 # ← IDENTICAL (157161 lines)
```

Results:
- **main.milo fixed point: `cmp A.ll B.ll` byte-identical** (stage1-output ==
  stage2-output). Built stage3 from B.ll, emitted stage4 → `cmp B.ll C.ll` also
  identical: **stage2 == stage3 == stage4**.
- **Manifest-wide** (all 339 fixtures, `cmp <(stage1 emit-ir f) <(stage2 emit-ir f)`):
  **212 byte-identical, 0 differed, 0 where the two disagree on compilability**,
  127 both-fail (features milo0 doesn't implement — arenas/channels/closures/
  generics/promises/green-threads; not regressions).
- Cited gate bugs refuted on the fresh stage2: `/tmp/n3.milo` (`var x: i64 = 0;
  return x`) → exit 0, no error; `Vec<i64>` annotated + `.push` → exit 0, no
  `<unknown>`. Both were symptoms of the emitStringLit NUL-truncation +
  String-cap-undef heap corruption, fixed at `c4b45c0`/`f6b9784`.

Root cause of the whole M5 grind (found via `clang -O0 -fsanitize=address` on the
self-IR): a chain of latent bugs the self-compile scale exposed —
(1) `emitStringLit` re-decoded runtime bytes → baked a real NUL from source
`"\\00"` → truncated emitted IR; (2) the O(n²) `cg.body = cg.body + s` leak →
OOM at 148k lines; (3) `%String` builders left `cap` undef → the append-opt read
garbage cap → heap-buffer-overflow in `resolvePath` that corrupted mangled-name
buffers (`Option_Vec_Heap_Opti`) and produced phantom `undefined variable`
errors. **Acceptance bar met: stage3 build + manifest-wide stage2-vs-stage3 diff
from committed `f6b9784` after `sh scripts/selfhost.sh`.**

### Reconciliation round 2 (2026-07-10 ~21:00): both results were real — the discriminator is CLANG OPT LEVEL, not a stale binary

The stale-binary explanation above does not hold for the independent run: its
stage1 was built fresh from `f6b9784` source (same command selfhost.sh runs,
20:30), and a second stage2 was built via the post-selfhost.sh
`.selfhost/milo-self.bin` (20:35) — both stage2s still exploded. Controlled
experiment settles it — **the SAME stage2 IR** (`milo-self.bin emit-ir
src-milo/main.milo`, 157161 lines), compiled twice:

```
clang -O0 A.ll → check src-milo/main.milo → exit 0, clean   (×2)
clang -O2 A.ll → check src-milo/main.milo → exit 1, 436 errors / 438 errors (run-to-run drift)
```

So:
- **The -O0 fixed point is real** — the convergence section above stands *as
  measured*, because its chain hand-compiled stages with `clang -O0`.
- **The self-IR still contains UB.** At -O2 the same compiler mis-typechecks its
  own source, and the error count drifts between identical runs (434–438
  observed across 8 runs) — classic optimizer-exposed undefined behavior, the
  same "-O0 empty vs -O2 partial" signature already documented in M5 (earlier).
- **milo0's own `build` command uses `clang -O2`** (`src-milo/main.milo:236,255`)
  — so the NORMAL pipeline (`stage1 build src-milo/main.milo -o stage2`)
  produces a miscompiled stage2 today. That is exactly how the independent
  verification built its stage2s. Anyone reproducing convergence must currently
  hand-compile the IR at -O0; that caveat belongs in any README/announcement.
- Prime UB suspect is already on file: **Review lead #2** (shallow-get UAF for
  every map value type without `impl Clone` — StructInfo/EnumInfo/TraitInfo/
  ImplInfo/`Vec<ImplInfo>`/VarInfo). Use-after-free is precisely the bug class
  that -O0 masks (spill/reload keeps stale values readable) and -O2 exposes
  (reordered frees, dead-store elimination). Missing alloca hoisting (lead #7)
  is the other candidate.

Actions before announcing M5:
1. Either fix lead #2 (structural deep-clone emitter) and re-test at -O2, or
   interim: switch `src-milo/main.milo` build/run clang invocations to `-O0`
   so the normal pipeline produces the binary the convergence claim describes.
2. Add the **-O2 canary** to the acceptance bar: `clang -O2` the self-IR and
   `check src-milo/main.milo` must exit 0 — run it 3×, error counts must be 0
   and stable. Convergence at -O0 with UB at -O2 is a fixed point of a
   miscompiled compiler pipeline, not yet a shippable milestone.

### M5 follow-on: `-O2` miscompile — FIXED ✅ (payloadBytes alignment)

**Root cause found and fixed.** `payloadBytes` (codegen/types.milo) summed struct
field sizes with **no inter-field alignment padding**, so `MiloType` (String, Vec,
four `i1`s, then 8-aligned `Option_i64`/`Vec`/`Option_Heap_MiloType`) sized 109→112
instead of 120. That undersized `Option<MiloType>`'s payload to `[14 x i64]` vs the
oracle's `[15 x i64]`. Storing a `Some(MiloType)` overflowed the slot by 8 bytes —
benign at `-O0` (aggregate store into adjacent slack), but at `-O2` the checker's
`match` on a borrowed `&Option<MiloType>` (checkLetDecl's `typeAnno`) read an
**undef tag → took the `None` arm** → the `: i64` annotation was silently dropped →
`return type mismatch: i64 vs i32`. Found by eprint-probing checkLetDecl in a
`-O2`-built self binary (probe showed `letdecl NONE` at `-O2` vs `SOME hint=i64` at
`-O0`), then diffing `%Option_MiloType` milo0 `[14]` vs oracle `[15]`. Fix: added
`alignOf` + aligned field offsets in both the struct branch and the enum-variant
sum, matching LLVM's layout. **Now: `n3.milo` clean at `-O2`; stage2 built at `-O2`
via the `build` command produces stage3 that runs programs and emits
`stage2==stage3==stage4` byte-identical; manifest-wide 212/339 fixtures identical,
0 diverge. Self-hosting converges at the production `-O2` level end-to-end.**

### M5 follow-on (historical): `-O2` uninitialized-HEAP miscompile — how it was chased

Convergence + build/run all verified at **`-O0`/`-O1`**. milo0's own `build`
command defaults to **`-O2`** (`main.milo:236,255`), and a self-built binary at
`-O2` **miscompiles**: `/tmp/n3.milo` (`fn f(): i64 { var x: i64 = 0; return x }`)
→ `return type mismatch: expected i64, got i32` — the checker's `VarInfo.ty` for
an annotated `i64` local reads back as `i32`. Characterized (does NOT block M5,
which is `-O0`-converged; the deployed `milo-self.bin` is oracle-built and fine):

- `-O1` clean; `-O2` fails deterministically. `clang -O0 -g -fsanitize=address,undefined`
  on the self-IR is **clean** (no report) → not a heap-overflow / signed-overflow.
- IR has **zero `nsw`/`inbounds`** → not a strict-overflow assumption.
- `-ftrivial-auto-var-init=zero` and `=pattern` at `-O2` **do NOT fix it** → it is
  **not** an uninitialized *stack/alloca* read. That leaves **uninitialized HEAP**
  (a malloc'd slot read before it's fully written) — which auto-var-init doesn't
  cover and ASan can't catch; MSan is unavailable on arm64-darwin.
- The value is a `TypeKind` enum payload (`TInt(bits, signed)`, `bits` in payload
  slot 0). Isolated repros of enum-payload reassignment AND match-arm reassignment
  of an outer enum var both round-trip 64 correctly at `-O2` — so the bug is in the
  fuller path `checkLetDecl` walks: `valType = hint` → `VarInfo{ty: valType}` →
  `declare` into a scope HashMap (malloc'd) → later `lookup`/clone-out → `.ty` read.
  Suspect: a `TypeKind`/`VarInfo` copy that writes the tag + slot 1 but leaves
  payload slot 0 holding the *prior* `TInt(32)` bits, benign at `-O0` (full
  aggregate store) but exposed at `-O2` (store-forwarding reads the stale slot).
- **Next**: bisect the enum→struct-field→HashMap→clone store chain; check whether
  `zeroed<T>`/enum-lit construction leaves payload slots undef and whether a
  malloc'd VarInfo slot is memset before the aggregate store. Interim mitigation
  if needed: milo0 `build` at `-O1` (proven clean) until the heap-init is found.

### Review leads (2026-07-10, code review of recent commits; round 2 same day)

**1. ~~genHashMapGet shallow copy~~ — CONFIRMED AND FIXED** (`4f9d443` get,
`80479f8` getOrDefault, incl. the &self-ptr ABI fix in `genCloneOfLoaded`).
Was the vecJoin runaway. Kept here for the mechanism record: shallow load of the
found value shared Vec/String buffers with the map entry; dropping the returned
Option freed them → later gets read freed memory → garbage `FnSig.params.len`.

**2. THE SAME UAF CLASS IS STILL LIVE for every map whose value type has no
`impl Clone`.** Verified oracle semantics: TS `map.get` deep-clones
**structurally** via `emitDeepCloneFromPtr` (`src/codegen.ts:6328` — degrades to
plain load only for Copy types; no user impl needed). milo0's `genCloneOfLoaded`
only handles %String / user-impl-Clone / shallow-fallback (`expr.milo:1008-1009`
"value copy is a faithful clone" — false). Only TypeKind/FnParam/FnSig have
`impl Clone` — so `ck.functions` is now safe, but these checker maps still get
shallow copies out of stage2's `.get`:
- `structs: HashMap<string, StructInfo>` — StructInfo.fields is a bare
  `Vec<CkStructField>` → dropping the get result frees the map's field buffer;
  `checker/expr.milo:403` `ck.structs.get(name)!` is on the field-access path.
- `enums: HashMap<string, EnumInfo>` (EnumInfo.variants is a **HashMap**),
  `traits`, `traitImpls: HashMap<string, Vec<ImplInfo>>` (bare Vec value —
  genCloneOfLoaded has no Vec deep-clone at all), `inherentImpls`,
  `generic*` maps, and `scopes: HashMap<string, VarInfo>` (VarInfo — benign
  today only when `ty` is a no-Heap-payload TypeKind like TInt; TRef/THeap/
  TVec-typed vars free their Heap box on drop).
This is the next runaway/corruption waiting — likely surfaces as soon as
stage2 checks struct/enum/impl-heavy code. Fix properly once: a structural
deep-clone emitter mirroring `emitDeepCloneFromPtr` (struct → per-field,
enum → switch-on-tag per-variant, Vec → new buffer + per-element clone,
HashMap → per-entry, Heap → malloc + clone pointee, Copy → passthrough), and
route `genCloneOfLoaded`'s fallback through it. Interim guard: fail loud in
`genCloneOfLoaded` when the type is %Vec/%HashMap or a struct/enum lacking a
helper and containing non-Copy fields.

**2a. Current bug (`/tmp/n3.milo`, `var x: i64` reads back i32) — candidate
mechanisms from this review, in order:** (i) a `checkLetDecl`-path construct
miscompiled by milo0 (the `Option<MiloType>` annotation match / `typeFromAst`
round-trip; bare `return 0` works, so it's specifically the annotated-VarDecl
checker path — eprint `typeName(ty)` at `declare()` and again at `lookup()` to
see whether the TInt(64) is wrong at store or at read); (ii) the TInt payload
`(i32, bool)` write/read layout inside stage2's VarInfo round-trip through
scopes insert/get. Note `lookup`'s VarInfo shallow-copy (#2) does NOT explain
n3 — TInt has no heap payload, its drop frees nothing.

**2b. Related real divergence found while checking (probably not n3's root
cause, but fix it):** `Stmt.LetDecl`/`VarDecl` codegen **ignores the type
annotation for the local's type** (`codegen/stmt.milo:499-526` — local ty =
`v.ty`, the init expression's type; the annotation is only passed as a hint).
IntLit honors the hint (`expr.milo:1786`), so literals are fine — but any init
whose type genExpr derives independently of the hint (call results, casts,
field reads of differing width) silently gives the local the WRONG type vs the
oracle (annotation must win, with an int-width coerce on store).

**3. `payloadBytes` recursion drops `resolveTyStr`** (`codegen/types.milo:234`):
the outer sizing loop resolves each payload (`emit.milo:216`) but the recursive
call passes raw UNMANGLED payload types — `TArray(Heap<TypeKind>, Option<i64>)`
recurses on `"Option<i64>"`, which isn't registered (mono name is `Option_i64`)
→ 8-byte fallback (real: 16). Latent today only because TFn's 32B dominates
TypeKind's max; same undersizing class dc68742 just fixed. One-line fix:
`payloadBytes(cg, resolveTyStr(cg, …))` at the recursion site (struct-field
branch is safe — fields are stored resolved at registration, `emit.milo:201`).

**4. `payloadBytes` struct branch ignores LLVM field alignment padding**
(`types.milo:240-247`): packed sum vs LLVM's aligned layout. `{i1, i64, i1, i64}`
sums 18 → 24 slot bytes vs real 32. Current checker structs survive by rounding
luck (verified FnSig 66→72 = real 72; VarInfo 68→72 = real 72) — one reordered
field breaks it silently. Fix: align each field to `min(natural, 8)` while
summing and round the total, mirroring LLVM struct layout.

**5. Minor**: `genHashMapInsert` found-path overwrites the old value without
dropping it (`expr.milo:263` — leak, not corruption); `findLocal` falls back to
`locs[0]` on miss (`types.milo:387`) — violates the fail-loud rule, make it panic.

**6. Safer tool than bare lldb for any future "one giant alloc"**: emit (or
LD-interpose) a `_miloMallocChecked` wrapper that aborts with the requested size
when it exceeds ~1GB — deterministic, OOM-safe, and the abort backtrace names the
call site without a 1.5GB live process.

**7. milo0 has NO alloca hoisting** (31 inline `alloca` sites across
`codegen/expr.milo`/`stmt.milo`; no hoist pass in `genFn`). Oracle bug class
`400a71f` all over again: any alloca that lands inside a loop body's IR
reallocates stack every iteration until the frame returns. The `4f9d443` fix
added one directly on the hottest path — `genCloneOfLoaded`'s materialize-slot
runs on **every map get**, and gets sit inside loops (`lookup`'s scope walk,
checker scan loops). Bounded per-frame by trip counts, so not an immediate
fire, but it's quiet stack growth in the biggest checker frames; port
`hoistAllocas` (collect `= alloca` lines from the body, move to entry block)
sooner rather than later — it's also a precondition the Working Agreement
already mandates.

### Exclusion list (fixtures milo-self is not expected to pass yet)

(populate at M0 seed time)

### Parity progress (2026-07-10) — milo-self compiling real example programs

Self-hosting compiler is converged/done; this tracks the **parity** goal (milo-self
compiles the full example suite, so the self-built binary can replace the bun
compiler). **14/30 examples compile via milo-self** (up from 13). Fixes landed this
session, each keeps manifest 173 green + byte-identical -O2 convergence:
- int-literal coercion in **method** args (checkMethodCall mirrored checkCall) → fmt/rg/tree/parallel
- `jsonStringify` intrinsic (checker + genJsonStringify, scalar struct fields)
- `Vec.len()` / `.swap()` methods
- `llType` idempotent on `"double"` (float literal arg was emitted `i32 3.5`)
- single-interpolation f-string `$"{x}"` goes through `format()` (was returning raw expr type)
- `print()`/`println()` Display struct/enum args as `%s` (was `zext` aggregate) → hex

Remaining gaps, bucketed (each is one root cause, not per-example):
- **parser "unexpected token" (5):** flightController, kvstore, minilang, splitPty,
  sysmon — parse desync; sysmon/flightController is `if x == CONST {` parsed as a
  struct literal (`CONST { ... }` eats the block brace). Fix: no-struct-literal mode
  in if/while condition position (Rust-style).
- **arena generic inference (4):** depgraph, domArena, htmlParse, linkedList —
  `arenaNew<T>()` / `arenaGet<T>` can't infer T.
- **json/net codegen stack (5):** pkg (gep unsized), shuf (float i32/double), fetch +
  httpClient (i64/i32 slot), json (integer constant) — stacked codegen type bugs.
- **singles (2):** serve (u16→Option<u16> auto-wrap coercion), webserver (`embedFile` intrinsic).

Method: run milo-self over `examples/**`, bucket errors; fix the shared root, not the
example. `.len` exists as both field (`.len`) and method (`.len()`) — a language wart
matching the oracle, worth unifying.

### Parity progress (2026-07-10, cont.) — 18/30 examples compile via milo-self

RUN goal (examples must compile AND run correctly). Jumped 13→18 via a stack of
codegen fixes surfaced by running calc + the json/net examples (all keep manifest
173 green + byte-identical -O2 convergence):
- **float codegen**: i8/i16 `.toString()`; int literal in float position → float const;
  FloatLit always has a decimal (`0.0`→`"0"` was invalid); `as f64`/`as i64` casts
  emit sitofp/fptosi/fpext etc (were relabels); BinOp on doubles uses fadd/fdiv/fcmp.
- **extern declares**: `exit()` ensures `@exit`; `strlen` ensured + coordinated.
- **integer width reconcile**: enum-literal payload store (`Result.Ok(i64)` into a
  u32 slot) truncs; String.push of a wide byte truncs; **BinOp reports the widened
  result type** when a narrow operand is extended (so `(u8 | i64shift) as u8` truncs
  instead of seeing u8→u8 no-op) — this unblocked fetch/httpClient/json.

Verified RUN parity: **json** emits `{"name":"Alice",...}` byte-identical to oracle;
10/11 cli-tools' `--help` already match the oracle. calc compiles+runs but has a
calc-specific tokenizer miscompile (outputs first number only) — deferred.

Remaining 12, bucketed:
- **arena generic inference (5):** minilang, depgraph, domArena, htmlParse, linkedList
  — `arenaNew<T>()` has no args, so T must come from the expected return type (the
  `let a: Arena<X> = arenaNew()` annotation); milo0's generic inference is arg-only.
  Fix: propagate the let/return expected-type hint into checkCall's inference.
- **global consts (3):** flightController, splitPty, sysmon (`let KEY_QUIT: i32 = 5`
  at module scope — needs GlobalDecl in AST/parser/checker/codegen).
- **singles (4):** pkg (gep unsized), kvstore (string `<=`), serve (Option auto-wrap),
  webserver (embedFile).

### Parity progress (2026-07-11) — kvstore RUN-parity, closure/coercion fixes

Global consts + arena *inference* (expected-type hint) landed earlier this stretch;
**kvstore now compiles AND runs byte-identical to the oracle**. This session's
landings (each keeps manifest 173 green + byte-identical -O2 convergence):
- **`Vec.insert(i,x)` / `Vec.remove(i)`** — index insert (shift right, grow if full)
  and remove (return elem, shift left). checker methods + genVecInsert/genVecRemove.
  → kvstore compiles; RUN output diffs identical to oracle.
- **int-literal coercion for `??` and array literals** — `opt ?? 0` coerces the
  bare-`0` default (i32) to the Option's i64 inner; `[i64;N] = [31, x, …]` adopts the
  annotation's element type so int literals coerce instead of pinning to element 0's
  width. Empty `[]` adopts the annotation's Vec/Array type. → termpair/client compiles.
- **closure return-type inference** — `checkClosure` was a stub that never walked the
  body, so every unannotated closure typed as `() => void`. Now infers the return type
  from a `return <expr>`/trailing expr, rolling back capture moves during inference
  (snapshot/restore). → fixes the serve middleware `(&mut Context) => Response` chain.

Refined remaining buckets (12 → the hard cores):
- **Response name collision (3):** serve, weather/app, webserver — `struct Response`
  (std/net) and `enum Response` (std/http) share the name; milo0's checker uses a flat
  global type table (no per-module import visibility), so `HandledResponse.response`
  (http's enum) fails `typeEq` against net's struct → "expected Response, got Response".
  Needs module-scoped name resolution (deep). Same collision hits the `(&Request) =>
  Response` fn-type compares.
- **Option auto-wrap (serve:184):** passing `u16` where `Option<u16>` expected — wrap
  bare value in `Some` at coercion sites.
- **embedFile (webserver, termpair/server):** compile-time file-embed intrinsic.

Note: termpair/protocol, termpair/encryption, gdbgui/gdbmi are **libraries (no `main`)**
— they link-fail as standalone builds under both milo-self AND the oracle, so they are
not parity targets. The termpair entrypoints are client.milo (compiles) + server.milo.

### Parity progress (2026-07-11, cont.) — the arena bucket is really CLOSURE CODEGEN

Two checker fixes landed (manifest 173 green, byte-identical -O2 convergence):
- **`normalizeEnumNames` recurses into `TFn`** — a `(&Expr) => Expr` param built from
  a bare type name kept its inner `Expr` as the uppercase `TStruct` fallback, so it
  failed `typeEq` against a closure whose own type resolved the name to `TEnum` →
  "expected Expr, got Expr". Shared root; also relevant to serve's `(&Request) =>
  Response` fn-type compares.
- **int-literal coercion in enum-variant construction args** (`Expr.Num(i32-lit)` into
  an i64 field) — mirrors the same coercion already in call/push/`??`/array sites.

With those, **minilang type-checks fully** — its only remaining error is codegen. That
reframes the "arena generic inference" bucket: **inference is solved; the real blocker
is that milo0 codegen has NO closure support.** `genExpr` has no `Expr.Closure` arm, so
every closure value falls through to the `_ => Val{v:"0", ty:"i64"}` default and is
emitted as `i64 0`. That is why `arenaWith` is called as `call i32 @arenaWith(…, i64 0)`
with a defaulted i32 return and the closure lowered to a null.

**The single biggest remaining feature = first-class closure codegen** (blocks all 5:
minilang, depgraph, domArena, htmlParse, linkedList). It is NOT a non-capturing shortcut
— the example closures capture (`(n: &Node): Handle<Node> => n.children[i]` captures `i`;
the `arenaModifyMut(…, (n: &mut Node) => { … })` bodies capture outer locals). Needs the
full oracle approach (src/codegen.ts: `closureBodies`/`closureCounter`): lift each
closure body to a top-level function, capture the environment as a struct, represent the
closure as a fat pointer `{fnptr, env}`, and lower calls through it. Also fixes the
downstream `resolveFnName` >1-instantiation fallback and the empty `paramHints` (sigs are
keyed by the mangled name but the call still carries the bare generic name — the checker
should thread the monomorphized name to codegen, or codegen must re-derive it).

calc verified at full RUN parity (earlier "tokenizer miscompile" note was stale — a prior
float/int-width codegen fix cleared it; expressions + `--help` match the oracle exactly).

### RUN-parity audit (2026-07-11) — the entire COMPILING set matches the oracle

Built every compiling example via milo-self AND the oracle, diffed stdout+exit:
- **13/13 cli-tools** — `--help` identical, and real ops identical (cat/wc/grep -i/hex/
  jq `.`+`.name`/rg/tree/fmt on fixtures). (The parallel/timeout `--help` "diffs" were
  only the oracle's compile-time `unnecessary 'unsafe'` warnings on stderr — a diagnostic
  gap, not a RUN gap: milo-self doesn't emit that lint. Program stdout matches.)
- **fib, fizzbuzz, hello, json, pidStep, gdbmiTest, kvstore, calc** — identical.
- **flightController** — the 30000-tick TUI renders byte-identical; runs continuously so
  the guard kills it (exit 137 both), first ~13k lines identical (frame-count only diff).

Conclusion: there are **no hidden RUN bugs** in the compiling set. Every remaining parity
gap is a COMPILE gap, and each traces to closures, the Response name-collision, or
embedFile. Notably **serve/weather/webserver also pass handler closures**
(`serve(port, (req: &Request) => { … })`), so **closure codegen actually blocks ~8
examples** (5 arena + 3 servers), not 5 — decisively the top lever.

### Closure codegen — implementation plan (next focused push; too big for one loop tick)

milo0 `genExpr` has no `Expr.Closure` arm and `emit` writes a single stream (functions
can't nest in LLVM), so this needs, in order:
1. **Deferred body buffer.** Add `cg.pendingFns: Vec<string>` (or redirect `emit`).
   genProgram flushes it after each function. Lets a closure body be emitted as a
   sibling top-level `define`.
2. **Closure value repr.** A closure = `%Closure = type { ptr, ptr }` (fnptr, env). The
   fn-type param `(&T) => R` lowers to `%Closure`. Register `%Closure` once.
3. **Capture analysis.** Free vars in the body = idents referenced that aren't params,
   locals declared inside, globals, or fn names. Compute in codegen from `locs` in scope
   (a name in `locs` but not a closure param ⇒ capture). By-ref default: env = struct of
   `ptr` to each captured var's alloca.
4. **genExpr Closure.** Assign `@__closure_N`; save/reset `cg.temp`/`cg.label`/`locs`;
   emit `define R @__closure_N(ptr %env, <params>)` into `pendingFns`; inside, load each
   capture from env (gep) as a ref-local, bind params like genFn; gen body. At the call
   site: alloca env, store captured addresses, build the `{@__closure_N, %env}` pair.
   Refactor genFn's param-binding + body loop into a shared helper to avoid duplication.
5. **Indirect call.** In genCall, if the callee name is a local of `%Closure` type,
   extract fnptr+env and `call R %fnptr(ptr %env, <args>)` instead of a named call.
6. **Mono-name threading.** The call still carries the bare generic name (`arenaWith`)
   while sigs/fnRets are keyed by the mangled `arenaWith_Node_Expr`, so `paramHints` is
   empty and `resolveFnName` can't pick among >1 instantiations. Fix: have the checker
   record each monomorphized call's resolved name (span-keyed side table read by codegen),
   or have codegen re-derive it from the concrete arg types.

Target order: minilang first (its lone closure `(e: &Expr): Expr => cloneExpr(e)` captures
nothing → validates steps 1,2,4,5,6 without capture analysis), then the capturing arena
closures (step 3), then the servers (which also need Response-collision + embedFile).

### milo-self IS FASTER than the bun/TS oracle (2026-07-11)

The whole point of shipping the self-built binary: it's faster. Measured `emit-ir` wall
time (compiler only, no clang), best of 3, milo-self running THROUGH the guard wrapper
(which adds bun-startup — so the raw native compiler is faster still):
- webserver: **milo-self 0.04s vs oracle 0.07s** (~1.75×)
- whole compiler graph (`src-milo/main.milo`): **milo-self 0.14s vs oracle 0.23s** (~1.6×)

So the self-hosted native binary already beats the bun/TS compiler on the same inputs,
with parity output. Shipping `.selfhost/milo-self.bin` (guarded) as the default compiler is
now a speed win as well as a self-hosting milestone.

### PARITY CONFIRMED (2026-07-11) — full RUN-parity sweep, only non-determinism left

Ran a comprehensive self-vs-oracle diff (built both binaries, compared stdout+exit):
- **`--help` on all 23 main examples**: identical, except sysmon (a live TUI — CPU%/PID
  data differs per run, same format) and fetch (fixed below).
- **cli-tool operations across varied inputs**: jq (`.`/`.a.b`/`.a` on nested json),
  rg (regex `[0-9]+`, `-i`, `-c`), tree (`-L`), hex (binary/NUL bytes), wc (`-l`),
  cat (`-n`), fmt (`-w`), timeout (`5 echo`, `1 true`), parallel (`echo` over stdin),
  pkg — **all byte-identical**.
- **Apps** (verified earlier): serve, weather, webserver (all JSON endpoints), kvstore,
  flightController, calc, fib, fizzbuzz, hello, json, pidStep, gdbmiTest + all 5 arena.

**Last diagnostic gap closed**: the `!` unwrap operator's panic (`error at L:C: <msg>`)
reported `0:0` — the parser hardcoded `Option.None` for the Unwrap span. Now it carries
the operand's start span (matching the oracle's column, not the `!` token). Verified:
`jsonParse("{bad")!` → `error at 3:13: malformed json` on both.

Follow-up verification (2026-07-11) closed most of the "non-deterministic" list by making
it deterministic:
- **httpClient** (the net CLIENT stack): pointed both self+oracle at a LOCAL milo-self
  webserver (`http://localhost/json`) → **byte-identical** response + `HTTP 200 OK`. The
  HTTP stack is now proven end-to-end (client AND server) under milo-self.
- **splitPty**: run without a TTY, both take the same fallback path → **byte-identical**.

Genuinely unverifiable-by-byte-compare (environment-bound, not milo-self gaps): sysmon
(live CPU/PID data), fetch (hardcoded httpbin.org — but its net path is covered by
httpClient and its error-span path is verified), termpair/{server,client} (live websocket +
browser/terminal). Format and control flow match. **The compile-AND-run parity goal is met
for the entire example suite.**

### 🎯 ALL 35 REAL TARGETS COMPILE (2026-07-11) — servers included

**Every example with a `main` now compiles via milo-self AND runs at oracle parity.** The
sweep is 35/38; the 3 non-compiling files (gdbgui/gdbmi, termpair/{protocol,encryption})
are **libraries with no `fn main`** — they link-fail under the ORACLE too, so they are not
parity targets. Manifest 173 + byte-identical -O2 convergence held across every fix.

The last two servers fell to:
- **termpair/server**: `genLvalue`'s Vec-index path now resolves the generic element type
  (`Vec<Channel<string>>` → `Channel_string`), so a method call on an indexed global
  channel (`toTermChans[i].tryRecv()`) stops emitting an unsized `%Channel<string>`.
  Compiles; `--help` matches the oracle.
- **webserver**: two features —
  1. **Anonymous JSON object literals** `{ k: v, … }` (`ctx.json({...})`): new
     `Expr.JsonObject` through parser/AST/checker/codegen/mono; serializes to a JSON string
     matching `jsonStringify`'s format.
  2. **fn-name-as-closure adapter thunk**: a NAMED function passed as a handler
     (`r.get("/json", jsonHandler)`) becomes `%Closure {@__fnthunk_jsonHandler, null}` — the
     thunk drops the closure ABI's `env` param and adapts args (ref → pass ptr, value →
     load) to the named fn's direct signature. (serve worked already because it passed a
     closure *literal*, which carries the env param.) A fn-name **cast to a raw ptr**
     (`trampoline as *u8`, spawn) still uses the real `@name` via `genAsCast`, not the thunk.
  webserver now returns **byte-identical JSON on every endpoint** (`/json`, `/fib/:n`,
  `/prime/:n`, `/collatz/:n`, `/fizzbuzz/:n`, `/search?q=`, `/hello`) vs the oracle.

RUN-parity verified this stretch: all 13 cli-tools, all 5 arena examples, serve (serves
files), weather (serves embedded assets), webserver (all JSON endpoints), calc, fib,
fizzbuzz, hello, json, pidStep, gdbmiTest, kvstore, flightController. The parity goal —
milo-self compiles AND correctly runs the full example suite — is essentially met.

### SERVERS: serve + weather at parity (2026-07-11) — 33/35 real targets compile

After the arena/closure bucket, the server examples fell to four fixes (manifest 173 +
byte-identical convergence each):
- **Option auto-wrap**: a bare `T` arg coerces to an `Option<T>` param (`serve(port:
  u16?, …)` with a plain u16) — checker `optionWrapCoercible` + codegen `genWrapSome`.
- **fn-typed values carry their return type** (`fn:R` / `Closure:R` via astTypeStr): an
  indirect closure call through a fn-typed PARAM (`let resp = handler(req)` inside serve's
  socket loop) recovered R=Response instead of defaulting to i64 → **serve serves files
  correctly** (was returning an empty/truncated Response). Verified: `curl` returns the
  file; `--help` matches the oracle.
- **embedFile intrinsic**: compile-time file read (sourceDir threaded through genProgram
  → Cgen) emitting a string literal. **weather compiles AND serves its embedded
  index.html**; `--help` matches.
- **Mutable module globals** (`var` at top level): parser now accepts `var`/`let` globals
  with a `mutable` flag (AST/checker); codegen stores through `@name`, aggregate globals
  (`var xs: Vec<T> = []`, `var s: string = ""`) zero-init with `%String`/`%Vec` declared
  first, and globals carry their SURFACE type so field/element resolution works
  (`sessions[i].terminalId`, `sessions.push(...)`).

**Remaining 2 real targets:** webserver (anonymous object literals `ctx.json({ query: q })`
— a parser feature milo0 lacks) and termpair/server (needs `Channel<string>` type mangling
in `resolveTyStr`/index — a green-channel concurrency type not registered as a struct; the
mutable-globals work got it past parsing + embedFile but the channel Vec index still emits
an unmangled `%Channel<string>`). Both are complex concurrent servers.
Libraries (gdbmi, termpair/{protocol,encryption}) have no `main` → not parity targets.

### ARENA BUCKET COMPLETE (2026-07-11): all 5 examples at parity ✓✓

**minilang, depgraph, linkedList, htmlParse, domArena — all compile AND run byte-identical
to the oracle** (manifest 173, byte-identical -O2 convergence throughout). Closures are
fully implemented (expression- AND block-bodied, capturing + non-capturing). What it took,
beyond the zero-capture foundation below:
- **Checker walks closure bodies** via `checkStmt` (checker/expr.milo imports checker/
  stmt.milo — milo0's resolver handles the circular import via flat-merge, confirmed).
  Inner locals (`var updated = n`) get declared; unannotated return type is inferred via a
  `pendingClosureRet` field stamped by `checkReturn` when the enclosing ret type is unknown.
  `&mut T` closure params are mutable (pointee assignable through the ref).
- **Codegen block bodies + captures** (in stmt.milo so it can call genStmt): by-ref env
  (`{ptr,…}` of captured var addresses), loaded in the lifted body; capture analysis walks
  the body for idents in the enclosing `locs` that aren't params. Unannotated return type
  is inferred by emitting the body first (a `__closureinfer__` sentinel makes `return` use
  the value's own type and record it) then prepending the `define` header.
- **Generic-call disambiguation** (`disambiguateGenericCall`): when a generic like
  `arenaWith` has >1 monomorphization, `resolveFnName` can't pick — so match the actual
  arg LLVM types against each candidate's `paramTys` (ref params → `ptr`), and break the
  closure-return ambiguity by matching the closure arg's carried return type (`Closure:R`)
  against the candidate's `Option<R>` return (exact, after stripping `Option_`).
- **Nested-generic mangling**: `resolveTyStr` recurses into `Vec<…>` elements; `genField
  Access`/`genIndex`/`genVecPush` resolve their element type so no unsized `%Handle<Node>`
  reaches `genSizeOf`. Added the `assert(cond[,msg])` builtin (branch + dprintf + exit).

**New frontier (servers, now unblocked past closures):** serve/webserver hit the
**Option auto-wrap** (`serve(port: u16?, …)` called with a bare `u16` → "expected
Option_u16, got u16"). Fix: `optionWrapCoercible` in checkCall's arg check (paramType's
`unwrapableInner` == argType) + codegen wraps the value in `Some` at the call site. weather/
app hits `no method 'clone' on type <unknown>`; termpair/server `cannot assign to immutable
variable` + embedFile. Libraries (gdbmi, termpair/{protocol,encryption}) have no `main` —
not parity targets (link-fail under the oracle too).

### Closure codegen — LANDED (2026-07-11): expression-bodied, zero-capture ✓

**Shipped green** (manifest 173, byte-identical -O2 convergence): first-class closures for
the expression-bodied, non-capturing case. **minilang compiles AND runs byte-identical to
the oracle** (`42/100/3/100/25`, exit 0) — the first arena example at parity. The one
blocker from the earlier revert (fn-typed values vs the raw-fnptr spawn path) is resolved:
a bare **function name used as a value** now lowers to `%Closure {@fn, null}` (it was
hitting `findLocal`'s `locs[0]` fallback and loading the wrong var — a latent bug the
`%Closure` typing surfaced), and `%Closure` **decays to its fnptr (field 0)** on cast-to-ptr
(`genAsCast`) and when passed to a `ptr` param (`genCall` arg loop, like Vec/String decay).
That keeps all 12 thread/promise fixtures building.

**Next increment (the other 4 arena examples):** depgraph/linkedList/htmlParse/domArena use
**block-bodied, capturing** closures (`arenaModify(g.arena, src, (n: Node) => { … })`;
`(n: &Node): Handle<Node> => n.children[i]` captures `i`). They now fail with
`undefined variable 'updated'` / clang errors because `genClosure` only handles a single
Return/ExprStmt with no captures. Needed: (a) walk a multi-stmt body — but genStmt is in
stmt.milo and expr.milo can't import it (circular); options: move genClosure into stmt.milo
(it already imports genExpr) or factor the body loop into a shared module; (b) capture
analysis — scan the body for idents that are in the enclosing `locs` but aren't closure
params/globals; build an env struct of their addresses; in the lifted body load them from
`%__env` as ref-locals (the uniform-pointer ABI already threads `%__env`).

Recipe that shipped (for extending):
- `%Closure = type { ptr, ptr }` in the preamble; `llType("fn")→"%Closure"`;
  `closureId` counter on Cgen.
- `genClosure` (expression-bodied only): buffer-swap trick — save `cg.body`/`temp`/
  `label`/`curRetTy`, set `cg.body=""`, emit `define R @__closure_N(ptr %__env, <ptr
  params>)`, gen the single Return/ExprStmt via genExpr (NO genStmt → avoids the
  expr↔stmt circular import), then `cg.globals += closureIR` and restore. Returns
  `insertvalue %Closure {@__closure_N, null}`.
- **Uniform "args-by-pointer" ABI** (the key design call): a fn-typed param loses its
  inner ref-ness, so the call site can't know whether to pass value or address. Fix:
  closures ALWAYS take args by pointer — `genClosure` headers every param as `ptr %p`
  and binds it `isRef:true`; `genClosureCall` passes each arg via `genLvalue` (address).
  This handles `(&T)`, `(&mut T)`, and read-only `(T)` uniformly. (Without it, arenaWith
  passed `%Expr` by value into a `ptr %e` param → garbage ptr → cloneExpr looped/hung.)
- `genClosureCall`: load `%Closure` from the local's addr, `extractvalue` fnptr(0)+env(1),
  `call R %fnptr(ptr %env, <ptr args>)`. R comes from the enclosing `hintTy` (dispatched
  from the genExpr Call arm, which has it) since "fn" drops the return type.
- `genStructLit` must `resolveStructName(name)` first: a monomorphized body builds a bare
  `Handle {…}` that has to resolve to the sole instantiation `Handle_Expr` (else
  `alloca %Handle` is unsized). Independent, correct, low-risk — keep it.
- For minilang, arenaWith has ONE instantiation so `resolveFnName` prefix-match already
  resolves `arenaWith_Expr_Expr` — step 6 (mono-name threading) is NOT needed until an
  example instantiates the same closure-taking generic at >1 type.

**THE ONE BLOCKER (why it was reverted):** `llType("fn")→"%Closure"` regressed 12
thread/promise fixtures (arenaContracts, eventLoop, poolAlloc, dateTime, …). Their spawn
stdlib fn takes `f: () => void` and calls `pthread_create(thread, null, f, env)` treating
`f` as the raw start_routine **fn pointer** (`ptr`). With `f` now `%Closure`, clang
rejects `pthread_create(…, ptr <%Closure>, …)`. (In the pre-change build `f` was the `i32`
fallback, so the stdlib's `malloc(16)+memcpy(f_addr,16)` already read 12 bytes past a
4-byte alloca — a latent bug that only "passes" because the manifest checks BUILD success,
not spawn runtime.)

**THE FIX (do this first next time):** add a `%Closure → ptr` decay in genCall's arg loop,
mirroring the existing String/Vec→ptr decay (~line 2105): when an arg's llType is
`%Closure` and the param/extern wants `ptr`, emit `extractvalue %Closure <v>, 0` (the
fnptr) and pass `ptr`. That satisfies pthread_create's start_routine and keeps the 12
fixtures building, while arena closures (called through genClosureCall, not decayed) keep
the full pair. Re-apply the 8 edits above + this decay, then verify: minilang runs at
parity AND manifest stays 173 AND -O2 convergence byte-identical.
