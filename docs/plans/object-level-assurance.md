<!-- doc-meta
system: object-level-assurance
purpose: plan for evidence that the compiled binary keeps the source's safety guarantees: pinned pipeline, object checks, traceability, coverage, translation validation
key-files: src/pinned-build.ts, src/object-checks.ts, src/safety.ts, tests/safety-binary.test.ts
update-when: a step below ships or a dependency moves
last-verified: 2026-11-04 (steps 1 and 3 built)
-->

# Object-level assurance: evidence that the binary keeps the source's guarantees

Status: proposed 2026-11-03. Grows phase 5 of core-hir.md.

## Problem

Milo's safety claims are source-level: profiles checked on the AST (`src/safety.ts`),
proofs over source contracts (`milo prove`), memory safety from the checker plus the checks
the compiler inserts. Nothing shows the object code keeps them. The milo dialect lowering,
milo-opt's passes and LLVM -O2 are unverified; a miscompile in drop elaboration voids the
memory-safety claim silently. Goldens, ASan and fuzzers are testing, not evidence a
certification authority accepts.

Competition with a story already: SPARK/Ada (GNATprove, qualified GNAT Pro), Rust with
Ferrocene (qualified compiler, ISO 26262 / IEC 61508). Milo's pitch, SPARK-level proofs with
less ceremony, needs this track to be credible.

## Steps, cheapest first

1. **Pinned pipeline per profile. DONE 2026-11-04** (src/pinned-build.ts). A profile fixes opt level, the milo-opt pass list, no
   LTO, the LLVM and milo-opt versions; the build records them in the binary (a note
   section) and `milo verify --profile` refuses a mismatch. Gate: a build with any other
   pass list is rejected.

   How: `milo build --safety=<p>` fixes -O2, the `MLIR_PIPELINE` text of src/mlir-backend.ts,
   no LTO, one codegen unit and the LLVM major (23), and refuses any flag that moves them
   (`--release`, `--debug`, `-g` which adds a pass, `--sanitize`, `--hot`,
   `--no-overflow-checks`, `--cgus=N`). The record (profile, opt, the full pipeline text,
   LTO, codegen units, LLVM version line, sha256 of the milo-opt binary, triple) goes into
   the binary as a constant global `__milo_pin`, not a note section: Mach-O has no notes
   and `.note` needs a directive per format, while a named constant (section
   `.rodata.milo_pin` on ELF, `__TEXT,__milo_pin` on Mach-O, kept by `llvm.used` through
   `--gc-sections`) is one IR line on every target. `milo verify --profile <p> <binary>`
   finds the record by its magic bytes and refuses a missing record, another profile, or any
   field that differs from the pin. Gate: tests/safety-binary.test.ts (a binary with one pass
   name changed is refused). Not pinned yet: the milo-opt hash is recorded, not compared
   (there is no registry of qualified hashes), and an attacker who rewrites the record in the
   binary defeats it; this is evidence for an honest build, not tamper-proofing.
2. **Traceability report** (DO-178C 6.4.4.2b source-to-object). Every compiler-generated
   construct (drop, bounds check, overflow trap, runtime call, clone) is a numbered
   `MILO-O-`/`MILO-B-` rule with tests, carried as an MLIR location tag through every pass
   into DWARF. Report per function: object range -> op -> source line, plus the list of
   generated constructs by rule. Needs DWARF from MLIR locations (a parity gap today).
   Gate: every generated instruction range in a fixture maps to a source line or a rule;
   an unmapped range fails.
3. **Profile checks on the output. DONE 2026-11-04** (src/object-checks.ts). `noDynamicAllocation` -> no malloc/free symbol;
   `noRecursion` -> acyclic call graph of the object; an allowlist of runtime symbols.
   Run on the final object, not the source. Gate: planted violation per check.

   How: llvm-nm (defined and undefined symbols) and `llvm-objdump -d` (direct calls and
   jumps between symbols; Mach-O stubs resolved through `--indirect-symbols`) of milo-opt's
   LLVM, on the linked image. Allocation: shortest path from `main`/`Reset_Handler` to
   malloc/calloc/realloc/free/mmap/..., each path labelled program or runtime. Recursion:
   Tarjan SCCs over the whole image's graph. Indirect calls (`blr`, `blx rN`, `call *`) have
   no target: reported, and a failure at DAL A / ASIL D / SIL 4 / NASA A. Allowlist: freestanding
   core plus compiler helpers for no-allocation profiles, widened to the hosted libc for the
   others; it covers undefined imports and the libc shims a static image defines
   (tools/cortex-m/startup.c). `milo build --safety` runs them and deletes a failing binary;
   `milo verify` runs them on any binary. Gate: tests/safety-binary.test.ts. Object, not IR,
   because the checks must see what clang and the linker did, including shims the linker adds.
   Limits: indirect tail jumps are not edges; a dynamic binary's libc is opaque.

   Finding: the hosted runtime cannot meet do178c-a (see
   docs/site/language/safety-profiles.md): every hosted binary reaches malloc/free/mmap
   through the replay heap, string and Vec growth, the scheduler and the panic path, has
   call cycles in the panic and lazy-init machinery, and hundreds of indirect calls. The
   bare-metal image (bump allocator, no scheduler) is the one that passes.
4. **Object-level structural coverage.** MC/DC on the binary for Level A code that does
   not trace to source (generated drops and checks). Instrument at the LLVM level after the
   pinned pipeline; report per rule.
5. **Translation validation.** Per function, check the lowered result against the
   reference interpreter's semantics (core-hir.md phase 3) on generated inputs, and run
   Alive2 on the LLVM passes of the pinned pipeline. The realistic substitute for a
   verified compiler (CompCert); it validates each compilation, not the compiler.
6. **Tool qualification** (DO-330 TQL-1 / ISO 26262 TCL3). Years; only with a customer.

## Dependencies

- Interpreter oracle (core-hir.md phase 3) before step 5.
- DWARF from MLIR locations before step 2.
- Core HIR (ownership explicit) makes step 2's rule tagging one place instead of many.

## Open questions

1. Which standard first: DO-178C (avionics, the user's background) or ISO 26262 (larger
   market, Ferrocene's ground)?
2. Critical subset for Level A: is `do178c-a` enough, or does it also ban heap closures and
   string ops?
