# std/arena

Think of an arena like a parking garage. You drive your car in, get a ticket with a spot number. Later you hand in the ticket to get your car back. If the spot was reassigned since you parked, the garage tells you — it doesn't hand you someone else's car.

That's what an arena does for data. You store values, get back handles (tickets), and use those handles to access or update your data later. The arena owns everything; your code just holds handles.

This is useful when things need to reference each other — like nodes in a graph, entries in a cache, or entities in a game. Normal ownership can't model cycles (A owns B owns A?), but handles can.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaFree, arenaSet, arenaModify, arenaValid, arenaLen }
```

## Quick start

Store some values, get handles, look them up:

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaFree }

fn main(): i32 {
    var names = arenaNew<string>()

    let alice = arenaAlloc(&names, "Alice")   // store "Alice", get a handle back
    let bob = arenaAlloc(&names, "Bob")

    print(arenaGet(&names, alice)!)           // "Alice"
    print(arenaGet(&names, bob)!)             // "Bob"

    arenaFree(&names, alice)                  // remove Alice

    match arenaGet(&names, alice) {
        Option.Some(n) => print(n),
        Option.None => print("gone"),         // prints "gone" — handle is stale
    }

    return 0
}
```

Handles are just a slot number and a version counter. When a slot gets recycled, the version bumps — so old handles return `None` instead of garbage. No dangling pointers, no use-after-free, all checked at runtime.

## Example: a graph with cycles

The classic case — nodes that reference each other. Impossible with plain ownership (who owns whom?), straightforward with an arena.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaModify, arenaFree }

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

    return 0
}
```

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
