# std/seal

`seal` turns a buffer you own into a buffer nobody can change, so you can keep offsets into it and store them anywhere without the offsets going bad.

This is the zero-copy tool. A lexer, parser, or deserializer wants to hold on to thousands of small pieces of a large input. Copying each piece into its own string means one allocation per piece. Milo will not let you store a `&string` instead, because references are second-class. So keep `(start, len)` pairs and resolve them against the buffer when you actually need the bytes.

The catch with offsets has always been that nothing stops the buffer changing underneath them. `seal` removes that possibility rather than checking for it: a `Sealed` has no method that mutates.

```milo
from "std/seal" import { Sealed, Span, seal }
```

## Quick start

```milo
from "std/seal" import { Sealed, Span, seal }

pub fn main(): i32 {
    var buf: string = "{\"name\":\"milo\"}"
    let src = seal(buf)              // buf is moved; it cannot be changed again

    let name: Span = src.spanOf(9, 4)      // measured against src, and branded with it

    print(src.text(name))            // "milo" — this is the allocation
    print(src.eq(name, "milo").toString())   // "true" — this one allocates nothing
    return 0
}
```

## Why the offsets stay valid

The whole guarantee is these two facts holding at once:

- `seal` **consumes** the buffer. The old binding is moved, so the compiler rejects any later use of it. `buf.push('x')` after the seal does not compile.
- `Sealed` **has no mutating method**. There is no `push`, no `set`, no `resize`. Nothing in the API changes the bytes.

So no *method* changes the bytes a span points at, and no *caller* can either: `_data` and `_bufferId` are named with a leading underscore, which makes them private to `std/seal.milo`. A caller holding a `Sealed` as `var` who writes `s._data = ...` gets `error: field '_data' of 'Sealed' is private to 'std/seal.milo'`, so a same-length replacement under a live span is a compile error, not a wrong answer.

## Spans are branded

A `Span` carries the identity of the buffer it was measured from, so resolving one
against a *different* `Sealed` fails loudly instead of returning wrong-but-in-bounds
bytes:

```milo
from "std/seal" import { seal }

pub fn main(): i32 {
    let a = seal("hello world aaaa")
    let b = seal("GOODBYE EARTH bb")
    let sp = a.spanOf(0, 5)

    print(a.text(sp))                      // "hello"
    print(b.holds(sp).toString())          // "false" — not this buffer's span
    // b.text(sp) aborts: "span was measured against a different buffer"
    return 0
}
```

Before the brand that last line returned `"GOODBYE"[0..5]` and said nothing. It is
still not what Rust does — Rust rejects it at compile time with an invariant lifetime,
and with no lifetimes to carry the tie a runtime brand is the honest substitute. What
it buys is the demotion this project's claim discipline asks for: a wrong answer
becomes a named failure.

Build spans with `src.spanOf(start, len)`. A hand-built `Span` carries brand 0, which
no buffer ever has, so it fails closed rather than resolving somewhere plausible.

## Span is plain data

```milo
from "std/seal" import { Span }

struct Token {
    kind: i64,
    at: Span,
}
```

A `Span` is three integers packed into 16 bytes: a start, a length, and its buffer's brand. No pointer, no hidden state, `Copy`. Put it in a struct field, a `Vec`, a map key, or a serialised record. It costs nothing to keep and it touches memory only when you resolve it against a `Sealed`.

## Compare without copying

The operation a scanner performs most on a retained piece is comparing it, not owning it. Doing that through `text` would allocate once per comparison, which defeats the point:

```milo
from "std/seal" import { Sealed, Span, seal }

pub fn main(): i32 {
    var buf: string = "let x = 1"
    let src = seal(buf)
    let word: Span = src.spanOf(0, 3)

    print(src.eq(word, "let").toString())    // true, no allocation
    print(src.text(word))                    // "let", one allocation
    return 0
}
```

Use `eq` in the hot path. Reach for `text` only when you genuinely need to own the bytes.

## Getting the buffer back

`unseal` consumes the `Sealed` and returns the buffer, mutable again:

```milo
from "std/seal" import { seal }

pub fn main(): i32 {
    var buf: string = "hello"
    let src = seal(buf)
    var back = src.unseal()
    back.push('!')
    print(back)                              // "hello!"
    return 0
}
```

This is the staged pipeline: build, seal, parse and share, unseal, mutate, seal again. Spans you measured before the unseal are still just integers, and the buffer is free to change again, so that is exactly where the guarantee ends.

## Sharing one buffer across threads

A `Sealed` is an owned value, so handing it to a worker moves it. That is wrong for the
case this module was written for: several scanners reading one large input at once.
Copying per worker is the cost `seal` exists to avoid, and a reference cannot cross a
thread boundary.

`share` consumes the `Sealed` and returns a `Shared`, a holder that can be cloned:

```milo
from "std/seal" import { Shared, seal, thaw, unseal }
from "std/runtime" import { Promise }

pub fn main(): i32 {
    let src = seal("the quick brown fox".clone())
    let a = src.share()                          // consumes the Sealed

    var ps: Vec<Promise<i64>> = Vec.new()
    for k in 0..4 {
        let c = a.clone()                        // another holder, no copy
        ps.push(Promise<i64>.blocking(move (): i64 => {
            var hits: i64 = 0
            var i: i64 = 0
            while i < c.len() {
                if c.byteAt(i) == 111 { hits = hits + 1 }
                i = i + 1
            }
            return hits
        }))
    }
    let counts = Promise.all(ps).await()!
    var total: i64 = 0
    for x in counts { total = total + x }
    print(total.toString())                      // 8
    return 0
}
```

Sharing is normally unsafe because a reader can observe a write. Here no operation in the
API writes, so N readers over one buffer need no lock, no ordering, and no check on the
read path. That rests on callers not reaching past the API into the fields, per the caveat
above. `Send` and `Sync` are
audited rather than derived, and the only mutable state is the holder count, which moves
under an atomic.

### Reading a `Shared`

There is one reader API to learn, and it lives on `Sealed`. `sharedWith` hands the callback
the `Sealed` itself, so everything above is available on it and nothing is copied:

```milo
from "std/seal" import { Sealed, seal, sharedWith }

pub fn main(): i32 {
    let a = seal("{\"name\":\"milo\"}".clone()).share()
    let name = sharedWith(a, (s: &Sealed): string => s.text(s.spanOf(9, 4)))
    print(name)                                  // "milo"
    return 0
}
```

`Shared` used to re-expose all eight readers as its own methods, which was two hand-kept
lists that drifted the moment one gained a method. `sharedWith` is the one borrow point
that replaced them. It is a free function rather than a method because `R` is a type
parameter of the operation rather than of `Shared`, and a method's own type parameter is
never inferred at the call site — the same reason `std/arena` spells its read as
`arenaWith`.

`len` and `byteAt` do stay on `Shared` directly, as the worker loop above uses them: a
closure per byte is the wrong shape for a hot path. Beyond those, the two types differ in
the ownership verbs: `Sealed` has `unseal` and `share`, `Shared` has `clone` and `holders`.

### Getting it back

`thaw` returns the `Sealed` when the caller is the only holder left, and refuses otherwise,
because handing it back would let it be unsealed and mutated under readers still reading:

```milo
from "std/seal" import { seal, thaw, unseal }

pub fn main(): i32 {
    let a = seal("hello".clone()).share()
    let other = a.clone()                        // a second holder
    match thaw(a) {
        Result.Ok(s) => {
            print(unseal(s))
        }
        Result.Err(rej) => {
            print("still shared by " + rej.holders.toString())   // 2
            let back = rej.shared                // refusal hands the buffer back
        }
    }
    return 0
}
```

The refusal carries the `Shared`, so a caller who guessed wrong has not lost the buffer.
`holders()` is a progress hint and nothing more: another thread may clone or drop between
your reading it and acting on it. `thaw` is the operation that reads the count and acts on
it without that window.

That completes the cycle the staged pipeline wants: build, seal, share out to workers,
collect, thaw, mutate, seal again. Mutation is exclusive by type and reads are concurrent
by type, with a runtime check only at the boundary between the two phases.

## What this does not protect against

A span's brand is checked when you resolve it, not when you build it, so a span aimed at the wrong buffer fails at the read rather than at the mistake. Tying the two together at compile time would need a lifetime or a type-level brand, and neither exists in this language, so the tie is a runtime tag. Use `holds` to branch on a span you did not measure yourself rather than letting `text` abort.

Nothing here protects a buffer after `unseal`. Spans you measured are still just integers, and the buffer is mutable again.

See [how Milo compares to Rust](/language/vs-rust) for the honest accounting of what this closes and what it does not.

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/seal*.milo. -->

## API reference

### `Sealed`

```milo
pub struct Sealed
```

An immutable byte buffer. Produced by consuming a string with `seal`; the
only way back to a mutable buffer is `unseal`, which consumes this.

Every method here reads, and `_data` / `_bufferId` are file-private, so no caller can
swap the bytes under a live span: the compiler enforces the invariant, not convention.

#### `Sealed.byteAt`

```milo
fn Sealed.byteAt(self: &Sealed, i: i64): u8
```

The byte at `i`, bounds-checked.

#### `Sealed.each`

```milo
fn Sealed.each(self: &Sealed, sp: Span, f: (u8) => void): void
```

Visit each byte of `sp` without materialising it.

#### `Sealed.eq`

```milo
fn Sealed.eq(self: &Sealed, sp: Span, other: &string): bool
```

Compare `sp` to a string without materialising it.

#### `Sealed.holds`

```milo
fn Sealed.holds(self: &Sealed, sp: Span): bool
```

Whether `sp` fits here. Branch on this for a span you did not measure
yourself; `text` aborts instead.

#### `Sealed.len`

```milo
fn Sealed.len(self: &Sealed): i64
```

Bytes held.

#### `Sealed.share`

```milo
fn Sealed.share(self: Sealed): Shared
```

Consume this buffer and return a shareable holder of the same bytes.

#### `Sealed.span`

```milo
fn Sealed.span(self: &Sealed): Span
```

A span over the whole buffer.

#### `Sealed.spanOf`

```milo
fn Sealed.spanOf(self: &Sealed, start: i64, len: i64): Span
```

Measure a span against this buffer. Use this rather than building a Span by
hand: a hand-built one carries _bufferId 0 and will not resolve anywhere.

#### `Sealed.text`

```milo
fn Sealed.text(self: &Sealed, sp: Span): string
```

Materialise `sp` as an owned string. The allocation lives here.

#### `Sealed.unseal`

```milo
fn Sealed.unseal(self: Sealed): string
```

Give the buffer back, mutable. Consumes this Sealed.

### `Shared`

```milo
pub struct Shared
```

---------------------------------------------------------------------------
Sharing one sealed buffer across threads.
---------------------------------------------------------------------------

`Sealed` is an owned value, so one holder has it and passing it to a worker
moves it. That is the right default, and it is exactly wrong for the case this
module was written for: N scanners reading ONE large input at once. Copying the
buffer per worker is the cost `seal` exists to avoid, and a reference cannot
cross a thread boundary.

The way out is the property `Sealed` already has. Sharing is unsafe when a
reader can observe a write, and no operation on a `Sealed` writes. Immutability
is not a promise here, it is the absence of a method, so N readers over one
buffer needs no lock, no ordering, and no check inside the read path. What is
left is deciding when the storage is released, which is a count, not a race.

    let src = seal(readFile("big.json")!)
    let a = src.share()          // consumes the Sealed
    let b = a.clone()            // another holder, same bytes, no copy
    ... hand `b` to a worker by move ...
    let back = thaw(a)           // Ok only when no other holder is alive

Reading a `Shared` goes through `sharedWith`, which hands the callback the `Sealed`
itself; `len` and `byteAt` are also on `Shared` directly for the per-byte loop.

`Send` and `Sync` are audited rather than derived: the raw pointer is reached
only by the read paths below and by a refcount that moves under an atomic.

Move-tracked twice over: the Drop impl and the raw pointer field each make it so.

#### `Shared.byteAt`

```milo
fn Shared.byteAt(self: &Shared, i: i64): u8
```

The byte at `i`, bounds-checked.

#### `Shared.clone`

```milo
fn Shared.clone(self: &Shared): Shared
```

Another holder of the same bytes. No copy; the buffer is released when the
last holder drops.

#### `Shared.holders`

```milo
fn Shared.holders(self: &Shared): i64
```

How many holders are alive right now. A progress hint: by the time you read
it another thread may have cloned or dropped one. `thaw` is the operation
that acts on the count without a window between reading and using it.

#### `Shared.len`

```milo
fn Shared.len(self: &Shared): i64
```

Bytes held.

### `Span`

```milo
pub struct Span
```

Fields: `start: i64`, `len: i32`.

### `ThawRejected`

```milo
pub struct ThawRejected
```

A refused `thaw`, holding the buffer it declined to hand back.

Returning the `Shared` rather than dropping it is what makes the refusal
recoverable: a caller who guessed wrong about the other holders still has the
buffer, and `holders` says how many were alive at the moment of the attempt.

Fields: `shared: Shared`, `holders: i64`.

### Functions

#### `seal`

```milo
pub fn seal(s: string): Sealed
```

Consume a buffer and return it sealed. O(1): the bytes are moved, not copied.

#### `share`

```milo
pub fn share(s: Sealed): Shared
```

Consume a `Sealed` and return a shareable holder of the same bytes. O(1): the
buffer is moved into the box, never copied.

#### `sharedWith`

```milo
pub fn sharedWith<R>(sh: &Shared, f: (&Sealed) => R): R
```

Read the shared buffer through a borrow: `f` gets the `Sealed` itself, so the whole
reader API is available on it and nothing is copied.

    let name = sharedWith(sh, (s: &Sealed): string => s.text(sp))
    let ok   = sharedWith(sh, (s: &Sealed): bool => s.eq(sp, "name"))

This is the accessor because Milo cannot return a `&Sealed`, so `Shared` cannot
delegate through a deref the way `Arc<T>` does. The alternative was re-exposing every
reader by hand on `Shared`, two lists that drift apart the moment one gains a method.
One borrow point replaces the list.

Free function, not a method: `R` is a parameter of the operation rather than of
`Shared`, and a method's own type parameter is never inferred at the call site. Same
reason `std/arena` spells its read as `arenaWith`.

`len` and `byteAt` stay on `Shared` directly: a worker calls those per byte in a loop,
where a closure per read is the wrong shape.

#### `thaw`

```milo
pub fn thaw(sh: Shared): Result<Sealed, ThawRejected>
```

Recover the `Sealed` when this is the only holder alive.

Refused while another holder exists, because handing the buffer back would let
it be unsealed and mutated under readers that are still reading it. The refusal
returns the `Shared` unharmed.

#### `unseal`

```milo
pub fn unseal(s: Sealed): string
```

Hand the buffer back, mutable again. Consumes the Sealed, so no span holder
can still be relying on it through THIS binding.

Spans measured against it are of course still just integers, and will read a
buffer that is now free to change. That is the same offsets-by-convention
situation this module exists to replace, so unseal is the point at which the
guarantee ends, deliberately and visibly.

<!-- /generated:api -->
