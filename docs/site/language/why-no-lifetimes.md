<!-- doc-meta
system: lifetimes-rationale
purpose: why Milo has no lifetimes: the census behind the bet and what the 13% costs
key-files: src/checker.ts, scripts/lifetime-census.py
update-when: the reference model changes, or the lifetime census is re-run
last-verified: 2026-08-24
-->

# Why There Are No Lifetimes

Milo makes one big bet: **a reference can never be stored**
([the rule](/language/ownership#borrowing)).

Whether that bet is worth taking comes down to a single question: how much real code can
you still write? So we counted. Across five Rust codebases of deliberately different
shape (a web framework, a CLI library, a C++ interop toolchain, a data indexer, and an
agentic CLI app) there were 2,553 declarations carrying a lifetime. **87% are function
signatures**, and second-class references cover the ones whose borrow lives for one call,
which is most of them; a signature that *returns* a borrow tied to a parameter
(`fn longest<'a>(a: &'a str, b: &'a str) -> &'a str`) is the part of that bucket Milo
restructures instead. The remaining 13% are *types* that store a borrow, `Parser<'a>`
and friends, and that Rust shape cannot be written here.

Read that 13% carefully, because it is easy to misread in both directions. It is not
13% of code: it is 337 type declarations across five entire codebases, and they
cluster (62% of axum's sit in three files of serde plumbing). And none of it is
unwritable or unsafe: every one of those programs still gets written, restructured
around ownership, and every restructuring is statically memory-safe.
What actually moves is one check, the tie between a stored offset and its buffer,
which becomes a named runtime failure where Rust's invariant lifetime is a compile
error. That is the whole price. Nothing degrades to `unsafe` or to unchecked
access.

## Local reasoning

What the restructuring buys is local reasoning. A lifetime on a type is infectious:
store a `Parser<'a>` and your struct grows `<'a>`, then the struct holding that one,
until a signature three modules away carries an annotation whose reason is no longer
visible from where it stands. Milo's substitutes (own the buffer, carry a `Span`, use
a handle) keep every fact about a value readable at the value: no declaration means
anything beyond what it says.

Since no reference is stored, nothing in the heap is aliased, and **the state a function
can touch is its parameter list**. A mutation here cannot change something over there,
because there is no other pointer into that data, and every argument the call may change
is marked `&mut` where it is passed. Verifying a function means reading that function.
Whole classes of bug are questions about global state in C++ or in Rust with
`Rc<RefCell>`: a callback mutating a container someone else is iterating, a `&mut`
handed out twice, a struct outliving the buffer it points into. Milo makes them
unwritable rather than answerable. The errors are local for the same reason: an aliasing
error names the call that breaks the rule, not an ownership restructuring three frames up.

A type that cannot store a borrow also crosses to another task with no borrow chain to
prove safe; see [Thread Safety](/features/concurrency#thread-safety-send-sync).

## What it costs

The cost is not uniform, so it is stated per pattern. A parser restructures
gracefully and arguably reads better than its `<'a>` original. An iterator yielding
borrows restructures into an index loop or a callback, and a long Rust adapter chain
genuinely reads better than that. The **Checked** column in
[Patterns Without Lifetimes](/language/patterns) is that score kept honestly.

Re-run the count yourself with `scripts/lifetime-census.py`.

## Where to go next

- [Patterns Without Lifetimes](/language/patterns) — the seven shapes to write instead, with running code.
- [Memory Safety vs Rust](/language/vs-rust) — where each language catches which bug.
- [Ownership](/language/ownership) — the single-owner model the substitutes are built on.
