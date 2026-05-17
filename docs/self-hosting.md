# Self-Hosting Roadmap

Milo's compiler is written in TypeScript (~12K lines). The goal: rewrite it in Milo so the compiler compiles itself. This is the single strongest proof that a systems language works.

Current state: `milo0` (in `self-hosting/`) is a subset compiler written in Milo. It handles primitives, functions, structs, enums+match, Box, strings, closures, and string methods. It compiles real programs (fib, fizzbuzz, hello) end-to-end through LLVM IR → clang → native binary.

## Strategy

**Not** a line-for-line port. The TS compiler uses patterns (Maps, closures, dynamic objects) that translate awkwardly. Instead: rewrite each module in idiomatic Milo, using the TS version as a spec. Test-driven — the existing 241 fixture tests define correctness.

Two parallel tracks:
1. **Finish milo0's language coverage** — unblock self-hosting by teaching milo0 the constructs its own source uses (Vec, imports, etc.)
2. **Port modules bottom-up** — each module becomes a `.milo` file, tested independently, then integrated

## Stages

### Stage A — Unblock Vec<T> in milo0
*Biggest remaining blocker. 84 Vec use sites in milo0 source.*

- [ ] A1: Vec<T> codegen in milo0 — struct layout `{ ptr, len, cap }`, push, pop, len, index
- [ ] A2: Vec<T> drop glue in milo0 — free backing storage on scope exit
- [ ] A3: String.push(u8) in milo0 — realloc path
- [ ] A4: Migrate milo0 internals from string-table hacks to Vec<T>
- [ ] A5: milo0 compiles itself (milo0 → milo0' → same IR for test inputs)

**Acceptance**: `milo0` source compiled by `milo0` itself produces a working `milo0'` binary that passes the same test inputs as the original.

### Stage B — Imports & Multi-File
*The TS compiler is 11 files. milo0 is currently single-file stdin→stdout.*

- [ ] B1: `import` statement in milo0's parser + resolver
- [ ] B2: File I/O in milo0 — read source from path instead of stdin
- [ ] B3: CLI arg parsing — `milo1 build foo.milo -o foo`
- [ ] B4: Multi-file compilation — resolve imports, merge ASTs, single IR output

**Acceptance**: `milo1 build examples/hello.milo -o hello && ./hello` works, including programs that `import "std/..."`.

### Stage C — Port Lexer + Parser
*TS lexer: 266 lines. TS parser: 952 lines. Well-contained, few dependencies.*

- [ ] C1: Port `tokens.ts` → `src-milo/tokens.milo` — token enum, keyword table
- [ ] C2: Port `lexer.ts` → `src-milo/lexer.milo` — full tokenizer with trivia
- [ ] C3: Port `ast.ts` → `src-milo/ast.milo` — AST node types as enums
- [ ] C4: Port `parser.ts` → `src-milo/parser.milo` — recursive descent, all syntax
- [ ] C5: Fuzz test — lex+parse every `.milo` file in `tests/fixtures/` and `examples/`, compare AST structure against TS output

**Acceptance**: Milo lexer+parser produce structurally identical ASTs to the TS versions for all test fixtures.

### Stage D — Port Type Checker
*TS checker: 2946 lines. Hardest module — lots of Maps, complex state.*

- [ ] D1: Port `types.ts` → `src-milo/types.milo` — TypeKind enum
- [ ] D2: Port scope/symbol infrastructure — variable info, function signatures, enum/struct registries
- [ ] D3: Port expression type checking — literals, binary ops, calls, field access, method calls
- [ ] D4: Port statement checking — let/var, if, while, for, match, return
- [ ] D5: Port move checker — ownership tracking, use-after-move detection
- [ ] D6: Port generics — monomorphization, type inference
- [ ] D7: Port trait checking — impl resolution, derive macros
- [ ] D8: `diagnostics.ts` → `src-milo/diagnostics.milo` — error formatting

**Acceptance**: `milo-self check tests/fixtures/*.milo` produces identical diagnostics to the TS checker for all pass and fail cases.

### Stage E — Port HIR + Lowering + Codegen
*TS lower: 629 lines. TS codegen: 5006 lines. Codegen is the largest module.*

- [ ] E1: Port `hir.ts` → `src-milo/hir.milo` — typed IR node types
- [ ] E2: Port `lower.ts` → `src-milo/lower.milo` — AST+CheckResult → HIR
- [ ] E3: Port codegen core — function prologue/epilogue, basic blocks, terminators
- [ ] E4: Port codegen expressions — arithmetic, comparisons, calls, string ops
- [ ] E5: Port codegen statements — let/var, if, while, for, match, return
- [ ] E6: Port codegen types — structs, enums, generics, Vec, HashMap, Box
- [ ] E7: Port codegen builtins — print, format, assert, max/min, etc.
- [ ] E8: Port codegen drop glue — scope-exit cleanup, nested drops

**Acceptance**: `milo-self emit-ir` produces semantically equivalent IR (not necessarily identical — register names may differ). Verified by compiling + running all test fixtures and comparing stdout.

### Stage F — Integration + Bootstrap
*Wire it all together. ~290 lines of CLI + 211 lines of resolver.*

- [ ] F1: Port `resolver.ts` → `src-milo/resolver.milo` — import resolution, platform split
- [ ] F2: Port `target.ts` → `src-milo/target.milo` — host detection, triple
- [ ] F3: Port `main.ts` → `src-milo/main.milo` — CLI driver (build, run, emit-ir, fmt, test, lsp)
- [ ] F4: Full test suite — `milo-self test` passes all 241 fixtures
- [ ] F5: **Bootstrap**: `milo-self build src-milo/ -o milo-self2` produces a working compiler
- [ ] F6: **Triple bootstrap**: milo-self2 compiles itself → milo-self3, output is bit-identical to milo-self2

**Acceptance**: Three-stage bootstrap converges. `milo-self3` binary is identical to `milo-self2`. The compiler compiles itself.

### Stage G — Retire TypeScript Compiler
*Optional. Only after full confidence in self-hosted compiler.*

- [ ] G1: CI runs both TS and Milo compilers, diffs outputs
- [ ] G2: Port LSP to Milo (or keep as TS shim that invokes `milo-self lsp`)
- [ ] G3: Port formatter to Milo (partially done — `milo-fmt` already exists in Milo)
- [ ] G4: Update build instructions — `bun` no longer required
- [ ] G5: Archive `src/*.ts` to `src-legacy/`

## Philosophy: Pivot Early, Don't Get Bogged Down

Self-hosting is a credibility milestone, not the product. The TS→LLVM pipeline works and ships real programs. If any stage takes more than ~2 weeks of active work without clear forward progress, **stop and reassess**. Options:

1. **Skip the blocker** — mark it as deferred, move to the next stage that's unblocked
2. **Simplify scope** — e.g. self-host just the lexer+parser (proves the point without the hardest modules)
3. **Pivot entirely** — keep TS compiler, invest the time in language features or ecosystem instead

The worst outcome is months stuck on compiler plumbing while the language stagnates. Each stage below is designed to be independently valuable — a self-hosted lexer+parser is worth shipping even if codegen stays in TS.

## Escape Hatches

Things that might force a detour. If we hit one, we adapt the plan rather than stall.

| Blocker | Workaround |
|---------|------------|
| HashMap too complex for milo0 | Use sorted Vec<Pair<K,V>> with binary search. 2 use sites in milo0, removable. |
| Recursive AST types need Box everywhere | Already have Box<T>. If ergonomics hurt, add `indirect` enum variant sugar. |
| String manipulation too verbose without iterators | Use `.each()` callback pattern or byte-index loops. Port iterators as a stretch goal. |
| Drop semantics edge cases crash milo0 | Isolate the pattern (extract to helper fn). Documented workaround from Stage-0. |
| Codegen too large for single file | Split into codegen_expr.milo, codegen_stmt.milo, codegen_type.milo. Imports handle it. |
| Performance — self-hosted compiler too slow | Acceptable for bootstrap. Optimize after correctness. Profile with `time` and focus on hot paths. |

## Size Estimates

| Module | TS Lines | Est. Milo Lines | Notes |
|--------|----------|-----------------|-------|
| tokens + lexer | 383 | ~400 | Near 1:1, string-heavy |
| ast + types | 292 | ~350 | Enum-heavy, straightforward |
| parser | 952 | ~1000 | Recursive descent translates cleanly |
| checker | 2946 | ~3200 | Biggest module, most HashMap usage |
| hir + lower | 748 | ~800 | Mechanical translation |
| codegen | 5006 | ~5500 | Largest, but repetitive patterns |
| resolver + target + main | 525 | ~550 | Mostly plumbing |
| diagnostics | 63 | ~80 | Small |
| **Total** | **~10.9K** | **~11.9K** | ~1.1x TS size |

## Progress Tracking

Started: 2026-05-16
Current stage: **D** (Type Checker — expr + stmt done, generics + traits remaining)

| Stage | Status | Date Started | Date Done |
|-------|--------|-------------|-----------|
| A — Vec in milo0 | skipped (pivoted to bottom-up port) | | |
| B — Imports + multi-file | skipped (pivoted to bottom-up port) | | |
| C — Lexer + Parser | done | 2026-05-16 | 2026-05-16 |
| D — Type Checker | in progress | 2026-05-16 | |
| E — HIR + Codegen | in progress (partial) | 2026-05-16 | |
| F — Bootstrap | not started | | |
| G — Retire TS | not started | | |

### Module line counts (src-milo/)
- tokens.milo: 206
- lexer.milo: 475
- ast.milo: 211
- parser.milo: 1130
- resolver.milo: 237
- checker/ (4 files): 2055
- codegen/ (5 files): 1416
- **Total: 5730**
