<!-- doc-meta
system: roadmap
purpose: staged plan to grow milojs into a JavaScript engine AND runtime that stands on its own
key-files: examples/runtimes/milojs/milojs.milo, examples/runtimes/milojs/milojs-engine.milo
update-when: a stage lands (check the box, note the commit) or the acceptance target changes
last-verified: 2026-07-22
-->

# milojs roadmap — a JavaScript engine written in Milo

## Current snapshot (2026-07-20)

The detailed stage notes below preserve the implementation history, but several
"next" and "still open" paragraphs inside Stage 3 predate the latest work and
are no longer a current backlog. Since then MiloJS has landed CommonJS/ESM module
loading, strict equality and additional syntax, promises and a microtask/event
loop, green-task suspension at `await`, Node compatibility shims, Node-API addon
loading, and an end-to-end Prisma query-engine proof.

The engine differential suite currently covers 74 expected-output JavaScript
files (plus one unscored memory benchmark) and is also run with collection at
every GC safepoint. The remaining roadmap is:

- **Stage 4:** replace or supplement the tree walker with bytecode for practical
  performance and shallower native stacks.
- **Stage 5:** complete host compatibility. Server HTTP and async fetch work;
  client `http.request`/`http.get`, TLS serving, child processes, generators,
  class fields/getters, computed `require`, and other package-facing edges do not.
- **Stage 6:** run and publish a pinned test262 score. The QuickJS sweep harness
  exists, but it depends on a separate local QuickJS test checkout.

The source and locked fixtures are authoritative when an older stage narrative
below conflicts with this snapshot.

**Scope decision (2026-07-22):** milojs is **our own engine and our own runtime** — a destination,
not a means to an end. It is *not* a JavaScriptCore replacement for minibun. `minibun` and the
node fork at `~/git/node` are frozen: kept for reference, not developed further. Do not justify
milojs work by what it unblocks in either.

**Acceptance target:** `milojs` runs real Node/Express workloads directly — module loader, event
loop, and Node-compatible builtins all its own. No system framework, no V8, no JSC. One binary.

**Why this stands alone:** the *engine* (`milojs-engine`) runs raw JavaScript with no host
bindings, which is what an embedder wants. The *runtime* (`milojs`) adds the module loader, event
loop, and Node surface. Both ship from
[milo-language/milojs](https://github.com/milo-language/milojs) with cross-platform release
binaries. The measure is what real applications it runs and what its conformance number is — not
whether some other host can swap it in.

**The thesis this proves:** Milo already self-hosts its own compiler (lexer → parser → checker →
codegen → LLVM). A JS interpreter is strictly *less* than that — no monomorphization, no LLVM
backend. The only piece Milo's ownership model does not hand us for free is a garbage collector,
because JS object graphs are cyclic (`a.b = a`) and single-owner move semantics cannot express a
cycle. That GC is the one genuinely new thing built here (Stage 2); everything else is parsing +
dispatch Milo is already good at.

## Do NOT port QuickJS line-by-line

QuickJS is ~50k LOC of dense C: NaN-boxing, ref-counting-with-cycle-collector, hand-rolled
allocators. Porting C→Milo fights the ownership model on every line. Use QuickJS as an
*architecture reference* (value model, opcode set, builtin coverage) and write idiomatic Milo:
tagged-enum values, a managed heap of `u32` handles, a mark-sweep collector.

## Stages (critical-path order)

### Stage 1 — tree-walking interpreter: primitives + closures ✅ (f08b267)
Lexer, parser → AST (Milo enums), `JSValue` tagged enum (Undefined/Null/Bool/Number(f64)/
Str/Function), tree-walking evaluator with a lexical scope chain, `console.log`. Statements:
let/var/const, function decl, if/else, while, return, block, expression. Expressions: literals,
identifiers, binary/unary/logical ops (`+` concatenates when either side is a string), calls,
closures capturing their defining scope. **Out of scope:** objects, arrays, `this`, GC, regex,
for-loops, ternary, exceptions, bytecode.
**Proves:** the value model and eval loop on the subset that needs no heap.
**Gate:** a `.js` demo (arithmetic, string concat, if/while, a closure counter) compiles and
prints correct output under `milo run`.
**Landed:** `examples/runtimes/milojs/milojs.milo` (~1480 LOC). Value model
`enum JSValue { Undefined, Null, Bool, Number(f64), Str, Func(fnIdx, scopeIdx) }` — `Func`'s
scope index *is* the closure. AST is index-based enums into flat `Vec` arenas (std/json cursor
pattern), scopes an append-only parent-linked `Vec<Scope>` (chosen so Stage 2 marking is an
index walk). `tests/{basics,closures}.js` output verified **byte-identical to `bun`** (fib(20),
two independent counters, closure-over-loop-var, compose). Friction found: no `1e15` float
literals; f64 `!=` is an *ordered* compare so `n != n` is false for NaN (must write `!(n == n)`)
— candidate for a checker lint / `std/math` `isNan`.

### Stage 2 — mark-sweep GC over the scope arena ✅ (this session)
Scopes leaked (one per block/call — a while loop grew the arena unbounded). Added a mark-sweep
collector: **stable slots + free-list reuse, no compaction** (closures + parent links reference
scopes by index — moving a slot would need a fixup reaching in-flight values on the native
stack, which is unreachable). Roots = global scope 0 + an explicit `active` dynamic-call-stack
`Vec` (a fib frame's `parent` is global/lexical, not its caller/dynamic, so the parent chain
alone under-roots the live call stack). Mark walks parent + any `Func(fn, envIdx)` closure envs
in bindings; sweep adds unmarked non-free slots to the free-list and clears their vars.
**Safepoint discipline — the key idea:** GC runs *only* at `execBlock` statement boundaries
(one `maybeGc` call), the sole point where every live value is stored in a scope binding and no
closure is in-flight mid-expression. This makes transient closure refs safe with no temp-root
plumbing — keeps the collector ~130 lines of plain loops, no `unsafe`, no lifetimes.
**Proof:** GC stress (`tests/gc.js`, ~800k scope allocations) stays byte-identical to `bun`
*and* `MILOJS_GC_STATS=1` shows the **arena capped at 1028 slots** (vs ~800k without GC), 586
collections, live working set 2–4, free-list fully reused. Extend `markScope` with object/array
variants when Stage 3's heap lands — same index-walk shape.
- **Note:** this GCs *scopes*; Stage 3 adds an object/array heap (`Obj(u32)` handle variant on
  `JSValue`) to the same collector. The scope arena proved the model on the cyclic case
  (closure ↔ env) first.

### Stage 3 — objects, prototypes, closures over the heap 🟡 (objects landed)
**Objects done (b956706):** object literals, dot + computed property get/set, nested objects,
reference equality, and an `Obj(u32)` heap cell that flows through the *same* mark-sweep
collector — `markScope` gained a `markValue` that follows `Obj` handles into their props; the
object arena sweeps alongside scopes. Validated the Stage 2 design claim: adding a heap type was
extra `markScope` variants, nothing more. `console.log` inspect matches bun (multi-line, 2-space
indent, double-quoted values). GC stress with 100k short-lived objects stays byte-identical.
**Arrays done (c3f3c44):** literals, indexed get/set with grow-on-write, `.length`, `push`/`pop`,
nesting, arrays-of-objects — arrays reuse the object heap (a JSObj with an `elems` Vec + `isArray`
flag), so the GC marks elements alongside props for free. `console.log` matches bun for scalar
arrays; the multi-line wrap bun applies to arrays *containing* objects/arrays is a known cosmetic
gap (bun's inspect layout heuristic), not a semantic one.
**`this` / `new` / method dispatch done (00c06b2):** method calls bind `this` to the receiver;
`new Ctor(args)` builds an object, runs the constructor with `this`, and honors a constructor that
returns an object. The constructor-assigns-methods pattern and method chaining (`return this`)
work. `this` is a plain identifier bound in each call scope (plain calls get `this = undefined`).
A **temp-root stack** (`Interp.tempRoots`, marked by `collect`) keeps in-flight receivers,
closures, and part-built literals alive across a GC triggered mid-dispatch (a call argument can be
another call) — verified byte-identical under 177 collections. This closed a real
memory-safety hazard, not a theoretical one.
**Landed since:** `for` loops (97ac34b), `typeof`, `try`/`catch`/`throw`/`finally` (exceptions via
an unwinding flag that crosses call boundaries; pending values GC-rooted across finally), and
`++`/`--` + compound assignment + ternary (39cd87f, shared readLValue/writeLValue). During this
work a real **Milo compiler bug** surfaced and was fixed (7e77a0d): match-binding allocas were
numbered from a different counter than `let`/for allocas, so two same-named locals of different
types could collide on one `%name.N.addr` SSA name → link error.
**Native builtins + methods landed (6f312af):** `JSValue.Native` for built-in functions; the
Error family (`Error`/`TypeError`/`RangeError`/`SyntaxError`/`ReferenceError`) + `instanceof`
(per-object `ctor` slot for user constructors, error-kind match for the Error family); and the
big one — String methods (`length`/index/`toUpperCase`/`trim`/`slice`/`split`/`indexOf`/
`includes`/`replace`/…) and Array methods (`map`/`filter`/`reduce`/`forEach`/`join`/`indexOf`/
`slice`/`reverse`/`concat`/…), all byte-identical to bun, including `.split().map().join()`
chaining. String helpers live in a new `builtins.milo`; callback array methods stay in `eval.milo`
(they need `callFunction`). *Hazard found:* Milo flat-compiles all files into one namespace, so
milojs helper names must not collide with std (mine shadowed `std/string`'s `strIndexOf` and broke
std internally until renamed).
**JSON landed (e943e78):** `JSON.stringify` (compact, nested, escaping, undefined/function
omission, NaN/Infinity→null) and `JSON.parse` (recursive-descent over a byte cursor, builds heap
objects/arrays, temp-rooted while building). `JSON` is a global object whose methods are native
functions; `callMember` now dispatches `Native`-valued props. The real path
`JSON.parse(x).map(...).reduce(...)` is byte-identical to bun.
**Prototype-chain landed (eeb9043):** functions get a lazily-created `.prototype` object
(`funcProtos`, a GC root); `new F()` links the instance's `proto`; `getMember` walks own-props →
prototype chain (own props shadow). Shared methods, `this`-chaining through prototype methods,
`instanceof`, and shared function identity (`a.m === b.m`) all byte-identical to bun — the ES5
class pattern works. This was the last core *language* gap.
**Math landed (231fbbe):** `floor`/`ceil`/`round`/`trunc`/`abs`/`sign`/`min`/`max` in **pure Milo**
(byte-identical to bun — no FFI), `sqrt`/`pow` via the hardware/libc extern (IEEE
correctly-rounded), `random` via a pure-Milo xorshift64 PRNG, plus `PI`/`E`. `Math` is a global
object with native-fn methods.
**Regex landed (4481b3f):** a pure-Milo backtracking engine in `regex.milo` (pattern → node tree
→ bytecode → recursive backtracking VM). Char classes/ranges/negation, `\d\w\s`, quantifiers
`*+?{n,m}` greedy+lazy, groups/`(?:)`, alternation, anchors `^$`, `\b\B`, flags `i/g/m`.
`new RegExp` + `re.test`/`re.exec` + `str.replace(re,$1)`/`str.match`. Byte-identical to bun (incl.
`$3/$2/$1` date reformat). No C dependency. Represented as an `Obj` with a hidden `regexId`.
Deferred: `/.../ ` literal lexing, `str.split(regex)`, backreferences, lookaround, named groups.

**Parser: arrows + let/const multi-declarator (b73b4b6), template literals + spread (this fire)** —
all byte-identical to bun. The QuickJS corpus should now parse on most files.

**Two-binary split (4be585e): `milojs-engine` (the engine) + `milojs` (the runtime).** Runtime has
process/global; ran the tahoeroads express bundle → it's a CommonJS module (`require` ×15,
`Object.defineProperty`, express/compression/trpc/prisma...). Booting it is the whole Stage-5
runtime: **module loader (`require`) is the critical next build**, then `Object.defineProperty`,
fs/http shims, and every npm package express pulls in (minibun spent many sessions on 20/21
packages — same surface). Minor parser gaps left: comma operator, `void`/`delete`, `in`, bitwise.
**Still open (runtime):** **Promises + async event model** (the big one, ties to the green
scheduler), `switch`, `for...in`/`for...of`, bitwise ops in JS, real `===`. These + minibun's node
shims are the Stage-5 path to booting minibun on the engine.
**Gate:** prototype-based method dispatch + a class-ish pattern (constructor + prototype methods).

**Test yardstick (decided):** milojs *is* the engine, so unlike minibun's JSC, both test262 and
QuickJS's own `~/git/quickjs/tests/` grade milojs directly. QuickJS's suite is the near-term
target (local, pure-JS, self-contained `assert()`), but its `test_language.js` needs
`try`/`catch`/`throw`, `typeof`, `for`, `instanceof` — so those features gate suite adoption.
Until then: byte-identical-vs-bun differential smokes in `tests/`. Package test suites don't
apply (they need the node runtime = minibun's layer, not the engine).

### Stage 4 — bytecode VM ⬜
Compile the AST to a register or stack bytecode; retire the tree-walker. Needed for speed and
for a sane implementation of exceptions (`try`/`catch`/`throw` as unwinding), generators, and
`for`/`switch`. Keep the tree-walker as an oracle to differential-test the VM against.
**Gate:** every Stage 1–3 demo produces identical output on the VM; exceptions work.

### Stage 5 — host compatibility: the builtins real packages reach for ⬜
Complete the standard library and Node surface that npm packages actually touch. Server HTTP and
async `fetch` work; client `http.request`/`http.get`, TLS serving, child processes, generators,
class fields/getters, and computed `require` do not. We own the microtask queue outright, so
there is no API-boundary drain to work around.
**Gate:** a real Express/tRPC application serves its routes under `milojs` end to end. `RegExp`
and `Date` are the long poles — spec-correctness diverges from "expressible" there.

### Stage 6 — test262 conformance, measured and growing ⬜  ← a first-class goal, not just an app-subset
**Why this is a real goal, not a footnote:** an engine that only runs "the subset our apps need"
is a private tool nobody else can trust. What makes milojs usable *as* an embeddable engine
(the QuickJS-alternative pitch) is a **published, honest conformance number that goes up over
time**. So test262 is the standing metric, not a one-time lock.

Concretely:
- **Harness:** vendor a pinned test262 checkout; a milojs runner that parses each test's YAML
  frontmatter (`includes`, `flags: [onlyStrict|noStrict|module|raw|async]`, `negative`,
  `features`), prepends `harness/sta.js`+`assert.js`, runs strict & sloppy, and honors negative
  (parse vs runtime) + async (`$DONE`) tests. This is the QuickJS `run-test262` contract.
- **Metric:** report `pass / total` per top-level area (`language/`, `built-ins/`,
  `intl402/`, `annexB/`) every run, checked into a `test262-status.md` so the trend is visible.
  Exclude nothing silently — an excluded/failing test is logged with the reason.
- **Grow-and-lock:** probe → fix → lock (the JSON/base64 pattern), but the locked set is a
  *ratchet on the whole suite* — the number only moves up, regressions fail CI.
- **Honesty:** full ES2020 is a decade (QuickJS too — one person's life's work). We do **not**
  claim conformance we don't have; we publish exactly where we are and grow it. `RegExp`, `Date`,
  and Number formatting are the big "expressible ≠ spec-correct" cliffs — expect the number to
  stall there and log precisely which sub-areas are unimplemented.

Target ladder (illustrative, to be set from the first real run): host compatibility (Stage 5)
needs only a slice; a *credible public engine* wants `language/` + core `built-ins/` in the high
90s%. Measure first (see below — the QuickJS `tests/` microtests are the cheap pre-test262
smoke), then set the ladder.

## Critical path & honesty

Stage 1 → 2 → 3 → 4 → 5 → 6, mostly linear (2 and 3 are the hard middle; 4 can overlap 5 once
the value model is frozen). **Where it genuinely stalls:** the GC (Stage 2) and `RegExp` +
`Date` + Number formatting edge cases (Stage 5) — big surface where "expressible" and
"spec-correct" diverge. Everything else is mechanical parsing/dispatch.

**This is a from-scratch engine, not a binding effort.** That makes it larger, but it is also
what makes it ours: no C++ engine underneath, nothing to swap out. Each stage is independently
demoable: Stage 1 runs closures; Stage 3 runs OO JS; Stage 5 runs real npm packages.

## Embedding — how others FFI in (the "like bun/QuickJS" surface)
Milo exposes a **stable C ABI**: top-level `fn`s use the C calling convention, and
`milo build-lib libmilojs.milo -o libmilojs.a` emits the archive **+ a companion `libmilojs.h`**.
The public embedding API is opaque-pointer + scalar (`MiloJSContext*`, handle-based values) —
exactly QuickJS's `JSContext*`/`JSValue` shape, and exactly what minibun already does when it
hands Milo function pointers to JSC as C callbacks. So milojs is embeddable from C/C++/Rust
(cgo/ctypes too) the day its API is C-spellable. (Caveat: define-side struct-by-value *return*
is not yet lowered — irrelevant, an engine API is opaque pointers anyway.)

## Open questions
- Value representation: tagged Milo enum (clean, a word of tag overhead) vs NaN-boxed f64
  (QuickJS-style, denser, unsafe bit-twiddling). Lean: **tagged enum through Stage 4**, revisit
  boxing only if the VM benchmarks demand it.
- GC: mark-sweep (simple, stop-the-world) vs ref-count-with-cycle-collector (QuickJS's choice,
  incremental but complex). Lean: **mark-sweep first** — correctness before pause times.
- Keep the tree-walker permanently as a differential oracle, or delete it after Stage 4? (lean:
  keep — it is the cheapest VM correctness check we will ever have.)
- Keep the Node-compat shims as pure JS (`lib/*.js`), or rewrite the hot ones as Milo builtins
  for speed? (lean: JS first, profile, promote later.)
