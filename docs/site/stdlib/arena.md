# std/arena

An arena stores values and gives back handles instead of pointers. You use a handle to access or update a value later. The arena owns everything; your code holds only handles. If a handle's slot was reused since you got the handle, lookup returns `None` rather than someone else's value.

This is useful when values need to reference each other, such as nodes in a graph, entries in a cache, or entities in a game. Normal ownership can't model cycles (A owns B owns A?), but handles can.

```milo
from "std/arena" import { Arena, Handle }
```

## Quick start

Store some values, get handles, look them up:

```milo
from "std/arena" import { Arena, Handle }

fn main(): i32 {
    var names: Arena<string> = Arena<string>.new()

    let alice = names.alloc("Alice")
    let bob = names.alloc("Bob")

    print(names.get(alice)!)              // "Alice"
    print(names.get(bob)!)                // "Bob"

    names.free(alice)

    match names.get(alice) {
        Option.Some(n) => { print(n) }
        Option.None => { print("gone") } // prints "gone" — handle is stale
    }

    return 0
}
```

## How it works

**One arena per data type.** An `Arena<string>` holds strings. An `Arena<Node>` holds nodes. You don't mix types in a single arena.

**The lifecycle is simple:**

1. **Create**: `var a = Arena<string>.new()`
2. **Store** — `a.alloc(value)` puts a value in and returns a `Handle<T>`
3. **Access** — `a.get(handle)` returns `Option<T>` — `Some` if alive, `None` if stale
4. **Update** — `.set()` replaces a value; `.modify()` transforms it with a function
5. **Remove** — `a.free(handle)` removes the value and recycles the slot

**Handles are cheap.** They contain an arena identity, slot index, and generation. Copy them freely, store them in Vecs, pass them around. They don't own anything — the arena does.

**Stale handles are safe.** Every slot has a generation counter that bumps on free. If you hold a handle from generation 2 but the slot is now on generation 3, `.get()` returns `None` instead of the wrong value. A generation that reaches its maximum retires the slot instead of wrapping onto an old handle.

**Live handles can be enumerated.** `a.handles()` returns a snapshot. Freeing or allocating after the call does not change that Vec; each returned handle is still generation-checked when used.

## Example: a graph with cycles

Nodes that reference each other. Plain ownership can't express a cycle (who owns whom?); an arena can.

```milo
from "std/arena" import { Arena, Handle }

struct Node {
    name: string,
    neighbors: Vec<Handle<Node>>,
}

fn main(): i32 {
    var graph: Arena<Node> = Arena<Node>.new()

    let a = graph.alloc(Node { name: "A", neighbors: Vec.new() })
    let b = graph.alloc(Node { name: "B", neighbors: Vec.new() })
    let c = graph.alloc(Node { name: "C", neighbors: Vec.new() })

    // wire up a cycle: A -> B -> C -> A
    // modifyMut hands the closure the stored value to change in place
    let _ = graph.modifyMut(a, (node: &mut Node): void => { node.neighbors.push(b) })
    let _ = graph.modifyMut(b, (node: &mut Node): void => { node.neighbors.push(c) })
    let _ = graph.modifyMut(c, (node: &mut Node): void => { node.neighbors.push(a) })

    // traverse: start at A, follow first neighbor twice
    let nodeA = graph.get(a)!
    let nodeB = graph.get(nodeA.neighbors[0])!
    let nodeC = graph.get(nodeB.neighbors[0])!
    print($"{nodeA.name} -> {nodeB.name} -> {nodeC.name}")  // A -> B -> C

    return 0
}
```

## Gotchas

**`.get()` returns a copy.** Changing the returned value doesn't update the arena. Use `.modifyMut()` or get/set:

```milo
var node = graph.get(handle)!
node.name = "changed"                   // changes your local copy, not the arena

// option 1: modifyMut (changes the stored value in place)
graph.modifyMut(handle, (n: &mut Node): void => { n.name = "changed" })

// option 2: get, change, set (explicit)
var node2 = graph.get(handle)!
node2.name = "changed"
graph.set(handle, node2)
```

**Handles are checked against their arena.** A `Handle<string>` from arena A still type-checks against arena B because both have the same element type, but every handle carries an arena identity. Arena B returns `None`/`false` instead of reading a coincidentally matching slot.

**Enumeration is a snapshot.** `a.handles()` allocates a Vec of the handles that are live at that moment. Later frees make entries stale, and later allocations do not appear in the existing snapshot. Keep your own handle Vec when you need a continuously maintained index.

**Memory grows, doesn't shrink.** Freed slots get recycled by the next `.alloc()`, but the backing storage never shrinks. Fine for most use cases — be aware if you're allocating millions and freeing most of them.

## Types

### Handle\<T\>

```milo
struct Handle<T> {
    arenaId: i64,
    index: i32,
    generation: i32,
}
```

A ticket to a slot in the arena. The `generation` field increments each time a slot is recycled, so a stale handle from a previous occupant won't match — you get `None` instead of someone else's data.

### Arena\<T\>

```milo
struct Arena<T> {
    id: i64,
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}
```

Growable container that owns all values. Freed slots go onto the free list and get recycled by the next `.alloc()`.

### .handles

```milo
fn handles(self: &Self): Vec<Handle<T>>
```

Return a snapshot of all currently live handles. The snapshot does not keep
slots alive; every use still checks arena identity and generation state.

### .new

```milo
fn new(): Arena<T>
```

Create an empty arena. `Arena<T>.new()` is the preferred spelling; the
`arenaNew<T>()` free function remains available for compatibility.

## Methods

### .alloc

```milo
fn alloc(self: &mut Self, value: T): Handle<T>
```

Store a value, get a handle back. Reuses freed slots when available.

### .get

```milo
fn get(self: &Self, handle: Handle<T>): Option<T>
```

Look up a value by handle. Returns `None` if the handle is stale or out of bounds.

### .set

```milo
fn set(self: &mut Self, handle: Handle<T>, value: T): bool
```

Replace the value at a handle. Returns `false` if the handle is invalid.

### .modify

```milo
fn modify(self: &mut Self, handle: Handle<T>, f: (T) => T): bool
```

Safe one-liner to update a value. The arena pulls the value out, hands it to your function, and stores back whatever you return. If the handle is stale, the function never runs and you get `false`.

```milo
// one-liner: safe even if handle is stale
arena.modify(handle, (n: Node): Node => { var m = n; m.name = "updated"; return m })
```

The parameter is immutable, so rebind it as a `var` to change it, and `return` the value to store back. To change the value in place instead, `.modifyMut()` hands your function a `&mut T`.

**Why not just get/set?** You can — but you have to handle the stale case yourself:

```milo
// equivalent, but more verbose
match arena.get(handle) {
    Option.Some(n) => {
        var m = n
        m.name = "updated"
        arena.set(handle, m)
    }
    Option.None => { /* stale handle */ }
}
```

Use `.modify()` when you want a quick update. Use get/set when you need more control over the stale-handle case.

### .free

```milo
fn free(self: &mut Self, handle: Handle<T>): bool
```

Remove a value and recycle the slot. Returns `false` if already freed.

### .valid

```milo
fn valid(self: &Self, handle: Handle<T>): bool
```

Check whether a handle still points to a live value.
