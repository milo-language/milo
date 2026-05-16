# std/arena

Sometimes data points back at itself — a graph node linking to its neighbors, a tree with parent pointers, an entity system where objects reference each other. Ownership can't model this directly because there's no single owner.

An arena solves this. You put all your objects in one container and refer to them by **handle** — a lightweight ticket that says "slot 3, version 2." The arena owns the data; your code holds handles. When you free a slot and something later reuses it, stale handles don't silently return garbage — they return `None`. No dangling pointers, no use-after-free, no `unsafe`.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaFree, arenaSet, arenaModify, arenaValid, arenaLen }
```

## Quick start: a graph with cycles

The classic case — nodes that point to each other. Impossible with plain ownership, trivial with an arena.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaModify }

struct Node {
    name: string,
    neighbors: Vec<Handle<Node>>,
}

fn main(): i32 {
    var graph = arenaNew<Node>()

    let a = arenaAlloc(&graph, Node { name: "A", neighbors: Vec.new() })
    let b = arenaAlloc(&graph, Node { name: "B", neighbors: Vec.new() })
    let c = arenaAlloc(&graph, Node { name: "C", neighbors: Vec.new() })

    // wire up a cycle: A -> B -> C -> A
    arenaModify(&graph, a, (node: Node): Node => { node.neighbors.push(b); node })
    arenaModify(&graph, b, (node: Node): Node => { node.neighbors.push(c); node })
    arenaModify(&graph, c, (node: Node): Node => { node.neighbors.push(a); node })

    // traverse: start at A, follow first neighbor twice
    let nodeA = arenaGet(&graph, a)!
    let nodeB = arenaGet(&graph, nodeA.neighbors[0])!
    let nodeC = arenaGet(&graph, nodeB.neighbors[0])!
    print($"{nodeA.name} -> {nodeB.name} -> {nodeC.name}")  // A -> B -> C

    // free B, then try to access it — returns None, not garbage
    arenaFree(&graph, b)
    match arenaGet(&graph, b) {
        Option.Some(n) => print(n.name),
        Option.None => print("B was freed"),  // this prints
    }

    return 0
}
```

Handles are just integers — cheap to copy, cheap to store in a `Vec`. The generation counter is what keeps them safe.

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

Growable container that owns all values. Freed slots go onto the free list and get recycled by the next `arenaAlloc`.

## Functions

### arenaNew

```milo
fn arenaNew<T>(): Arena<T>
```

Create an empty arena.

### arenaAlloc

```milo
fn arenaAlloc<T>(arena: &Arena<T>, value: T): Handle<T>
```

Store a value, get a handle back. Reuses freed slots when available.

### arenaGet

```milo
fn arenaGet<T>(arena: &Arena<T>, handle: Handle<T>): Option<T>
```

Look up a value by handle. Returns `None` if the handle is stale or out of bounds.

### arenaSet

```milo
fn arenaSet<T>(arena: &Arena<T>, handle: Handle<T>, value: T): bool
```

Replace the value at a handle. Returns `false` if the handle is invalid.

### arenaModify

```milo
fn arenaModify<T>(arena: &Arena<T>, handle: Handle<T>, f: (T) => T): bool
```

Transform a value in place. Returns `false` if the handle is invalid.

### arenaFree

```milo
fn arenaFree<T>(arena: &Arena<T>, handle: Handle<T>): bool
```

Remove a value and recycle the slot. Returns `false` if already freed.

### arenaValid

```milo
fn arenaValid<T>(arena: &Arena<T>, handle: Handle<T>): bool
```

Check whether a handle still points to a live value.

### arenaLen

```milo
fn arenaLen<T>(arena: &Arena<T>): i64
```

Number of live values in the arena.
