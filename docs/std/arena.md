# std/arena

## std/arena

### `Arena.alloc`

```milo
fn Arena.alloc(self: &mut Arena, val: T): Handle<T>
```

Move `val` into a free slot and return a Handle<T> naming it. Reuses a
slot from the free list when one exists, otherwise grows the arena.

### `Arena.clear`

```milo
fn Arena.clear(self: &mut Arena)
```

Drop every value and release the backing storage. The arena takes a fresh
identity, so every handle ever issued before this point is now stale.
The only operation that returns memory to the allocator.

### `Arena.free`

```milo
fn Arena.free(self: &mut Arena, h: Handle<T>): bool
```

Logically delete the slot: drop the value, bump the slot's generation so
every outstanding handle to it goes stale, and offer the index for reuse.
False if `h` was already stale — so a double free is a no-op, not a fault.
Does NOT shrink the arena, and does not chase handles held INSIDE the
freed value; a cyclic graph still needs a sweep you write.

### `Arena.freeze`

```milo
fn Arena.freeze(self: Arena): Result<FrozenArena<T>, FreezeRejected<T>>
```

End the build phase: consume this arena and hand back a FrozenArena<T>
whose `get` returns T rather than Option<T>. `self` is moved, so any
later use of this binding is a compile error.

Errs if this arena ever freed a slot; see arenaFreeze for why that is
refused rather than papered over.

### `Arena.get`

```milo
fn Arena.get(self: &Arena, h: Handle<T>): Option<T>
```

A COPY of the value at `h`, or None if `h` is stale.

This copies the whole T out of the slot every call, and for any T that owns
heap that copy is an ALLOCATION, not a few words — 20ms per 200k reads of a
node with one Vec field, against ~0 for the borrowing paths. Reach for it
only when T is plain scalars or you genuinely want an owned copy.

To read without copying, use `read`, which lends `&T` to a closure and
takes the answer out through a captured var:

    var edges = 0
    a.read(h, (v: &Node) => { edges = v.edges.len })

The more natural `let n = arenaWith(a, h, (v: &Node): i64 => v.edges.len)`
exists as a free function only: its result is a type parameter of the
METHOD rather than of Arena, and a method's own type parameter is never
inferred at the call site.

Absent on an arena whose T carries Drop or @noCopy: the copy would be a
second owner of the resource. `read` and `modifyMut` remain.

### `Arena.handles`

```milo
fn Arena.handles(self: &Arena): Vec<Handle<T>>
```

A snapshot Vec of every currently live handle — the enumeration shape a
collector sweeps. Frees after this call invalidate entries in the Vec;
allocs after it do not appear in it.

### `Arena.len`

```milo
fn Arena.len(self: &Arena): i64
```

Live entries, not slots: freed slots awaiting reuse are excluded, so this
can be far below the arena's actual footprint.

### `Arena.modify`

```milo
fn Arena.modify(self: &mut Arena, h: Handle<T>, f: (T) => T): bool
```

Update the slot by mapping its value through `f`. False (and `f` not
called) if `h` is stale. Moves T out and back, so prefer modifyMut when T
is large or you touch only a field or two. Absent when T carries Drop or
@noCopy, for the same reason as `get`.

### `Arena.modifyMut`

```milo
fn Arena.modifyMut(self: &mut Arena, h: Handle<T>, f: (&mut T) => void): bool
```

_Undocumented._

### `Arena.new`

```milo
fn Arena.new(): Arena<T>
```

A new empty arena with a fresh identity. Spell the type argument
(`Arena<Node>.new()`); a bare `Arena.new()` cannot infer T.

### `Arena.read`

```milo
fn Arena.read(self: &Arena, h: Handle<T>, f: (&T) => void): bool
```

Mutate the live value in place through `&mut T`. No copy in, no copy out.
False (and `f` not called) if `h` is stale. This is the write counterpart
to arenaWith and the right default for large T.
Read the value at `h` by BORROW — no copy. Prefer this to `get` for any T
that owns heap (a string, a Vec, a nested struct): `get` clones the whole
value out of the slot on every call. False (and `f` not called) if `h` is
stale. Take the result out through a captured `var`.

### `Arena.sealGrowth`

```milo
fn Arena.sealGrowth(self: Arena): Result<GrowOnlyArena<T>, FreezeRejected<T>>
```

End freeing, but keep allocating. The middle tier: `get` becomes infallible
while `alloc` still works. See GrowOnlyArena.

### `Arena.set`

```milo
fn Arena.set(self: &mut Arena, h: Handle<T>, val: T): bool
```

Replace the value at `h`. False (and no write) if `h` is stale.

### `Arena.valid`

```milo
fn Arena.valid(self: &Arena, h: Handle<T>): bool
```

Whether `h` still names a live value in THIS arena — identity and
generation both checked. A handle from another arena reads as invalid.

### `arenaAlloc`

```milo
pub fn arenaAlloc<T>(a: &mut Arena<T>, val: T): Handle<T>
```

Insert a value and return a handle to it.

### `arenaClear`

```milo
pub fn arenaClear<T>(a: &mut Arena<T>)
```

Drop every value and release the backing storage in one go. Per-slot free()
recycles a slot but never shrinks the arena, so a long-lived arena sits at its
peak footprint forever; clear is the bulk-reset escape from that.

Every outstanding handle goes stale because the arena takes a fresh identity —
a pre-clear handle fails the arenaId check outright. Restarting generations at
1 on a recycled Vec would otherwise let an old handle alias a new value.

### `arenaFree`

```milo
pub fn arenaFree<T>(a: &mut Arena<T>, h: Handle<T>): bool
```

Free a slot, bumping its generation so stale handles are detected. A slot at
maximum generation is retired rather than wrapped back onto an old handle.

### `arenaFreeze`

```milo
pub fn arenaFreeze<T>(a: Arena<T>): Result<FrozenArena<T>, FreezeRejected<T>>
```

Consume an arena and hand back a read-only view of the same storage. O(n) in
slots to check the precondition; no element is copied.

Refused when the source arena ever freed a slot, and the refusal returns the
arena. That refusal is the whole reason `get` can skip the generation check:
a slot that was freed and then reallocated leaves stale handles naming a LIVE
slot that now holds a DIFFERENT value, and an unchecked `get` would hand that
value back as though it were the right one. Silently returning the wrong
value is worse than any rejection, so the freeze is refused instead and the
caller keeps the generation-checked arena.

A slot's generation is 1 from birth and only `free` ever moves it (to a
negative value, or to 0 when the slot retires), so `gens[i] != 1` is exactly
the test for "this slot was freed at some point".

### `arenaGet`

```milo
pub fn arenaGet<T>(a: &Arena<T>, h: Handle<T>): Option<T>
```

Get a copy of the value at a handle. Returns None if the handle is stale.
Returns by value, not &T, because second-class refs cannot be stored in
Option<_>. For large T, prefer arenaModify to avoid the copy churn. A T that
carries Drop or @noCopy has no sound copy: this is rejected for it, use arenaRead.

### `arenaHandles`

```milo
pub fn arenaHandles<T>(arena: &Arena<T>): Vec<Handle<T>>
```

Snapshot every currently live handle. The returned handles remain ordinary
generational capabilities: later frees invalidate them, while later allocs do
not appear in this already-produced Vec. This is the safe enumeration shape
for collectors because no element reference survives into caller code.

### `arenaLen`

```milo
pub fn arenaLen<T>(a: &Arena<T>): i64
```

Number of live entries.

### `arenaModify`

```milo
pub fn arenaModify<T>(a: &mut Arena<T>, h: Handle<T>, f: (T) => T): bool
```

In-place update via closure. Avoids the manual get/modify/set dance and
is the recommended way to mutate a single field of an arena value.
Returns false if the handle is stale (closure not invoked). The closure takes
the value by copy, so a T carrying Drop or @noCopy is rejected: use arenaModifyMut.

### `arenaModifyMut`

```milo
pub fn arenaModifyMut<T>(a: &mut Arena<T>, h: Handle<T>, f: (&mut T) => void): bool
```

In-place mutate via &mut borrow — no copy in, no copy out, no full-struct
rewrite. Mutate fields of the live value directly inside f. Returns false
(f not called) if the handle is stale. Preferred over arenaModify when T is
large or you only touch a field or two.

### `arenaNew`

```milo
pub fn arenaNew<T>(): Arena<T>
```

Create a new empty arena.

### `arenaRead`

```milo
pub fn arenaRead<T>(a: &Arena<T>, h: Handle<T>, f: (&T) => void): bool
```

Read via borrow with a VOID callback — the same zero-copy read as arenaWith,
in the one shape that also has a method form (`a.read(h, f)`).

arenaWith is the more natural spelling and cannot be a method: its result type
is a type parameter of the METHOD rather than of Arena, and a method's own type
parameter is never inferred at the call site — `a.with(h, f)` reports
"type 'Arena_Node' has no method 'with'". This one returns bool, so it has no
such parameter. Take the value out through a captured `var`:

    var name = ""
    a.read(h, (v: &Node) => { name = v.name.clone() })

Why this matters more than it looks: `a.get(h)` COPIES the whole T out of the
slot, which for any T with an owning field is a heap allocation per read —
measured at 20ms per 200k reads of a node with one Vec field, against ~0 for
the borrowing paths. That gap is why real programs reach for a bare index into
a Vec instead of a Handle, so the ergonomic read path is the one that decides
whether generational safety gets used at all.

### `arenaSealGrowth`

```milo
pub fn arenaSealGrowth<T>(a: Arena<T>): Result<GrowOnlyArena<T>, FreezeRejected<T>>
```

Consume an arena into the grow-only tier. Refused, like `freeze`, for an arena that
ever freed a slot: a freed-and-reused slot leaves stale handles naming a live slot
holding a different value, and this tier removes the generation check that would
catch them. The refusal hands the arena back.

### `arenaSet`

```milo
pub fn arenaSet<T>(a: &mut Arena<T>, h: Handle<T>, val: T): bool
```

Overwrite the value at a handle. Returns false if the handle is stale.

### `arenaValid`

```milo
pub fn arenaValid<T>(a: &Arena<T>, h: Handle<T>): bool
```

Check whether a handle is still valid.

### `arenaWith`

```milo
pub fn arenaWith<T, R>(a: &Arena<T>, h: Handle<T>, f: (&T) => R): Option<R>
```

Read via borrow — no copy. The &T flows into `f` as a second-class ref:
valid only inside the closure, never stored or returned. Returns None (and
does not call f) if the handle is stale. This is the zero-copy alternative
to arenaGet for large T — read just the field(s) you need inside f.

### `FrozenArena.get`

```milo
fn FrozenArena.get(self: &FrozenArena, h: Handle<T>): T
```

The value at `h`, with no Option to unwrap. Aborts only on a handle from
another arena or an out-of-range index, neither of which is staleness.
Absent when T carries Drop or @noCopy; `read` is the borrowing form.

### `FrozenArena.holds`

```milo
fn FrozenArena.holds(self: &FrozenArena, h: Handle<T>): bool
```

Whether `h` names a slot here. Branch on this instead of `get` when a
foreign handle is a case you expect rather than a bug.

### `FrozenArena.len`

```milo
fn FrozenArena.len(self: &FrozenArena): i64
```

Slots held; every one is live.

### `FrozenArena.read`

```milo
fn FrozenArena.read(self: &FrozenArena, h: Handle<T>, f: (&T) => void): void
```

Borrow the value at `h` rather than copying it. Prefer this when T owns
heap storage.

### `frozenGet`

```milo
pub fn frozenGet<T>(a: &FrozenArena<T>, h: Handle<T>): T
```

The value at `h`. Infallible for any handle this arena's source minted.

The two checks that remain are not liveness checks, they are confusion
checks: a handle from ANOTHER arena, or an index outside this arena's
storage, has nothing to do with staleness and must not be allowed to read
unrelated memory. Both abort with a named message rather than return a
plausible-looking value.

A copy, so rejected for a T that carries Drop or @noCopy; `frozenRead` borrows.

### `frozenHolds`

```milo
pub fn frozenHolds<T>(a: &FrozenArena<T>, h: Handle<T>): bool
```

Whether `h` names a slot in THIS frozen arena. False for a handle minted by a
different arena. Use it when a foreign handle is a possibility you want to
branch on rather than abort over.

### `frozenLen`

```milo
pub fn frozenLen<T>(a: &FrozenArena<T>): i64
```

Slots held. Every one is live, so unlike Arena.len this is also the storage
count.

### `frozenRead`

```milo
pub fn frozenRead<T>(a: &FrozenArena<T>, h: Handle<T>, f: (&T) => void): void
```

Borrow the value at `h` instead of copying it. Prefer this to `get` when T
owns heap storage, since `get` hands back a copy.

### `GrowOnlyArena.alloc`

```milo
fn GrowOnlyArena.alloc(self: &mut GrowOnlyArena, val: T): Handle<T>
```

Append a value and return a handle to it. The only mutating operation this
tier has: nothing here frees, clears or recycles.

### `GrowOnlyArena.freeze`

```milo
fn GrowOnlyArena.freeze(self: GrowOnlyArena): FrozenArena<T>
```

Building is over: give up `alloc` too. Cannot fail, because this tier never
freed anything.

### `GrowOnlyArena.get`

```milo
fn GrowOnlyArena.get(self: &GrowOnlyArena, h: Handle<T>): T
```

The value at `h`, with no Option to unwrap. Infallible for any handle this
arena or the one it was sealed from minted: no slot is ever recycled, so a
handle cannot come to name something else. A copy, so absent for a T that
carries Drop or @noCopy (see the module comment); `read` is the borrowing form.

### `GrowOnlyArena.holds`

```milo
fn GrowOnlyArena.holds(self: &GrowOnlyArena, h: Handle<T>): bool
```

Whether `h` names a slot here. Branch on this for a handle that might be foreign.

### `GrowOnlyArena.len`

```milo
fn GrowOnlyArena.len(self: &GrowOnlyArena): i64
```

Slots held; every one is live.

### `GrowOnlyArena.modifyMut`

```milo
fn GrowOnlyArena.modifyMut(self: &mut GrowOnlyArena, h: Handle<T>, f: (&mut T) => void): void
```

Mutate the value at `h` in place, without copying it out and back.

### `GrowOnlyArena.read`

```milo
fn GrowOnlyArena.read(self: &GrowOnlyArena, h: Handle<T>, f: (&T) => void): void
```

Borrow rather than copy. Prefer this when T owns heap storage.

### `GrowOnlyArena.set`

```milo
fn GrowOnlyArena.set(self: &mut GrowOnlyArena, h: Handle<T>, val: T): void
```

Overwrite the value at `h`.

Mutating a slot's CONTENTS is not what makes a handle stale — only recycling a
slot is, and this tier cannot recycle. So a graph whose nodes keep changing is
exactly the shape that belongs here, and locking it out would have left the tier
usable only by data that never moves.
