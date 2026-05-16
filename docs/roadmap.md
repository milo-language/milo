# Milo Roadmap

## Phase 1 — Minimal Viable Language ✅

- [x] Primitive types, let, var, arithmetic, comparisons
- [x] Functions with return values
- [x] while loops, if/else
- [x] String literals, extern fn for FFI to C
- [x] Structs (value types, move semantics)
- [x] Arrays with bounds checking
- [x] Second-class references (&T, &mut T in function params only)
- [x] Move checking (use-after-move = compile error)
- [x] Type checker pass (between parser and codegen)

Milestone: FizzBuzz, Fibonacci, simple file I/O via FFI ✅

## Phase 2 — Real Programs ✅

Done:
- [x] Enums / sum types (tagged unions, LLVM `{i32, [N x i64]}`)
- [x] Pattern matching (match + exhaustiveness checking)
- [x] Generics — enums (monomorphization)
- [x] Generics — functions (monomorphization, type inference from args)
- [x] Built-in functions (print, exit)
- [x] Option<T>, Result<T,E> — definable, no convenience methods yet
- [x] Unsigned integer types (u8/u16/u32/u64, udiv/urem/ult)
- [x] Literal type hint propagation (return, struct fields, fn args, assignment)
- [x] Source spans on all AST nodes; line:col in all errors
- [x] Elm-style error messages (source context, carets, hints)
- [x] Parser/lexer throw instead of process.exit
- [x] UUID tmp filenames

Remaining (priority order):
- [x] **P0: String type** — owned UTF-8 `{ ptr, len, cap }`, ops: len, concat (+), eq (==, !=), byte index, auto-coercion to `*u8` for FFI
- [x] **P1: Imports / modules** — `import "path.milo"`, recursive resolution, dedup, transitive
- [x] **P2: Generics — structs** — monomorphization, type inference from field values
- [x] **P3: Option/Result ergonomics** — `!` (unwrap with panic + span), `?` (propagate), `??` (default value)
- [x] **P4: Logical operators** — `&&` / `||` with short-circuit evaluation
- [x] **P5: break / continue** — loop control flow
- [x] **P6: Char literals** — `'x'`, i8 representation
- [x] **P7: Type casts** — `expr as Type`, checked in sema
- [x] **P8: Integer literal coercion** — auto-coerce int literals in binary ops and generic type inference
- [x] **P9: if-let** — `if let Some(n) = opt { ... }` with optional else branch
- [x] Array utilities — Vec<T> with push/pop/len/map/filter/each/find/any/all, bounds-checked indexing

Milestone: JSON parser ✅, simple HTTP server, a toy compiler

## Phase 2.5 — Developer Experience

- [x] LSP server (milod) — diagnostics, hover, go-to-definition, completions
- [x] VS Code extension — syntax highlighting + LSP client
- [x] GitHub Actions CI — build + test on push/PR, release pipeline with standalone binaries
- [ ] LSP: rename, find references
- [ ] REPL / playground

## Phase 2.7 — Iteration & Zero-Copy Ergonomics

Goal: close the gap with Rust's expressiveness without introducing lifetimes. After studying real Rust codebases (ripgrep, deno), ~70% of lifetime usage is zero-copy views into data. Milo's second-class refs handle the rest.

### What we cover (~70% of Rust lifetime patterns)
- [x] `for` loops — ranges, Vec, array, string (by byte), HashMap (key+value)
- [x] `break` / `continue` in for loops
- [x] Vec functional methods — `.map()`, `.filter()`, `.each()`, `.find()`, `.any()`, `.all()`
- [x] `&string` slice locals — extend second-class refs to local variables (can't escape function). Zero-copy `s[0..5]` via `.slice()` (non-owning `%String` with cap=0). `.substr()` still returns owned copy.

### What we don't cover (~30% — and how we could)
- **Structs with borrowed fields** (e.g. `Parser<'a>` holding `&'a str`): would need scoped-lifetime structs. Deferred — most parsers can just own their input.
- **Iterators yielding borrowed data** (e.g. `LineIter<'b>` → `&'b [u8]`): would need iterator trait + borrowed return types. Covered by callback-based internal iteration (`.each()`) and `for` loops for now.
- **Cow<'a, T>** (conditional borrow/own): niche optimization. Just clone when needed.
- **Multi-lifetime generics** (e.g. `Core<'s, M: 's, S>`): deep borrow-checker territory. Not planned — design around it with ownership.

## Phase 3 — Self-Hosting

Done:
- [x] HIR — typed intermediate representation (every expr carries TypeKind)
- [x] Closures — non-escaping, arrow syntax `(x: i32) => x * 2`, by-reference captures, fn type params
- [x] Drop semantics — compiler emits free on scope exit for heap-owned values (String)
- [x] Box\<T\> — single-owner heap pointer, auto-drop, recursive enum drop glue
- [x] Recursive enums via boxed payload (linked list, tree, AST)
- [x] Vec\<T\> — dynamic array with push/pop/len, bounds-checked indexing, drop glue
- [x] HashMap\<K, V\> — open addressing, FNV-1a + seeded hash, insert/get/contains/remove/len, drop glue
- [x] Traits Phase 1 — trait decls, impl blocks, inherent methods, generic bounds, supertraits, @derive(Eq), Self type, monomorphized static dispatch
- [x] String `substr(start, end)`, `parseF64` builtins
- [x] String `push(u8)`, concat, byte index, len, eq
- [x] String slice sugar `s[a..b]` (zero-copy `&string` via `.slice()`; `.substr()` for owned copy)
- [x] Enum equality `==` / `!=` for payload-free variants (codegen compares tag)
- [x] Bitwise operators `& | ^ << >> ~` with C-style precedence
- [x] Hex (`0xFF`) and binary (`0b1010`) integer literals; `_` digit separator
- [x] `.toString()` for integer and float types (via snprintf)

### Phase 3.0 — Stage-0 Bootstrap ✅

Goal: a self-hosted Milo compiler (`milo0`) capable of compiling a useful subset of Milo, written entirely in Milo. Proves the loop end-to-end before tackling the full port.

Subset (Milo-0):
- Primitive numeric types: `i32`, `i64`
- `fn` decls, `extern fn` decls (variadic)
- `let` / `var` with explicit or inferred types
- `return`, `if`/`else`, `while`
- Binary ops: `+`, `-`, `*`, `/`, `%`, `<`, `>`, `<=`, `>=`, `==`, `!=`
- Function calls (incl. recursion + variadic externs)
- Integer + string literals
- Skips: structs, enums, generics, traits, move checking, closures, imports — proven by full TS compiler; bootstrap covers them in later stages.

Design:
- Stage-0 reads source from stdin, writes IR to stdout — sidesteps argv (currently `main` takes no params, and the `MiloType` flat `isPtr` cannot express `**u8`)
- Wrapper script `milo0-wrap.sh` bridges filename → stdin and stdout → clang

Bootstrap pieces (in `self-hosting/`):
- [x] `lexer.milo` — char stream → Vec\<Token\> (40+ token kinds, line comments, keyword table)
- [x] `parser.milo` — tokens → AST (Box-recursive enums for Expr/Stmt; FnDecl/Program/Param structs; full precedence ladder including `||` `&&` cmp add mul unary call primary)
- [x] `codegen.milo` — AST → LLVM IR text (no checker; trust input)
- [x] `main.milo` — stdin → lex → parse → codegen → stdout

Compiler fixes unlocked while building `milo0/`:
- [x] `[T; N]` → `*T` auto-decay for FFI calls (was forcing manual extern signatures with array refs)
- [x] Zero-init droppable allocas at function entry — fixes UB where drop-glue ran over uninitialized branch-local strings/vecs/boxes when the declaring branch wasn't taken
- [x] Emit `unreachable` terminator after if/else when both arms return — LLVM was rejecting empty merge blocks with no terminator
- [x] Match arms tracked as mutually exclusive in the move checker (no more spurious "moved in earlier arm" when both arms return)
- [x] If-without-else with `return` in then-body no longer propagates branch moves past the if
- [x] Match codegen: skip `br label %end` after an arm that already terminated; emit `unreachable` on the merge block if all arms terminated
- [x] Payload-free enums are Copy — `let k1 = k; let k2 = k` works without explicit clones
- [x] `string.clone()` — explicit deep copy so codegen-style code that needs the same string twice has an escape hatch from move semantics
- [x] `Vec<Box<T>>` index no longer double-frees: when the element type is `Box`, the slot is zeroed after load (Box drop is null-safe)

Still blocking full stage-0 self-host:
- [x] Vec index of needs-drop element type now zeros the source slot universally (not just Box). Drop chains stay null-safe.
- [x] Match-binding zeros the source payload field for needs-drop variants, so the subject's later drop doesn't double-free.
- [x] Match codegen uses the source's storage directly (Box deref ptr / Ident alloca) so the binding-zero step actually touches the backing memory.
- [x] Root cause of the `binop(call(), call())` crash: every read of `lv.ty` from a returned `Val { v, ty }` produces a new heap aliased with the previous one; the second read sees freed memory. Workaround in `milo0`: `.clone()` each field access before consuming. Documented as the move-on-field-read limitation.
- [x] Stage-0 milestone passed: `milo0` compiles `examples/fib.milo` end-to-end (Milo source → milo0 → LLVM IR → clang → native binary). Output `fib(10) = 55`. Also handles `(call() + call())` patterns via the trunc-on-return path for fn main.
- [x] Workaround for the while-arm crash: extract body of `Stmt.While` arm into a separate `gen_while` function in milo0/codegen.milo. The extracted function isolates the drop chain, sidestepping the cross-arm aliasing that crashed in Hour-4. Symptom + fix both confirm the bug lives in the interaction between many fn-scope droppable locals and the arm-scope let-bindings; the precise mechanism still uncharacterized but the refactor is a clean dodge.
- [x] Compiler fix Hour-4: re-enabled BoxDeref-subject source-direct match codegen, gated to `match *ident` form. The earlier disabling caused double-frees when arm bindings (e.g. body Vec) AND the source's drop chain both freed the same heap. Source-direct + extractBindings zero-out severs ownership cleanly.

### Stage-0 self-host coverage as of Hour-6

`milo0` (Milo compiler written in Milo) self-compiles and produces correct native binaries for:
- `fn main(): i32 { return N }` and `let x = N; return x`
- Recursive fns: `fib`, `factorial`, `gcd`, `pow`, recursive FizzBuzz
- Multi-call expressions: `add(1,2) + add(3,4)`
- Trunc-on-return when expr type widens fn return (e.g. i64 math returning to `main() -> i32`)
- `while` with `assign` (after the gen_while extraction)
- `if`/`else if`/`else` chains
- `extern fn printf(fmt: *u8, ...): i32` and variadic calls with string-literal first arg
- String-literal `*u8` arguments to externs (`Hello, %s!\n` style)
- `is_prime`-style nested while + if (15 primes under 50, verified)
- Iterative fib via while (matches recursive fib results; fib(30) = 832040)
- Collatz trip length via while
- `break` and `continue` (each extracted to its own helper fn to dodge the arm-scope drop interaction)
- Bitwise `& | ^` on integers; hex literals `0xFF` etc.
- `putchar`, `printf("done\n")` from same program
- Polynomial evaluation (Horner)
- **`examples/fib.milo` unmodified** — milo0 auto-rewrites `print` to printf; `fib(42) = 267914296`
- **`examples/fizzbuzz.milo` unmodified** — milo0 maps `print(s)` to printf(s) + putchar(10)
- **`examples/hello.milo` unmodified** — `extern fn puts(...)` honored

Verification:
- [x] `milo0` compiles `examples/fib.milo` and produces correct runtime output (fib(42) = 267914296)
- [x] `milo0` compiles `examples/fizzbuzz.milo` and produces correct runtime output (1..20 with dots, Fizz, Buzz, FizzBuzz)
- [x] `milo0` compiles `examples/hello.milo` and produces "Hello, Milo!"

### Stage-1 progress — structs

- [x] **Structs end-to-end in milo0**: decl, literal, field access, struct args, struct returns.
  - Struct table stored as one big string (`Name|f1:t1|f2:t2;`) walked manually — dodges Vec/HashMap aliasing.
  - `Point { x: 3, y: 4 }` constructs OK; `p.x` reads OK.
  - `fn dist_sq(a: Point, b: Point): i32` correctly computes 25 for (3,4)→(6,8).
  - Struct-state fib (`struct FibPair { a: i64, b: i64 }`) returns 0,1,1,2,3,5,8,13,21,34,55.
- [x] **Compiler fix: IndexAccess move-tracking.** Checker marks `v[i]` as moved only when the result is consumed (let-bind, return, fn arg, etc.). Codegen zeros the Vec slot on move, leaves it intact on borrow. Unblocks lookup-style code that re-reads the same Vec across calls.
- [x] **Compiler-adjacent: fn-ret table as single-string DB in Cgen.** Same delimited-string trick the struct table uses. Lets struct return types round-trip correctly through the milo0 fn-call codegen.

- [x] **Field assignment** `p.field = expr`. Stmt.Assign generalized to take target expression (Ident or FieldAccess); parser uses parse_expr then checks for `=`; codegen dispatches on target shape. Mutating counter loop works:
  ```
  var c = Counter { value: 0, max: 5 }
  while c.value < c.max { printf("%d\n", c.value); c.value = c.value + 1 }
  // → 0 1 2 3 4
  ```

### Stage-1 progress — enums + match

- [x] **Payload-free enums + match in milo0.** Lexer: enum/match/FatArrow. Parser: enum decl, EnumLit (uppercase `Name.Variant(args)`), match stmt with arms. Codegen: %Name = type { i32 } per enum, EnumLit alloca+tag+load, match emits `switch i32 %tag, label %default [...]` + per-arm body blocks. Enum table stored as `Name!Variant=tag&Variant=tag;` in single Cgen string. Tested:
  ```
  enum Color { Red, Green, Blue }
  fn name(c: Color): i32 {
      match c { Color.Red => {...} Color.Green => {...} Color.Blue => {...} }
  }
  // → Red, Green, Blue
  ```
  Also `enum Op { Add, Sub, Mul, Div }` with arithmetic dispatch (correct).

- [x] **Enum payloads + match binding in milo0.** Single-field payloads (i32/i64/i8/u8/ptr/bool). Layout `%Name = type { i32 tag, payloadTy }`. EnumLit stores tag + optional payload. Match arms extract via GEP, load, alloca binding, push to locs (pop at arm exit). Tested:
  ```
  enum Maybe { Some(i64), None }
  show(Maybe.Some(42))   // → Some(42)
  show(Maybe.None)       // → None
  ```
  And `enum Result { Ok(i64), Err(i32) }` with divide() that returns Err on zero — correct.

- [x] **`as` cast codegen in milo0.** trunc when narrowing, sext/zext when widening (zext if source is u-prefixed), bitcast for same-size. Tested `1234567890123 as i32 = 1912276171` (matches host).
- [x] **Combined struct + enum payload + cast test.** Mini tokenizer that returns `Token.Num(i64)/Plus/Minus` from a char code, with `as i64` widening — produces correct output.

- [x] **Multi-field enum payloads.** Enum layout `{ i32 tag, [SLOTS x i64] payload }` with SLOTS = ceil(max_payload_bytes / 8). Variant-specific access via synthetic `{ t1, t2, ... }` GEP. Tested:
  ```
  enum Shape { Circle(i64), Rect(i32, i32), Point }
  // area: 75, 24, 0
  ```

- [x] **Box<T> in milo0.** Parser: generic suffix `Name<T1,T2,...>` in types. Codegen: `Box<T>` → ptr at LL. `Box(expr)` → `malloc(sizeof(T))` + store + return ptr. Unary `*` deref unwraps `Box<T>` to load inner. Local types stored as raw strings (not LL) so `unwrap_box` can recover inner. Tested:
  ```
  enum Tree { Leaf(i64), Node(Box<Tree>, Box<Tree>) }
  fn sum(t: Tree): i64 {
      match t {
          Tree.Leaf(n) => { return n }
          Tree.Node(l, r) => { return sum(*l) + sum(*r) }
      }
  }
  // tree of 1,2,3,4 → sum = 10
  ```

- [x] **String type in milo0.** `%String = { ptr, i64, i64 }` aggregate. String literals build the aggregate. Variadic externs (printf etc.) auto-extract the data ptr. `.len` via `extractvalue` 1. `+` concat via malloc+memcpy. `==`/`!=` via memcmp + length compare. Tested:
  ```
  let a: string = "hello"
  let b: string = " world"
  let c = a + b              // "hello world"
  c.len                       // 11
  c == "hello world"          // true
  a != b                      // true
  ```

- [x] **MethodCall + string methods.** Parser distinguishes `.field` from `.method(args)`. Codegen dispatches string.clone() (malloc+memcpy), string.len() (extractvalue), i64.toString() / i32.toString() (snprintf two-pass: measure null,0 then alloc+write). Tested: "hello".clone(), 12345.toString() = "12345".
- [x] **References (&T / &mut T) parsed.** Stage-0 strips the reference qualifier — pass-by-value. Loses mutation-through-ref but covers most milo0 patterns where refs only avoid moves. printf coercion gated to known variadic externs so user fns taking %String receive the aggregate.
- [x] **Fixed array types `[T; N]`** parsed into "[T;N]" string encoding.

- [x] **String slice `s[a..b]`** in milo0 — Index/Slice AST + codegen. Tested: `"hello world"[0..5]` → `"hello"`.
- [x] **String index `s[i]`** in milo0 — returns u8. Tested: `"hello world"[1]` → 101.
- [x] **Method call parser**: `.name(args)` distinguished from `.field`.
- [x] **string.clone()**, **i64.toString()**, **i32.toString()** as method calls.
- [x] **Match on `expr.field`** (gen_lvalue extended for FieldAccess).
- [x] **`&T` / `&mut T`** parsed and treated as pass-by-value (covers most milo0 patterns).
- [x] **Fixed array types `[T; N]`** parsed.

Still missing for full milo0-on-milo0:
- [ ] **`Vec<T>`** — 84 use sites in milo0. Biggest blocker.
- [ ] **String.push** — realloc-heavy, plus needs mutation-through-self.
- [ ] **`HashMap<K, V>`** — 2 use sites, removable.
- [ ] **Drop semantics on Box** — currently leaks, fine for small programs.
- [x] **Enum equality (==/!=)** re-enabled. Earlier crash was an internal milo0 abort triggered by some interaction in the let-bound clones; replaced with inline temp-name construction (`"%t" + id.toString()`) and the runtime aborts disappeared. Likely the same heap-alias-on-many-string-locals issue that plagued earlier arm bodies — but here a small refactor sidesteps it.
- [x] Closures — arrow syntax, captures, by-value and by-ref params
- [x] Match on literals — integer, string, float, bool patterns with wildcard

### Phase 3.5 — Beyond Stage-0 (self-hosting)

- [ ] Vec<T> in milo0 — 84 use sites, biggest blocker for milo0-on-milo0
- [ ] String.push in milo0
- [ ] Port type checker, HIR, lower, codegen to Milo
- [ ] MIR — lower-level IR for optimization passes
- [ ] Arena system designed based on real needs from self-hosting

Milestone: Compiler compiles itself, bit-identical (or equivalent) IR for the full Milo source set.

## Phase 4 — Competitive Language

Goal: close the gap with Rust/Go for real-world adoption. Ordered by "would a developer walk away without this."

### Tier 0 — dealbreakers

- [x] **Threads + channels** — `std/thread` (pthreads), `std/sync` (Mutex, Channel). Safe `spawn(move () => {...})` with move closures. Channel is handle-based — safe to capture in closures, no unsafe needed by users. Multi-producer, bounded FIFO.
- [x] **Escaping closures** — move closures heap-allocate env, can be returned from functions, stored in structs, composed. Enables callbacks, event handlers, higher-order patterns.
- [ ] **Trait objects / dynamic dispatch** — `dyn Trait` for runtime polymorphism. Vtable-based. Unlocks plugin systems, heterogeneous collections (`Vec<dyn Animal>`), dependency injection.
- [x] **std/testing** — `assert`, `assertEqual`, `assertEqual64`, `assertStrEqual`, `assertBool`. Test discovery via `testXxx` naming convention, `milo test` CLI runner with pass/fail reporting.

### Tier 1 — significant gaps

- [x] **Operator overloading** — Add/Sub/Mul/Div/Eq traits with `impl Add for T`. `@derive(Eq)` generates field-wise equality. `==`/`!=` on structs via Eq trait.
- [x] **String interpolation** — `$"hello {name}, you are {age}"` f-string syntax, desugars to `format()`.
- [ ] **Iterators** — iterator trait with `.map().filter().collect()` chains, lazy evaluation. Needs associated types or at minimum trait method return types.
- [x] **Auto-display** — `print(myStruct)` auto-formats structs and enums (field-wise display). User-defined `Display` trait deferred.
- [ ] **Error handling improvements** — `From` trait for automatic error conversion in `?`, `anyhow`-style error boxing.
- [ ] **Doc comments + doc generation** — `///` comments, `milo doc` to generate HTML/markdown.

### Tier 2 — polish

- [ ] **Cross-compilation** — `--target aarch64-linux` etc. Infrastructure exists in target.ts, needs testing + sysroot handling.
- [ ] **REPL / playground** — interactive exploration, web playground for demos.
- [ ] **LSP rename + find references** (completions already implemented).
- [ ] **Benchmarking** — `@bench` annotations, `milo bench` runner.

## Phase 4.5 — Ecosystem ✅ (partial)

- [x] **Package manager** — `milo-pkg` (written in Milo): init, new, add, install. Git-based global cache at `~/.milo/cache/`, lockfile with commit SHAs.
- [x] **Formatter** — `milo-fmt` (written in Milo): context-sensitive formatting, LSP integration.
- [ ] **Documentation / tutorials / "the book"**
- [x] **Example projects** — web servers (7 apps), CLI tools (jq, grep, cat, wc, tree, calc, hex, pkg, fmt)

## Standard Library — completed

- [x] std/math, std/random, std/time, std/sort, std/set
- [x] std/fmt, std/io, std/strconv, std/unicode, std/base64, std/hex, std/log
- [x] std/csv, std/regex, std/crypto
- [x] std/json, std/fs, std/net, std/http, std/process, std/argparse, std/path, std/env, std/args, std/arena
- [x] std/thread, std/sync, std/testing
