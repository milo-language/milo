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
| 1 | **`Vec` has no `insert(i)` / `remove(i)`** — only push/pop/swap/filter. Ordered child insert+remove must rebuild the whole child Vec in a loop. | **Open** — stdlib gap; bites any ordered list. |
| 2 | **Read-by-copy** — `arenaGet` returns `Option<T>` by value, deep-copying the whole node (strings + child Vec) on every read. Traversal would copy every node. | **Fixed** — added `arenaWith(a, h, |&T| …)`: borrow-read, no copy. Reads only the field(s) you name. |
| 3 | **Closure params bind immutable** — `arenaModify`'s `(T)=>T` forced a `var m = n` rebind plus full copy-in/copy-out per single-field write. | **Fixed** — added `arenaModifyMut(a, h, |&mut T| …)`: in-place mutation, no copy. |
| 4 | **Closures capture non-Copy values by move** — a string used in a closure *and* after it needs `.clone()` (flow-insensitive, even when the closure branch returns). Copy-able handles/scalars are unaffected. | **By design** — documented in the scaffold. Minor. |
| 5 | **Generic return-type param wouldn't infer from a closure's signature** — `R` in `arenaWith<T,R>(…, f:(&T)=>R)` is constrained only by the closure. Inference didn't look inside fn-typed params; turbofish on free-function calls isn't parseable either. | **Fixed** — `checker.ts` inference loop now unifies fn-typed params (`fnParams`/`fnRet`) to bind such params. `R` infers from the closure return; no annotation needed. |

### Bonus bug found + fixed

Building the escape hatch surfaced a real codegen bug: **a generic fn taking a bare `&T` param collapsed `&T` to value `T` during monomorphization** (`substituteMiloType` dropped the `isRef` wrapper when the type-param name *was* the whole type). The fn then passed a struct where a pointer was expected → segfault. Concrete `&P` and `&Arena<T>` were unaffected (only bare `&T` hit it). Fixed by preserving ref/ptr wrappers on substitution. Regression test: `tests/fixtures/genericRefClosure.milo`.

## What this unblocks

- `std/arena` now has a complete read/write story under second-class refs: `arenaGet`/`arenaSet` (value), `arenaModify` (value closure), **`arenaWith`** (borrow read), **`arenaModifyMut`** (borrow mutate). #2 and #3 — the only taxes intrinsic to the model — are gone.
- Remaining before a tokenizer port: **#1 (`Vec.insert`/`remove`)**, and the `Node`-small representation (atoms + offset-text) to keep reads cheap.

## Next

Port the html5ever tokenizer state machine (`tokenizer/mod.rs` + `states.rs` + `char_ref/`) and tree-builder insertion modes against this DOM, `Node`-small variant, and measure. That closes the loop on "does it survive a *big* program."
