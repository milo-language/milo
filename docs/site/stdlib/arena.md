# std/arena

Generational arena for cyclic data structures with safe handle-based access.

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet, arenaFree, arenaSet, arenaModify, arenaValid, arenaLen }
```

## Types

### Handle\<T\>

```milo
struct Handle<T> {
    index: i32,
    generation: i32,
}
```

Opaque reference into an arena. The generation field prevents use-after-free — accessing a slot after it has been freed and reallocated returns `None` instead of stale data.

### Arena\<T\>

```milo
struct Arena<T> {
    data: Vec<T>,
    gens: Vec<i32>,
    freeList: Vec<i32>,
    live: i64,
}
```

Growable, generational arena. Freed slots are recycled via the free list.

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

Insert a value into the arena, returning a handle to it. Reuses freed slots when available.

### arenaGet

```milo
fn arenaGet<T>(arena: &Arena<T>, handle: Handle<T>): Option<T>
```

Retrieve the value at `handle`. Returns `None` if the handle is stale or out of bounds.

### arenaSet

```milo
fn arenaSet<T>(arena: &Arena<T>, handle: Handle<T>, value: T): bool
```

Replace the value at `handle`. Returns `false` if the handle is invalid.

### arenaModify

```milo
fn arenaModify<T>(arena: &Arena<T>, handle: Handle<T>, f: (T) => T): bool
```

Apply a transformation to the value at `handle` in place. Returns `false` if the handle is invalid.

### arenaFree

```milo
fn arenaFree<T>(arena: &Arena<T>, handle: Handle<T>): bool
```

Remove the value at `handle` and recycle the slot. Returns `false` if the handle is already invalid.

### arenaValid

```milo
fn arenaValid<T>(arena: &Arena<T>, handle: Handle<T>): bool
```

Check whether a handle still points to a live value.

### arenaLen

```milo
fn arenaLen<T>(arena: &Arena<T>): i64
```

Return the number of live values in the arena.

## Example: Graph Nodes

```milo
from "std/arena" import { Arena, Handle, arenaNew, arenaAlloc, arenaGet }
from "std/io" import { print }

struct Node {
    name: string,
    neighbors: Vec<Handle<Node>>,
}

fn main(): i32 {
    var graph = arenaNew<Node>()

    let a = arenaAlloc(&graph, Node { name: "A", neighbors: vecNew<Handle<Node>>() })
    let b = arenaAlloc(&graph, Node { name: "B", neighbors: vecNew<Handle<Node>>() })

    // Create a cycle: A -> B -> A
    arenaModify(&graph, a, (node: Node): Node => {
        vecPush(&node.neighbors, b)
        node
    })
    arenaModify(&graph, b, (node: Node): Node => {
        vecPush(&node.neighbors, a)
        node
    })

    match arenaGet(&graph, a) {
        Some(node) => print(node.name),  // "A"
        None => print("stale handle"),
    }

    return 0
}
```
