# std/arena

An arena stores values and gives back handles instead of pointers. You use a handle to access or update a value later. The arena owns everything; your code holds only handles. If a handle's slot was reused since you got the handle, lookup returns `None` rather than someone else's value.

This is useful when values need to reference each other, such as nodes in a graph, entries in a cache, or entities in a game. Normal ownership can't model cycles (A owns B owns A?), but handles can.

```milo
from "std/arena" import { Arena, Handle, arenaNew }
```

## Quick start

Store some values, get handles, look them up:

```milo
from "std/arena" import { Arena, Handle, arenaNew }

fn main(): i32 {
    var names: Arena<string> = arenaNew()

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

1. **Create** — `arenaNew()` with a type annotation: `var a: Arena<string> = arenaNew()`
2. **Store** — `a.alloc(value)` puts a value in and returns a `Handle<T>`
3. **Access** — `a.get(handle)` returns `Option<T>` — `Some` if alive, `None` if stale
4. **Update** — `.set()` replaces a value; `.modify()` transforms it with a function
5. **Remove** — `a.free(handle)` removes the value and recycles the slot

**Handles are cheap.** They're two integers (slot index + generation). Copy them freely, store them in Vecs, pass them around. They don't own anything — the arena does.

**Stale handles are safe.** Every slot has a generation counter that bumps on free. If you hold a handle from generation 2 but the slot is now on generation 3, `.get()` returns `None` instead of the wrong value.

## Example: a graph with cycles

Nodes that reference each other. Plain ownership can't express a cycle (who owns whom?); an arena can.

```milo
from "std/arena" import { Arena, Handle, arenaNew }

struct Node {
    name: string,
    neighbors: Vec<Handle<Node>>,
}

fn main(): i32 {
    var graph: Arena<Node> = arenaNew()

    let a = graph.alloc(Node { name: "A", neighbors: Vec.new() })
    let b = graph.alloc(Node { name: "B", neighbors: Vec.new() })
    let c = graph.alloc(Node { name: "C", neighbors: Vec.new() })

    // wire up a cycle: A -> B -> C -> A
    // modify takes a function: receive current value, return updated value
    graph.modify(a, (node: Node): Node => { node.neighbors.push(b); node })
    graph.modify(b, (node: Node): Node => { node.neighbors.push(c); node })
    graph.modify(c, (node: Node): Node => { node.neighbors.push(a); node })

    // traverse: start at A, follow first neighbor twice
    let nodeA = graph.get(a)!
    let nodeB = graph.get(nodeA.neighbors[0])!
    let nodeC = graph.get(nodeB.neighbors[0])!
    print($"{nodeA.name} -> {nodeB.name} -> {nodeC.name}")  // A -> B -> C

    return 0
}
```

## Gotchas

**`.get()` returns a copy.** Changing the returned value doesn't update the arena. Use `.modify()` or get/set:

```milo
let node = graph.get(handle)!
node.name = "changed"                   // changes your local copy, not the arena

// option 1: modify (safe one-liner)
graph.modify(handle, (n: Node): Node => { n.name = "changed"; n })

// option 2: get, change, set (explicit)
var node2 = graph.get(handle)!
node2.name = "changed"
graph.set(handle, node2)
```

**Handles aren't tied to a specific arena.** A `Handle<string>` from arena A will type-check against arena B if it's also an `Arena<string>`. You'll get `None` or the wrong value — not a compile error. Keep your arenas and handles organized.

**No iteration.** You can't walk all live values in an arena. If you need to visit everything, keep your handles in a `Vec<Handle<T>>` alongside the arena.

**Memory grows, doesn't shrink.** Freed slots get recycled by the next `.alloc()`, but the backing storage never shrinks. Fine for most use cases — be aware if you're allocating millions and freeing most of them.

## Types

### Handle\<T\>

```milo
struct Handle<T> {
    index: i32,
    generation: i32,
}
```

A ticket to a slot in the arena. The `generation` field increments each time a slot is recycled, so a stale handle from a previous occupant won't match — you get `None` instead of someone else's data.

### Arena\<T\>

```milo
struct Arena<T> {
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}
```

Growable container that owns all values. Freed slots go onto the free list and get recycled by the next `.alloc()`.

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
arena.modify(handle, (n: Node): Node => { n.name = "updated"; n })
```

The trailing `n` is required — your function returns the value to store back.

**Why not just get/set?** You can — but you have to handle the stale case yourself:

```milo
// equivalent, but more verbose
match arena.get(handle) {
    Option.Some(n) => {
        n.name = "updated"
        arena.set(handle, n)
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
