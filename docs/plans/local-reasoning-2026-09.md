<!-- doc-meta
system: local-reasoning-plan
purpose: close the two places Milo still hides state at a distance (implicit &mut at call sites, flat std namespace) and say on the landing page what the language is and is not
key-files: src/checker.ts, src/parser.ts, src-milo/parser.milo, src/mangle.ts, src/resolver.ts, README.md, docs/site/index.md
update-when: a track ships, the &mut call-site rule changes, or the std namespace decision changes
last-verified: 2026-09-20
-->

# Local reasoning: the two exceptions, and saying so out loud

Milo's design property is local reasoning: the function you are reading is the whole
story of the values it touches. The 2026-09-20 corpus census (290k lines, see
[second-class-refs-followups-2026-09.md](second-class-refs-followups-2026-09.md) WP7)
found that property holds everywhere except two places the language chose less
verbosity over visibility, and both are where the corpus complains:

1. **Implicit `&mut` at call sites.** `f(x)` mutates `x` or does not, depending on a
   signature the reader is not looking at. `docs/design.md:118` argues the marker is
   ceremony because the borrow cannot escape; that is true for soundness and false for
   reading. Mutation is the one effect a reader cannot recover from the call site.
2. **Flat std namespace.** Six pairs of std modules still cannot be imported together
   (backlog Tier 1 #11 leftovers), and a colliding private name shows up mangled in
   diagnostics and DWARF (backlog Tier 2 #18 LEFT). User modules are per-module since
   stage 1 (2026-08-15); std is not.

Plus a third, cheap item: README and landing page do not say what the language is
(local reasoning, machine-checkable, verbose on purpose) or is not (functional, GC'd,
first-class references). People landing on the page decide in a paragraph.

## Track A: explicit `&mut` at non-receiver call sites

Rule: an argument to a `&mut T` parameter is written `&mut x` (or `&mut a.b`,
`&mut v[i..j]`). Method receivers stay implicit: `v.push(1)` is unchanged, as in Rust.
Shared borrows stay implicit: `&x` remains not an expression. Reads cannot change
anything the reader cares about; mutation can. Half the syntax, all of the visibility.

Measured surface: 183 `&mut` params in std signatures, 62 of them not `self`. Call
sites are not countable by grep; step A1 counts them with the checker.

- **A1. Count.** Add a hidden `milo check --count-implicit-mut` (or a `scripts/`
  one-off using `check --json`) that reports every non-receiver argument bound to a
  `&mut` param, per file. Run over std, examples, src-milo, fixtures, and the 12
  siblings. Record the number here before anything else.
- **A1 measurement (2026-09-20).** `bun scripts/count-implicit-mut.ts` (drives
  `milo check --count-implicit-mut` over every file as its own entry, deduplicated by
  file:line:col, attributed by path). Bare arguments bound to a `&mut` parameter:

  | root | sites |
  |---|---|
  | std | 272 |
  | examples | 3535 |
  | src-milo | 6470 |
  | tests/fixtures | 242 |
  | sibling/milojs | 4702 |
  | sibling/emulators | 4338 |
  | sibling/milo-gl | 55 |
  | sibling/markdown | 51 |
  | sibling/dapweb | 30 |
  | sibling/redis | 17 |
  | sibling/toml | 11 |
  | sibling/yaml | 9 |
  | sibling/postgres | 4 |
  | sibling/aws, milo-json-rpc, milo-sdl | 0 |
  | package cache (milo-gl v0.2.0 via milo-sdl) | 28 |
  | **total** | **19764** |

  15 entries did not resolve standalone and are not counted: the linux/windows arms of
  `std/platform` and `std/event` on a darwin host, `dapweb/src/{sessions,start,api/main}`
  (import `usleep`/`getpid` from `std/os`, not exported), `milo-json-rpc/tests/*`
  (package layout), `milojs/src/engine/methods.milo`, `postgres/*` (`hexEncode` defined
  twice). Every site was routed through the call-site helper: zero fell to the
  `setAutoBorrowChecked` cross-check.
- **A2. Parser + checker accept `&mut expr` in argument position** (`src/parser.ts`
  UnaryOp path; `src/checker.ts` line ~7995 currently rejects `&x` with "borrows are
  implicit"). `&mut x` where the param is not `&mut` is an error naming the param
  type. `&mut` on a receiver is an error ("receivers auto-borrow"). `&x` stays an
  error, message updated to say why `&mut` is different.
- **A3. Warning `implicit-mut-borrow`** on a bare argument bound to a `&mut` param,
  allowed by default (so nothing breaks), with `--deny=implicit-mut-borrow` to test.
  Hint prints the fixed call.
- **A4. Fixer.** `milo fmt --explicit-mut` rewrites the file from the checker's
  resolved signatures (not a regex). Idempotent. Gate: run twice, second run is a
  no-op; run over fixtures and every `@expect` still passes.
- **A5. Self-host.** `src-milo/parser.milo` learns `&mut expr` in arg position, and
  `src-milo/checker` accepts it. Rebuild, `sh scripts/selfhost.sh`,
  `selfhost-fixpoint.sh`. Only after the frozen `milo-self` parses the new form may
  std be migrated (backlog #22 constraint; the `TaggedArena.with` incident on
  2026-09-20 is what happens otherwise).
- **A6. Migrate** std, src-milo, examples, fixtures, error fixtures (`@error:` text
  that quotes a call may change), then siblings via `check-packages.sh` and milojs
  `check-apps.sh`. Commit per repo.
- **A7. Flip** the warning to an error by default. Update `docs/design.md:118` (the
  argument against the marker was about soundness; keep it, add the reading argument),
  `language-reference.md`, `ownership-model.md`, `docs/site/language/ownership.md`,
  the LSP inlay hint (now unnecessary for `&mut`; keep for `&`), `docs/errors.md`.
- Done: `implicit-mut-borrow` is an error, every repo green on its own gates, the
  count from A1 is zero, `docs/breaking-changes.md` has the entry.

Gates that cannot be gamed: A1's count before and after (must reach 0); the fixer's
idempotence run; `run-examples.ts`; the selfhost fixpoint.

Risks: LLM-generated Milo in the wild (every prior blog example, every model that
learned the old form) breaks. Mitigation is A4: one command fixes a file, and the
error's hint says so. Do not keep a compatibility flag; the census rules say a young
repo ships no back-compat.

## Track B: finish per-module namespaces

**SHIPPED 2026-09-20** (B1, B2, B3): see [module-namespaces.md](module-namespaces.md)
"Stage 3 and stage 4". Numbers: `MILO_MANGLE_ALL=1` took the error lane from 59 red to
0; IR grows by names only (rg +0.16%, same define count) except where byte-identical
helpers stop merging (gz +1.1%, four extra defines from deflate/inflate).

- **B1. Display names.** Branch `display-names` (`0254df73`, 2026-08-18, 365 commits
  behind main, 16 files, +494) made a mangled name a symbol only: diagnostics, `print`,
  DWARF, LSP, reports all render the written name. Rebase is unlikely to apply; use the
  diff as the spec and reimplement on main. Gate: the 24 fixture failures that stage 1
  hit when mangling everything (backlog #18) must pass with mangling forced on for
  every private name (`MILO_MANGLE_ALL=1` or similar test-only switch).
- **B2. std private helpers per module** (stage 4 of
  [module-namespaces.md](module-namespaces.md), scoped down). Only private names.
  `pub` std names stay flat: `milo api`, `milo doc`, `breaking-changes.md` depend on
  it and the flat pub surface is a feature, not the bug. After B1 the mangled form
  is invisible, so the pass can rename every std private helper, not only colliding
  ones. Then delete the `_xxRotl`/`_sha1Rotl` style manual prefixes from backlog #11
  (rename back to `rotl`) and drop the "module-prefixed private helpers" rule from
  `docs/stdlib-design.md`.
- **B3. Gate:** `tests/modules.test.ts` "historically colliding helpers import
  together" grows to every pair of std modules (103 modules, one program importing
  all of them, or a generated N-choose-2 sweep if one program is too slow to check).
  Selfhost: `src-milo/resolver.milo` must apply the same mangling or the self-built
  compiler rejects std; run the fixpoint.
- Done: any two std modules import together; no `_module` prefix convention needed;
  a private name never appears mangled to a user.

## Track C: README and landing page say what it is and is not

Text to land in `README.md` (after the one-line pitch) and `docs/site/index.md`
(a short section under the intro links; link to `/ai-coding#local-reasoning` and
`/language/why-no-lifetimes`):

**What Milo is.** A systems language built for local reasoning: the function you
are reading is the whole story of the values it touches. Second-class references
(no stored borrows, so no lifetimes), single ownership, mutation only through a
`&mut` parameter that cannot outlive the call, and every effect declared where it
happens (`@unsafe`, `@thread`, `@parks`, `@mustUse`). Verbose on purpose: an extra
`clone()` or `let _ =` where you are already looking is cheaper than state you
have to look up. That is what makes it reviewable by a person and generatable by a
model in one pass.

**What Milo is not.** Not functional: `var`, `for`, and in-place mutation are the
idiom; it gets FP's "nothing else can change this" by scoping mutation, not by
banning it. Not garbage collected, not reference counted. Not Rust: no lifetimes,
no stored references, no `Send`/`Sync`; the price is that a view cannot be
returned or kept, and you copy or use an arena handle instead. Not a scripting
language: it compiles through LLVM to a static binary.

**Measured, not claimed.** Over 250k lines of Milo exist across the compiler
(self-hosted), a JS engine, three emulator cores, a debugger and a dozen packages.
Nearly every `unsafe` block in them is the C boundary, and not one exists because the
ownership model rejected a program ([the census](/language/vs-rust)).

Done: both pages carry the three paragraphs, `bun test tests/docs.test.ts` and
`docLinks.test.ts` green, `docs/site` builds.

## Sequencing

C first (an hour, no code). Then A and B in parallel worktrees: A touches parser,
checker (UnaryOp and call-arg coercion), fmt; B touches resolver, mangle, lsp,
diagnostics. Shared files are `src/checker.ts` (different regions) and
`src-milo/`; merge A5 before B3's selfhost step. A is the bigger migration and the
bigger visible change; if only one can run, A.

## Decisions (2026-09-20)

1. Receivers stay implicit: `v.push(1)` unchanged; `&mut` only on non-receiver
   arguments.
2. `&x` stays an error. One spelling per construct.
3. B2 renames the `_xx`/`_sha1` prefixed helpers back once the compiler scopes them.
4. Landing page keeps the claim in words plus rough numbers ("over 250k lines",
   "zero unsafe blocks exist because the ownership model rejected a program"); no
   percentages or exact counts that age.
