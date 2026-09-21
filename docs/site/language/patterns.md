<!-- doc-meta
system: lifetime-free-patterns
purpose: cookbook of the seven shapes that replace Rust lifetime-carrying types
key-files: std/seal, std/arena, src/checker.ts
update-when: a pattern's API changes, or a new substitute for a stored borrow ships
last-verified: 2026-08-24
-->

# Patterns Without Lifetimes

Milo has no lifetimes: a reference can never be stored. What that costs, and the census
behind the bet, is [its own page](/language/why-no-lifetimes). This one is the cookbook:
seven patterns that replace the Rust shapes you were reaching for, and what each one
costs you.

Find the shape you were reaching for, and read across.

| The shape you know | Write this instead | Checked |
|---|---|---|
| `&line[0..4]`, a slice you use right here | [a view](#read-part-of-a-string-without-copying-it) | compile time |
| a `&str` returned to your caller | [own it, `substr` copies](#return-a-piece-of-a-string-to-your-caller) | nothing to check |
| many `&str` kept at once | [seal the buffer, store spans](#store-many-string-slices-without-an-allocation-each) | runtime¹ |
| `struct Parser<'a> { src: &'a str }` | [own the buffer, carry a position](#write-a-parser-or-cursor-over-text-you-do-not-own) | compile time |
| `Box<Expr>` for a self-containing type | [`Heap<Expr>`](#represent-a-tree-or-ast-that-contains-itself) | compile time |
| `Rc<RefCell<Node>>` for a graph | [an arena and a `Handle`](#build-a-tree-or-graph-whose-nodes-refer-to-each-other) | runtime |
| two integer index spaces, easily swapped | [a newtype for each](#stop-two-kinds-of-index-from-being-mixed-up) | compile time |

The **Checked** column is the price. Four keep the compile-time guarantee, one needs no
check at all because it copies, and two move the check to runtime.

Each pattern below shows the working form and, where it has a failure mode, the ways it can go wrong, in labelled boxes:

| Box | Means |
|---|---|
| ✓ **The way to write it** (green) | the form to reach for |
| 🛡 **The compiler stops you** | rejected before it runs, at no runtime cost. The guardrail working |
| ⚠ **Caught, but only when it runs** (yellow) | still safe, and it fails with a named cause (an abort, or an `Option.None`), but later |
| 🐛 **Buggy code, don't do this** (red) | compiles, runs, and hands back the wrong answer. Nothing warns you, so this is the one to actually avoid |

Not every pattern has a failure box: the ones that copy or own outright have no failure
mode to show.

¹ Nothing can dangle in either of the runtime rows: an arena and a sealed buffer both own
their storage. What is checked at runtime is *identity*, that a handle or a span is being
resolved against the thing it was made from. Memory safety is static in all seven.

For a Rust construct not listed here, the full shape-by-shape table is in
[Memory Safety vs Rust](/language/vs-rust#the-rust-shape-and-what-to-write-instead).

## Read part of a string without copying it

::: code-group

```rust [Rust]
let key = &line[0..4];  // &str, needs a lifetime once it leaves this scope
```

```cpp [C++]
std::string_view key{line.data(), 4};  // dangles if line changes
```

```ts [TypeScript]
const key = line.slice(0, 4);  // copies
```

```milo skip [Milo]
let key = line[0..4]  // a view, no lifetime, no copy
```

:::

Slice it. That is the whole thing.

::: tip ✓ THE WAY TO WRITE IT
A view is an ordinary `&string`: pass it to a function, read its length, compare it. No
allocation, and no annotation needed to make it safe.

```milo
fn shout(s: &string) {
    print(s.toUpper())
}

pub fn main(): i32 {
    let line = "host=localhost"
    let key = line[0..4]  // a view into line, nothing copied
    print(key)
    shout(key)            // goes anywhere a &string goes
    print(key.len)
    return 0
}
```

```
host
HOST
4
```
:::

::: info 🛡 THE COMPILER STOPS YOU
While `key` is alive, `line` is frozen. This is the C++
case above, caught:

```milo error
pub fn main(): i32 {
    var line = "host=localhost"
    let key = line[0..4]
    line = "port=8080"
    print(key)
    return 0
}
```

```
error: cannot assign to 'line' because it is borrowed
  hint: a reference or slice into this variable is still live — the assignment would
        invalidate it
```

:::

::: info 🛡 THE COMPILER STOPS YOU
Views cannot be stored: no `Vec` of them, no struct field:

```milo error
pub fn main(): i32 {
    let line = "host=localhost"
    var keys: Vec<&string> = Vec.new()
    keys.push(line[0..4])
    return 0
}
```

```
error: 'keys': references cannot be stored in a collection
  hint: references are second-class — store owned values instead
```

:::

### Returning one from a method

A method may hand back a view of its *own* storage. The receiver is frozen while the view
lives, so the two rules above still hold:

```milo
pub struct Config {
    line: string,
}

impl Config {
    fn key(self: &Self): &string {
        match self.line.indexOf("=") {
            Option.Some(sep) => { return self.line[0..sep] }
            Option.None => { return self.line[0..self.line.len] }
        }
    }
}

pub fn main(): i32 {
    var cfg = Config { line: "timeout=30" }
    print(cfg.key())
    return 0
}
```

```
timeout
```

Only of `self`, never of a local or another `&` parameter. That is the one place a
reference may be returned at all.

## Return a piece of a string to your caller

A view cannot leave the call. `substr` copies the bytes out, and the copy is an ordinary
owned `string` with no restrictions at all.

::: code-group

```rust [Rust]
fn key(line: &str) -> String {
    line[0..4].to_string()      // .to_string() is the copy
}
```

```cpp [C++]
std::string key(const std::string& line) {
    return line.substr(0, 4);  // substr returns an owning string
}
```

```ts [TypeScript]
function key(line: string): string {
    return line.slice(0, 4);    // already a copy
}
```

```milo skip [Milo]
fn key(line: &string): string {
    return line.substr(0, 4)    // substr copies
}
```

:::

::: tip ✓ THE WAY TO WRITE IT
Everything section one forbade is now allowed: a *free* function returns
it, a struct stores it, and a `Vec` holds a pile of them:

```milo
pub struct Setting {
    key: string,
    value: string,
}

fn parseLine(line: &string): Setting {
    match line.indexOf("=") {
        Option.Some(sep) => {
            return Setting {
                key: line.substr(0, sep),
                value: line.substr(sep + 1, line.len),
            }
        }
        Option.None => {
            return Setting { key: line.clone(), value: "" }
        }
    }
}

pub fn main(): i32 {
    var all: Vec<Setting> = Vec.new()
    all.push(parseLine("host=localhost"))
    all.push(parseLine("timeout=30"))
    for s in all {
        print(s.key + " -> " + s.value)
    }
    print(all.len)
    return 0
}
```

```
host -> localhost
timeout -> 30
2
```

Nothing is borrowed, so nothing is frozen and nothing can dangle. There is no rule to
learn here, which is the point: when a value has to outlive the call, owning it is always
correct.

The cost is one allocation per piece. For a config file that is invisible. For a tokeniser
over a large source file it is thousands of small allocations, and that is what the next
pattern is for.

:::

## Store many string slices without an allocation each

::: code-group

```rust [Rust]
struct Token { start: usize, len: usize }  // storable, but nothing ties it to a buffer
```

```cpp [C++]
struct Token { std::string_view text; };   // storable, and dangles when the source dies
```

```ts [TypeScript]
const tokens = src.split(" ");             // GC: one string object per token
```

```milo skip [Milo]
var toks: Vec<Span> = words(src)           // 16 bytes each, tied to their buffer
```

:::

The tokeniser case: one token per word in a large file, each surviving the function that
found it, and no allocation per token. A view cannot leave the call, and owning each token
means thousands of small copies. [`std/seal`](/stdlib/seal) is the third answer.

The two types come as a pair, and the shape of them is the whole idea:

```milo
// std/seal, in full
pub struct Sealed {
    _data: string,
    _bufferId: i32,
}

pub struct Span {
    start: i64,
    len: i32,
    _bufferId: i32,
}
```

`seal` consumes the buffer and hands back the `Sealed`. No method on it mutates, so
offsets into it stay valid for the whole life of the value. A `Span` is 16 bytes and **holds no text at
all**: a start, a length, and the id of the buffer it was measured against. On its own it
means nothing. Paired with its `Sealed` it means a slice, and `src.text(sp)` is what turns
it back into characters.

The `_` prefix is what keeps that true: a field named with a leading underscore is
private to the file that declares the struct, so `s._data = ...` from a caller is a
compile error (`field '_data' of 'Sealed' is private to 'std/seal.milo'`), and no
same-length replacement can leave existing spans resolving against different bytes.

That matching `_bufferId` on both sides is the tie. A zero-valued `Span` (a zeroed struct
field) matches no buffer, so the accidental case fails closed, and a forged id cannot be
written from outside `std/seal` for the same reason `_data` cannot. It
is why a span can be an ordinary value, kept in a `Vec`, a struct field, or a map key,
without the compiler tracking where its buffer went. The check happens when you resolve it.

::: tip ✓ THE WAY TO WRITE IT
`words` returns a `Vec<Span>` that outlives it, and no token was copied:

```milo
from "std/seal" import { seal, Sealed, Span }

// One span per word. Spans are plain values, so they survive the return.
fn words(src: &Sealed): Vec<Span> {
    var out: Vec<Span> = Vec.new()
    var start: i64 = -1
    for i in 0..src.len() {
        if src.byteAt(i) == ' ' {
            if start >= 0 {
                out.push(src.spanOf(start, i - start))
                start = -1
            }
        } else {
            if start < 0 {
                start = i
            }
        }
    }
    if start >= 0 {
        out.push(src.spanOf(start, src.len() - start))
    }
    return out
}

pub fn main(): i32 {
    let src = seal("host=localhost port=8080".clone())
    let toks = words(src)
    print(toks.len)
    for t in toks {
        print(src.text(t))
    }
    return 0
}
```

```
2
host=localhost
port=8080
```

Compare that to the first pattern: `Vec<&string>` is a compile error, and a `Vec<Span>` is
not, because a span borrows nothing. `src.text(t)` is what costs an allocation, and you pay
it only for the tokens you actually read. `src.eq(t, "host")` compares without one at all.

:::

::: warning ⚠ CAUGHT, BUT ONLY WHEN IT RUNS
Nothing here can dangle: a `Sealed` owns its bytes, so there is no use-after-free to
prevent. What the `_bufferId` catches is a *logic* error, resolving a span against the
wrong buffer and reading bytes that are in bounds and simply wrong:

```milo
from "std/seal" import { seal }

pub fn main(): i32 {
    let a = seal("host=localhost".clone())
    let b = seal("port=8080".clone())
    let key = a.spanOf(0, 4)
    print(b.text(key))     // measured against `a`, resolved against `b`
    return 0
}
```

```
assertion failed at std/seal.milo:161:5: sealed: span was measured against a different buffer
```
:::

In that example a compiler could obviously see it: two locals, one span, no ambiguity. The
reason the check is not at compile time is that the obvious case is not the general one.
The moment a span is useful, its buffer stops being statically known:

```milo
from "std/seal" import { seal, Sealed, Span }

// Which buffer does `sp` belong to? Nothing in the signature says, and nothing
// can: the whole point of a Span is that it travels separately from its buffer.
fn render(src: &Sealed, sp: Span): string {
    return src.text(sp)
}

pub fn main(): i32 {
    let a = seal("host=localhost".clone())
    var spans: Vec<Span> = Vec.new()
    spans.push(a.spanOf(0, 4))
    print(render(a, spans[0]))
    return 0
}
```

```
host
```

Once a span is in a `Vec`, crosses a function boundary, or is picked by a branch, the
compiler can no longer name its buffer. Tying the two at compile time is what a lifetime
parameter does, `Span<'a>` bound to `Sealed<'a>`, and that is the annotation this language
does not have. **You cannot have both.** Either spans are ordinary values you can store
and pass, or the compiler tracks their buffer.

It is worth being precise about what Rust does here, because the comparison is easy to
get backwards. `&'a str` is checked at compile time and **cannot be stored**, which is
the reason you are reading this section at all. When Rust code needs storable tokens it
reaches for the same design as this one, offsets into a side table: `rustc`'s `Span`
indexes a `SourceMap`, and lexer crates hand back byte ranges. Those carry no lifetime
either, and resolving one against the wrong source is unchecked. Measured against the
alternative that has the same capability, the `_bufferId` catches a bug the usual approach
does not.

A partial compile-time check that caught only the two-locals case would be worse than
none: it would pass on every toy and stay silent on the code that actually ships.

### Sealing also buys free sharing

Because a `Sealed` cannot change, handing it to another worker needs no copy and no lock.
`share()` turns it into a `Shared` that each reader clones for itself:

```milo
from "std/seal" import { Sealed, seal, sharedWith }
from "std/runtime" import { Promise }

pub fn main(): i32 {
    let src = seal("host=localhost port=8080".clone())
    let sh = src.share()
    var mine = sh.clone()          // the worker's own handle, same bytes

    let job = Promise<i64>.blocking(move (): i64 => {
        return mine.len()          // reads the shared buffer on a real thread
    })

    // sharedWith lends the Sealed itself, so the whole reader API applies to it.
    print(sharedWith(sh, (s: &Sealed): string => s.text(s.spanOf(0, 4))))
    print(job.await()!)
    return 0
}
```

```
host
24
```

Spans work against a `Shared` exactly as they do against a `Sealed`, so a tokeniser can run
on one thread and the spans it produced can be resolved on another. This is the
`Arc<[u8]>` row from [Memory Safety vs Rust](/language/vs-rust), and immutability is what
makes it free: there is nothing to lock because there is nothing that can change.

See [Memory Safety vs Rust](/language/vs-rust).


## Write a parser or cursor over text you do not own

::: code-group

```rust [Rust]
struct Lexer<'a> {
    src: &'a str,  // the lifetime is here
    pos: usize,
}
```

```cpp [C++]
struct Lexer {
    std::string_view src;  // dangles if the owner dies
    size_t pos;
};
```

```ts [TypeScript]
class Lexer {
    constructor(public src: string, public pos = 0) {}  // GC owns it
}
```

```milo skip [Milo]
pub struct Lexer {
    src: string,  // owns its text, so nothing can outlive anything
    pos: i64,
}
```

:::

A struct may not store a borrow, so the cursor **owns the buffer** and carries an integer
position, slicing on demand.

::: tip ✓ THE WAY TO WRITE IT
Because the cursor owns its text, `lexerFor` can build the string *and* a
cursor over it and return both as one value. That is the case Rust cannot write at all: a
`Lexer<'a>` borrowing a local would be returning a reference to something about to die.

```milo
pub struct Lexer {
    src: string,
    pos: i64,
}

impl Lexer {
    fn atEnd(self: &Self): bool {
        return self.pos >= self.src.len
    }

    fn nextWord(self: &mut Self): string {
        while self.pos < self.src.len && self.src[self.pos] == ' ' {
            self.pos += 1
        }
        let start = self.pos
        while self.pos < self.src.len && self.src[self.pos] != ' ' {
            self.pos += 1
        }
        return self.src.substr(start, self.pos)
    }
}

// Builds the text AND the cursor over it, then hands both back as one value.
fn lexerFor(name: &string): Lexer {
    let text = name.clone() + " = localhost"
    return Lexer { src: text, pos: 0 }
}

pub fn main(): i32 {
    var lx = lexerFor("host")
    while !lx.atEnd() {
        print(lx.nextWord())
    }
    return 0
}
```

```
host
=
localhost
```

The cursor is an ordinary owned value, so it can also live in a struct field, a `Vec`, or
a `HashMap`. None of that is available to a type carrying a lifetime.

`nextWord` returns an owned `string`, one allocation per token. If that matters, keep
the cursor exactly as it is and hand back
[spans instead](#store-many-string-slices-without-an-allocation-each): seal `src` once,
and return `Span` values that cost two integers each.

:::

## Represent a tree or AST that contains itself

::: code-group

```rust [Rust]
enum Expr {
    Num(i64),
    Add(Box<Expr>, Box<Expr>),
}
```

```cpp [C++]
struct Expr {
    std::unique_ptr<Expr> l, r;
};
```

```ts [TypeScript]
type Expr =
    | { kind: "num"; value: number }
    | { kind: "add"; l: Expr; r: Expr };  // GC handles the recursion
```

```milo skip [Milo]
enum Expr {
    Num(i64),
    Add(Heap<Expr>, Heap<Expr>),
}
```

:::

`Heap<T>` is the single-owner heap pointer, dereferenced with `*`. No lifetime, because
there is exactly one owner.

::: tip ✓ THE WAY TO WRITE IT

```milo
enum Expr {
    Num(i64),
    Add(Heap<Expr>, Heap<Expr>),
}

fn eval(e: &Expr): i64 {
    match e {
        Expr.Num(n) => { return n }
        Expr.Add(l, r) => { return eval(*l) + eval(*r) }
    }
}

// The tree is built here and handed back. One owner, moved to the caller.
fn build(): Expr {
    return Expr.Add(
        Heap(Expr.Num(2)),
        Heap(Expr.Add(Heap(Expr.Num(3)), Heap(Expr.Num(4))))
    )
}

pub fn main(): i32 {
    var trees: Vec<Expr> = Vec.new()
    trees.push(build())
    trees.push(Expr.Num(10))
    for t in trees {
        print(eval(t))
    }
    return 0
}
```

```
9
10
```

Because ownership is a tree, the whole thing moves as one value: built in a function,
returned, pushed into a `Vec`, and freed exactly once when the `Vec` goes. Nothing is
counted at runtime and nothing can be shared by accident.

This covers any tree that owns its children. When a node needs to point *back* at its
parent, or two nodes need to point at each other, ownership is no longer a tree, which
is the next section.

:::

## Build a tree or graph whose nodes refer to each other

::: code-group

```rust [Rust]
type Link = Rc<RefCell<Node>>;  // runtime borrow check, can leak cycles
// or: slotmap / arena + generational index
```

```cpp [C++]
struct Node { Node* parent; };  // raw pointers, no checking at all
```

```ts [TypeScript]
class Node { parent?: Node; }  // GC collects cycles for you
```

```milo skip [Milo]
var arena: Arena<Node> = Arena<Node>.new()
let h = arena.alloc(node)  // Handle: index + generation
```

:::

Put the values in one pool and refer to them by key. The obvious key is a `Vec` position,
and that is the trap: positions get reused.

::: danger 🐛 BUGGY CODE, DON'T DO THIS
`idx` was taken when the slot held `alice`. After the slot is reused it names `carol`
instead, and the read succeeds. No error, no crash, just the wrong record:

```milo
pub fn main(): i32 {
    var slots: Vec<string> = Vec.new()
    slots.push("alice")
    let idx = slots.len - 1
    slots.remove(idx)
    slots.push("carol")
    print(slots[idx])  // idx meant alice
    return 0
}
```

```
carol
```

:::

::: tip ✓ THE WAY TO WRITE IT
A `Handle` carries the position *plus* which arena issued it and
which occupant of the slot it was for. A stale one reads back as `None`:

```milo
from "std/arena" import { Arena }

pub struct Session {
    user: string,
}

pub fn main(): i32 {
    var arena: Arena<Session> = Arena<Session>.new()
    let h = arena.alloc(Session { user: "alice" })
    arena.free(h)
    let _carol = arena.alloc(Session { user: "carol" })  // reuses the slot
    match arena.get(h) {
        Option.Some(s) => { print(s.user) }
        Option.None => { print("None") }
    }
    return 0
}
```

```
None
```

Use a `Handle` wherever slots are recycled; a plain index is fine only for
append-only storage.

:::

## Stop two kinds of index from being mixed up

::: code-group

```rust [Rust]
struct NodeId(u32);                  // newtype, checked
struct EdgeId(u32);
```

```cpp [C++]
using NodeId = uint32_t;             // a typedef, NOT a distinct type
using EdgeId = uint32_t;             // these are interchangeable
```

```ts [TypeScript]
type NodeId = number & { __k: "node" };  // branded, erased at runtime
type EdgeId = number & { __k: "edge" };
```

```milo skip [Milo]
pub struct NodeId { index: i64 }     // single-field struct, zero cost
pub struct EdgeId { index: i64 }
```

:::

With several arenas, a key from one must not resolve in another. Both types are one
integer wide, so the check costs nothing at runtime.

::: info 🛡 THE COMPILER STOPS YOU

```milo error
pub struct ExprId { index: i64 }
pub struct StmtId { index: i64 }

fn exprAt(id: ExprId): i64 {
    return id.index
}

pub fn main(): i32 {
    let s = StmtId { index: 3 }
    print(exprAt(s).toString())
    return 0
}
```

```
error: argument 1 of 'exprAt': expected ExprId, got StmtId
  ──> patterns.milo:10:18
   │
10 │     print(exprAt(s).toString())
   │                  ^
```

:::

::: tip ✓ THE WAY TO WRITE IT

```milo
pub struct ExprId { index: i64 }
pub struct StmtId { index: i64 }

fn exprAt(id: ExprId): i64 {
    return id.index
}

pub fn main(): i32 {
    print(exprAt(ExprId { index: 3 }).toString())
    return 0
}
```

```
3
```

One sharp edge: a static method on a generic struct needs its type arguments
spelled out. `Arena<Node>.new()` works, bare `Arena.new()` is parsed as an enum
variant and fails.

:::
