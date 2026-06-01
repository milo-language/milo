# Rewrite Findings: html5ever-style DOM in Milo

Status: scaffold complete (`examples/domArena.milo`). Answers the open question from `verification-roadmap.md`: *does the no-stored-refs model survive a genuinely big program, or does it force unsafe / handle-index escapes that reintroduce unsafety?*

## The question, and the answer

ripgrep already exercised search/regex/mmap/parallel-walk. The next stress test is a **self-referential tree** — the canonical case where Rust gives up lifetimes. We surveyed `servo/html5ever` + `causal-agent/scraper` and built the load-bearing piece (the DOM + the ~12 core `TreeSink` operations) in Milo.

**Verdict: the model holds.** All 12 ops, zero `unsafe`, zero handle juggling beyond the generational-arena indices Rust *itself* uses here.

Key survey result: **html5ever uses no lifetimes for the DOM at all.** Both implementations abandon stored refs —
- `rcdom`: `Rc<Node>` + `Cell<Weak>` parent + `RefCell<Vec<Handle>>` children (refcount = hand-rolled GC), 0 unsafe.
- `scraper`: `ego_tree` — arena + integer `NodeId` indices, 0 unsafe.

Milo has no `Rc` by design, so it takes the `scraper` path: `std/arena` (generational `Handle<T>` indices). It lands exactly where Rust lands. The `TreeSink` trait is *already* second-class-reference style — `Handle` is an opaque `Clone` token, every op is `fn append(&self, parent: &Handle, …)`, refs only in params. Maps 1:1.

All the scary `unsafe` in html5ever lives in **tendril** (157 — the zero-copy refcounted string). Milo replaces it with owned UTF-8 strings: lose zero-copy slicing, gain zero unsafe. To recover the cost, keep `Node` small (intern names, store text as `(offset,len)` into the input — the `std/json.milo` approach).

## Findings (and resolution)

| # | Finding | Status |
|---|---------|--------|
| 1 | **`Vec` has no `insert(i)` / `remove(i)`** — only push/pop/swap/filter. Ordered child insert+remove had to rebuild the whole child Vec in a loop. | **Fixed** — added `Vec.insert(i, v)` (shift right, grow) and `Vec.remove(i)` (shift left, returns the element) via `@llvm.memmove`. `domArena` uses them directly now. |
| 2 | **Read-by-copy** — `arenaGet` returns `Option<T>` by value, deep-copying the whole node (strings + child Vec) on every read. Traversal would copy every node. | **Fixed** — added `arenaWith(a, h, |&T| …)`: borrow-read, no copy. Reads only the field(s) you name. |
| 3 | **Closure params bind immutable** — `arenaModify`'s `(T)=>T` forced a `var m = n` rebind plus full copy-in/copy-out per single-field write. | **Fixed** — added `arenaModifyMut(a, h, |&mut T| …)`: in-place mutation, no copy. |
| 4 | **Closures capture non-Copy values by move** — a string used in a closure *and* after it needs `.clone()` (flow-insensitive, even when the closure branch returns). Copy-able handles/scalars are unaffected. | **By design** — documented in the scaffold. Minor. |
| 5 | **Generic return-type param wouldn't infer from a closure's signature** — `R` in `arenaWith<T,R>(…, f:(&T)=>R)` is constrained only by the closure. Inference didn't look inside fn-typed params; turbofish on free-function calls isn't parseable either. | **Fixed** — `checker.ts` inference loop now unifies fn-typed params (`fnParams`/`fnRet`) to bind such params. `R` infers from the closure return; no annotation needed. |

### Bonus bugs found + fixed

The rewrite surfaced **two real compiler bugs** — exactly the "does it reintroduce unsafety?" question, answered in the compiler rather than the language model:

1. **Generic `&T` monomorphization (segfault).** A generic fn taking a bare `&T` param collapsed `&T` to value `T` during monomorphization (`substituteMiloType` dropped the `isRef` wrapper when the type-param name *was* the whole type). The fn then passed a struct where a pointer was expected → segfault. Concrete `&P` and `&Arena<T>` were unaffected (only bare `&T` hit it). Fixed by preserving ref/ptr wrappers on substitution. Regression: `tests/fixtures/genericRefClosure.milo`.

2. **Closure capture of heap values through a generic fn (use-after-free).** A closure passed to a *generic* fn (`arenaModifyMut`/`arenaWith`/`arenaModify`) that captured a heap-owned value (a built `String`/`Vec`) kept the value owned by the enclosing scope, which dropped it at scope end while the closure still referenced it → UAF (empty strings / SIGTRAP). String *literals* (static buffer) and *Copy* captures (handles) escaped it — which is why the `domArena` scaffold, built from literals, looked clean. The non-generic call paths already auto-moved such closures to transfer ownership into the env; the generic-fn call path didn't. Fixed by adding the same auto-move marking there. Regression: `tests/fixtures/closureCaptureHeap.milo`.
   - Sub-case (now fixed): capturing a *mutable local* by move also mis-dropped, because the guard keyed on the source var's mutability rather than whether the closure mutates the capture *in place*. Now tracked precisely (`CaptureInfo.mutatedInClosure`, set at `isRootMutable`/`Assign` sites): a capture that is only moved-out or read is move-captured; one mutated in place stays by-reference for write-back. Regression: `tests/fixtures/closureCaptureMutableLocal.milo`.

## Milestone: working tokenizer + tree builder

`examples/htmlParse.milo` — an HTML tokenizer + stack-based tree builder over the arena DOM. Handles tags, attributes (quoted/single/unquoted/boolean), text, comments, doctype, void elements, character references (named `&amp;`/`&lt;`/…/`&nbsp;` + numeric `&#87;`/`&#x...`), raw-text elements (`<script>`/`<style>` consume `<` literally) and RCDATA (`<textarea>`/`<title>` literal-tags but entity-decoded), and a pragmatic subset of implicit-close rules (`<li>a<li>b` → siblings; block tags and a new `<p>` close an open `<p>`; `dd`/`dt`, `td`/`th`/`tr`, `option`). Round-trips real HTML and answers a tiny "count elements by tag" query. **Zero unsafe.** Remaining simplifications: no full insertion-mode state machine (foster-parenting, table scoping), small named-entity table. This is the proof that the model carries a real state-machine parser, not just the data structure.

## What this unblocks

- `std/arena` now has a complete read/write story under second-class refs: `arenaGet`/`arenaSet` (value), `arenaModify` (value closure), **`arenaWith`** (borrow read), **`arenaModifyMut`** (borrow mutate). #2 and #3 — the only taxes intrinsic to the model — are gone.
- Remaining before a tokenizer port: **#1 (`Vec.insert`/`remove`)**, and the `Node`-small representation (atoms + offset-text) to keep reads cheap.

## Next

Port the html5ever tokenizer state machine (`tokenizer/mod.rs` + `states.rs` + `char_ref/`) and tree-builder insertion modes against this DOM, `Node`-small variant, and measure. That closes the loop on "does it survive a *big* program."

## Probe 2: tree-walking interpreter (`examples/apps/minilang.milo`)

The next rewrite probe — the "interpreter env holding an AST + values" lifetime pattern. Now a **complete source-to-value interpreter**: lexer → recursive-descent parser (precedence) → AST in a generational arena (recursive payload enums via `Handle`) → recursive `evalExpr` over a scope-stack environment. **Works, zero unsafe** — `1 + 2 * 3 - 4` → 3, `(2+3)*(4+1)` → 25, `let n=10 in if n>5 then n*n else 0` → 100. The lexer/parser/eval all compiled first-try once `match &enum` and the const-int coercions landed — the model carries a real interpreter, not just a data structure.

**New finding: `match` on a borrowed enum (`&enum`) is unsupported.** Reading a payload-bearing enum *out of* an arena or collection forces it — the read closure receives `&Expr`, and `match e { ... }` on that `&Expr` is rejected ("match subject must be an enum…, got Value/Expr" — it's behind a ref). The DOM dodged this (its `Node` was a struct with a payload-free `NodeKind`); the interpreter's `Expr`/`Value` are payload enums, so it hits the wall.

Workaround (and what the program uses): **tag-structs** — an `i32` tag + fields, dispatched with if-else, read back by field-copy (string cloned, Copy handles/ints copied) with no match on a reference. This is exactly the idiom `std/json.milo` already uses, so it's an established pattern, not a dead end. But it gives up exhaustiveness checking and payload ergonomics.

**Implemented: `match` on `&enum`** (bind payloads as borrows, à la Rust `match &x`). A non-Copy payload binds as `&T` (a view into the still-owned subject — no load, no source-zeroing, no drop); a Copy payload is a value copy; the subject is not consumed. Read/clone through the borrow is sound and leaves the owner intact across repeated matches. Spans checker (accept `&enum` subject; ref-ness is decided by the checker and passed to lower via a Set, because reading a ref Ident auto-derefs and hides the ref from `typeOf`) + lower/codegen (read tag/payloads through the borrow's pointer directly). Fixture: `tests/fixtures/matchRefEnum.milo`.

Three pre-existing bugs surfaced and fixed in the process:
- **`&Enum`/`*Enum` resolved with the inner mis-tagged as `struct`** (the enum-correction only handled bare names, not refs) — so a `&Value` param never type-checked as an enum.
- **Moving a non-Copy value out of a borrow was unsound** — `fn f(s: &string) { vec.push(s) }` shallow-copied the buffer, aliasing the owner → double-free (rc=133, confirmed). The auto-deref of ref Idents hid it from the move checker. Now rejected at `tryMove` with a clone hint. Error fixture: `tests/errors/moveBorrowOut.milo`.
- **`std/net.milo` `fetchPatch` was missing the `.clone()`** its sibling fetch functions all have — a real latent double-free, caught by the new check.

The interpreter can now use real payload enums for `Expr`/`Value` instead of tag-structs (exhaustiveness + payload ergonomics restored). `minilang.milo` keeps the tag-struct form as a record of the pre-feature idiom.
