# std/collections

Containers beyond `Vec` and `HashMap`: a priority queue, a double-ended queue, a sorted map, an insertion-ordered map, a counter, and binary search over a sorted `Vec`.

```milo
from "std/collections" import { BinaryHeap, Deque, SortedMap, OrderedMap, Counter, MapEntry, bisectLeft, bisectRight, insertSorted, nsmallest, nlargest, pushUnique }
```

| Type | What it is | Main operations | Cost |
|------|------------|-----------------|------|
| `BinaryHeap<T>` | priority queue, min-first by default (Python's `heapq`) | `push`, `pop`, `peek`, `fromVec`, `intoSortedVec` | push/pop O(log n), peek O(1), fromVec O(n) |
| `Deque<T>` | growable ring buffer | `pushFront`, `pushBack`, `popFront`, `popBack`, `get(i)`, `each` | amortized O(1) at both ends, O(1) index |
| `SortedMap<K, V>` | B-tree map in key order | `insert`, `get`, `remove`, `range`, `floor`, `ceil`, `first`, `last` | O(log n); range O(log n + visited) |
| `OrderedMap<K, V>` | hash map in insertion order (Python's `dict`) | `insert`, `get`, `remove`, `moveToEnd`, `popFirst`, `each` | amortized O(1) |
| `Counter<K>` | multiset of counts (Python's `Counter`) | `add`, `count`, `mostCommon(n)` | add O(1), mostCommon O(k + n log k) |

Bounded caches built on `OrderedMap` live in [std/cache](cache). Counting into a plain `HashMap` is `upsert` (in the prelude, see [below](#counting-into-a-hashmap)).

## Ordering

Ordered containers take a comparator `(a: &T, b: &T) => i64`, read by sign like `Vec.sortBy`: negative puts `a` first. The plain constructors (`BinaryHeap.new`, `BinaryHeap.fromVec`, `SortedMap.new`) and the bisect functions use `<`, which exists on integers, floats and strings. A struct has no `<`, so those forms are not available for it, and calling one says so; use `withCompare`:

```milo
from "std/collections" import { BinaryHeap }

struct Job {
    name: string,
    priority: i64,
}

fn main(): i32 {
    var jobs = BinaryHeap<Job>.withCompare(move (a: &Job, b: &Job): i64 => a.priority - b.priority)
    jobs.push(Job { name: "deploy", priority: 2 })
    jobs.push(Job { name: "page", priority: 1 })
    let first = jobs.pop()!
    print(first.name)                       // page

    // A max-heap is the reversed comparator.
    var top = BinaryHeap<i64>.withCompare(move (a: &i64, b: &i64): i64 => b - a)
    top.push(3)
    top.push(9)
    print(top.pop()!)                       // 9
    return 0
}
```

## Reading elements

Nothing here hands out a reference into its storage, because references are second-class. Reads come in two shapes:

- **Copying**: `get`, `peek`, `front`, `first`, `keys`, `toVec` return a copy. They are `@copyOut`, so they are not available when the element carries `Drop` or `@noCopy` (the copy would be a second owner of the resource).
- **Borrowing**: `each`, `range`, `read`, `modify` lend the element to a callback as `&T` or `&mut T`, and work for every element type.

```milo
from "std/collections" import { SortedMap }

fn main(): i32 {
    var temps = SortedMap<string, i64>.new()
    temps.insert("2026-10-01", 18)
    temps.insert("2026-10-02", 21)
    temps.insert("2026-10-09", 15)

    // Every entry with "2026-10-01" <= key < "2026-10-08", in key order.
    var total: i64 = 0
    temps.range("2026-10-01", "2026-10-08", (day: &string, t: &i64): void => {
        total += t
    })
    print(total)                            // 39
    print(temps.floor("2026-10-05")!)       // 2026-10-02
    let _bumped = temps.modify("2026-10-09", (t: &mut i64): void => {
        t += 1
    })
    return 0
}
```

Every container owns its elements and drops each exactly once: a popped or removed value moves to the caller, and `clear` or the container's own drop releases the rest.

## Deque

```milo
from "std/collections" import { Deque }

fn main(): i32 {
    var q = Deque<string>.new()
    q.pushBack("b")
    q.pushBack("c")
    q.pushFront("a")
    q.each((s: &string): void => {
        print(s)                            // a, b, c
    })
    print(q.get(1)!)                        // b
    print(q.popFront()!)                    // a
    print(q.popBack()!)                     // c
    return 0
}
```

## OrderedMap and Counter

`OrderedMap` iterates in insertion order; re-inserting a key replaces its value in place, `moveToEnd` re-queues it and `popFirst` takes the oldest entry. `Counter` is built on it, so `mostCommon` breaks ties by first appearance, as Python's does.

```milo
from "std/collections" import { Counter }

fn main(): i32 {
    var words = Counter<string>.new()
    for w in "to be or not to be".split(" ") {
        words.add(w)
    }
    print(words.count("to"))                // 2
    for e in words.mostCommon(2) {
        print($"{e.key} {e.value}")         // to 2, be 2
    }
    return 0
}
```

## Counting into a HashMap

`HashMap` has no `entry` returning a `&mut V` (a reference cannot be returned), so the update is passed in. `upsert(key, init, f)` runs `f` on the stored value, inserting `init` first when the key is absent, in one call that takes the key once:

```milo
fn main(): i32 {
    var counts: HashMap<string, i64> = HashMap.new()
    for w in "a b a".split(" ") {
        counts.upsert(w, 0, (c: &mut i64): void => {
            c += 1
        })
    }
    print(counts.getOrDefault("a", 0))      // 2

    // setdefault: a copy of the stored value, inserting the default when absent.
    var seen: HashMap<string, i64> = HashMap.new()
    print(seen.getOrInsert("x", 7))         // 7
    return 0
}
```

That replaces `m.insert(k, (m.get(k) ?? 0) + 1)`, which moves `k` into `insert` before `get` reads it. `modify` and `getOrInsertWith` remain for the update-only and insert-only halves.

## bisect and heapq helpers

`bisectLeft` and `bisectRight` find the insertion point for `x` in an ascending `Vec` in O(log n), before or after the elements equal to it; `insertSorted` inserts there. The `Vec` must already be sorted. `nsmallest` and `nlargest` copy out the n extreme elements, sorted.

```milo
from "std/collections" import { bisectLeft, bisectRight, insertSorted, nlargest }

fn main(): i32 {
    var v: Vec<i64> = [1, 3, 3, 7]
    print(bisectLeft(v, 3))                 // 1
    print(bisectRight(v, 3))                // 3
    insertSorted(&mut v, 5)                 // [1, 3, 3, 5, 7]
    print(nlargest(v, 2))                   // [7, 5]
    return 0
}
```

## pushUnique

`pushUnique(&mut v, x)` pushes `x` unless an element `==` to it is already there and returns whether it pushed: an ordered set in a `Vec`, first-seen order kept. It is O(n) per call, so keep a `HashSet` beside the Vec once it holds more than a few hundred elements. It works for any `T` with `==`, including an Eq struct, which `v.contains(x)` (scalars only) does not.

```milo
from "std/collections" import { pushUnique }

fn main(): i32 {
    var tags: Vec<string> = []
    for t in ["rust", "go", "rust"] {
        pushUnique(&mut tags, t)
    }
    print(tags.join(","))                  // rust,go
    return 0
}
```

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/collections*.milo. -->

## API reference

### `BinaryHeap`

```milo
pub struct BinaryHeap<T>
```

A priority queue: `pop` always returns the smallest element under the heap's
comparator, so the default is a min-heap (Python's heapq). For a max-heap pass
a reversed comparator: `BinaryHeap<i64>.withCompare(move (a: &i64, b: &i64): i64 => b - a)`.

push and pop are O(log n), peek O(1), fromVec O(n). Named BinaryHeap because
`Heap<T>` is the builtin owning box.

Fields: `data: Vec<T>`, `cmp: move (&T, &T) => i64`.

#### `BinaryHeap.clear`

```milo
fn BinaryHeap.clear(self: &mut BinaryHeap): void
```

Drop every element, keeping the storage's capacity.

#### `BinaryHeap.fromVec`

```milo
fn BinaryHeap.fromVec(items: Vec<T>): BinaryHeap<T>
```

Build a min-heap from `items` in O(n) (Floyd's heapify), taking ownership.

#### `BinaryHeap.fromVecWith`

```milo
fn BinaryHeap.fromVecWith(items: Vec<T>, cmp: move (&T, &T) => i64): BinaryHeap<T>
```

Build a heap ordered by `cmp` from `items` in O(n), taking ownership.

#### `BinaryHeap.intoSortedVec`

```milo
fn BinaryHeap.intoSortedVec(self: BinaryHeap): Vec<T>
```

Consume the heap into a Vec in pop order (ascending for the default
min-heap). O(n log n).

#### `BinaryHeap.isEmpty`

```milo
fn BinaryHeap.isEmpty(self: &BinaryHeap): bool
```

True when there are no elements.

#### `BinaryHeap.len`

```milo
fn BinaryHeap.len(self: &BinaryHeap): i64
```

Number of elements.

#### `BinaryHeap.new`

```milo
fn BinaryHeap.new(): BinaryHeap<T>
```

An empty min-heap in the natural order of `<` (integers, floats, strings).

A generic static takes its type argument: `BinaryHeap<i64>.new()`.

#### `BinaryHeap.peek`

```milo
fn BinaryHeap.peek(self: &BinaryHeap): Option<T>
```

A copy of the element `pop` would return, without removing it. O(1).

#### `BinaryHeap.pop`

```milo
fn BinaryHeap.pop(self: &mut BinaryHeap): Option<T>
```

Remove and return the first element under the comparator, or None when
empty. O(log n).

#### `BinaryHeap.push`

```milo
fn BinaryHeap.push(self: &mut BinaryHeap, item: T): void
```

Add an element. O(log n).

#### `BinaryHeap.withCompare`

```milo
fn BinaryHeap.withCompare(cmp: move (&T, &T) => i64): BinaryHeap<T>
```

An empty heap ordered by `cmp`; `pop` returns the element `cmp` puts first.

### `Counter`

```milo
pub struct Counter<K>
```

A multiset that counts how often each key was added (Python's collections.Counter).
Built on OrderedMap, so `mostCommon` breaks ties by first appearance, as Python does,
instead of by the run-to-run hash order a HashMap would give.

Fields: `counts: OrderedMap<K, i64>`.

#### `Counter.add`

```milo
fn Counter.add(self: &mut Counter, key: K): void
```

Count one more `key`. Amortized O(1).

#### `Counter.count`

```milo
fn Counter.count(self: &Counter, key: &K): i64
```

How many times `key` was added; 0 when never.

#### `Counter.len`

```milo
fn Counter.len(self: &Counter): i64
```

Number of distinct keys.

#### `Counter.mostCommon`

```milo
fn Counter.mostCommon(self: &Counter, n: i64): Vec<MapEntry<K, i64>>
```

The `n` most frequent keys with their counts, most frequent first; ties keep
first-appearance order. A negative `n` returns every key. O(k + n log k) for k
distinct keys.

#### `Counter.new`

```milo
fn Counter.new(): Counter<K>
```

An empty counter.

A generic static takes its type argument: `Counter<string>.new()`.

### `Deque`

```milo
pub struct Deque<T>
```

A double-ended queue on a growable ring buffer: push and pop at either end in
amortized O(1), indexed reads in O(1). Index 0 is the front.

Iterate in order with `each` (borrows every element) or snapshot with `toVec`.

Fields:

- `buf: Vec<Option<T>>`: Ring storage; a slot outside [head, head + count) is None. Option rather than raw memory so the empty slots need no unsafe and drop as no-ops.
- `head: i64`
- `count: i64`

#### `Deque.back`

```milo
fn Deque.back(self: &Deque): Option<T>
```

A copy of the back element, or None when empty.

#### `Deque.clear`

```milo
fn Deque.clear(self: &mut Deque): void
```

Drop every element, keeping the ring's capacity.

#### `Deque.each`

```milo
fn Deque.each(self: &Deque, f: (&T) => void): void
```

Call `f` on every element from front to back, borrowed.

#### `Deque.front`

```milo
fn Deque.front(self: &Deque): Option<T>
```

A copy of the front element, or None when empty.

#### `Deque.get`

```milo
fn Deque.get(self: &Deque, i: i64): Option<T>
```

A copy of element `i` counted from the front, or None when `i` is outside
0..len. O(1).

#### `Deque.isEmpty`

```milo
fn Deque.isEmpty(self: &Deque): bool
```

True when there are no elements.

#### `Deque.len`

```milo
fn Deque.len(self: &Deque): i64
```

Number of elements.

#### `Deque.modify`

```milo
fn Deque.modify(self: &mut Deque, i: i64, f: (&mut T) => void): bool
```

Run `f` on element `i` in place; false (and `f` not run) when `i` is outside
0..len.

#### `Deque.new`

```milo
fn Deque.new(): Deque<T>
```

An empty deque. No allocation until the first push.

A generic static takes its type argument: `Deque<string>.new()`.

#### `Deque.popBack`

```milo
fn Deque.popBack(self: &mut Deque): Option<T>
```

Remove and return the back element, or None when empty. O(1).

#### `Deque.popFront`

```milo
fn Deque.popFront(self: &mut Deque): Option<T>
```

Remove and return the front element, or None when empty. O(1).

#### `Deque.pushBack`

```milo
fn Deque.pushBack(self: &mut Deque, item: T): void
```

Append at the back. Amortized O(1).

#### `Deque.pushFront`

```milo
fn Deque.pushFront(self: &mut Deque, item: T): void
```

Prepend at the front. Amortized O(1).

#### `Deque.toVec`

```milo
fn Deque.toVec(self: &Deque): Vec<T>
```

A copy of the elements from front to back.

#### `Deque.withCapacity`

```milo
fn Deque.withCapacity(capacity: i64): Deque<T>
```

An empty deque with room for `capacity` elements before it grows.

### `MapEntry`

```milo
pub struct MapEntry<K, V>
```

A key and its value, as `OrderedMap.popFirst` and `Counter.mostCommon` hand them out.

Fields: `key: K`, `value: V`.

### `OrderedMap`

```milo
pub struct OrderedMap<K, V>
```

A hash map that remembers insertion order (Python's dict, an "index map"): get,
insert, remove and moveToEnd in amortized O(1), iteration in insertion order.
Re-inserting an existing key replaces its value and keeps its position.

Each key is stored twice (the index and the slot), so insert clones a new key once.

Fields:

- `index: HashMap<K, i64>`: Key -> slot position.
- `slotKeys: Vec<Option<K>>`: Slots in insertion order; a removed entry leaves a None tombstone until the next compaction, which is what keeps remove O(1).
- `slotVals: Vec<Option<V>>`
- `head: i64`: No live slot sits before this position (popFirst advances it).
- `live: i64`

#### `OrderedMap.clear`

```milo
fn OrderedMap.clear(self: &mut OrderedMap): void
```

Drop every entry.

#### `OrderedMap.contains`

```milo
fn OrderedMap.contains(self: &OrderedMap, key: &K): bool
```

Whether `key` is present. O(1).

#### `OrderedMap.each`

```milo
fn OrderedMap.each(self: &OrderedMap, f: (&K, &V) => void): void
```

Call `f` on every entry in insertion order, borrowed.

#### `OrderedMap.get`

```milo
fn OrderedMap.get(self: &OrderedMap, key: &K): Option<V>
```

A copy of the value under `key`, or None. O(1).

#### `OrderedMap.insert`

```milo
fn OrderedMap.insert(self: &mut OrderedMap, key: K, value: V): void
```

Insert `key` at the end, or replace its value (dropping the old one) and keep
its position when it is already present. Amortized O(1).

#### `OrderedMap.isEmpty`

```milo
fn OrderedMap.isEmpty(self: &OrderedMap): bool
```

True when there are no elements.

#### `OrderedMap.keys`

```milo
fn OrderedMap.keys(self: &OrderedMap): Vec<K>
```

A copy of every key, in insertion order.

#### `OrderedMap.len`

```milo
fn OrderedMap.len(self: &OrderedMap): i64
```

Number of entries.

#### `OrderedMap.modify`

```milo
fn OrderedMap.modify(self: &mut OrderedMap, key: &K, f: (&mut V) => void): bool
```

Run `f` on the value under `key` in place; false (and `f` not run) when the
key is absent. Does not change the key's position.

#### `OrderedMap.moveToEnd`

```milo
fn OrderedMap.moveToEnd(self: &mut OrderedMap, key: &K): bool
```

Move `key` to the end of the order, as if it had just been inserted; false
when absent. Amortized O(1).

#### `OrderedMap.new`

```milo
fn OrderedMap.new(): OrderedMap<K, V>
```

An empty map.

A generic static takes its type arguments: `OrderedMap<string, i64>.new()`.

#### `OrderedMap.popFirst`

```milo
fn OrderedMap.popFirst(self: &mut OrderedMap): Option<MapEntry<K, V>>
```

Remove and return the oldest entry, or None when empty. Amortized O(1).

#### `OrderedMap.read`

```milo
fn OrderedMap.read(self: &OrderedMap, key: &K, f: (&V) => void): bool
```

Run `f` on the value under `key`, borrowed; false (and `f` not run) when the
key is absent. The read that works for every V, including one carrying Drop.

#### `OrderedMap.remove`

```milo
fn OrderedMap.remove(self: &mut OrderedMap, key: &K): Option<V>
```

Remove `key` and hand back its value, or None when absent. Amortized O(1).

#### `OrderedMap.values`

```milo
fn OrderedMap.values(self: &OrderedMap): Vec<V>
```

A copy of every value, in insertion order.

### `SortedMap`

```milo
pub struct SortedMap<K, V>
```

A map that keeps its keys sorted: get, insert and remove in O(log n), in-order
iteration, range queries and floor/ceil lookups.

It is a B-tree rather than a balanced binary tree: each node keeps up to 15 keys in
a Vec, so a lookup touches about log16(n) nodes and binary-searches a contiguous
run in each, where a red-black or AVL tree chases log2(n) separate allocations.
Nodes live in one arena Vec and point at each other by index, which needs no
unsafe and no Heap per node.

Fields:

- `nodes: Vec<BNode<K, V>>`
- `free: Vec<i64>`: Indices of nodes a merge emptied, reused before the arena grows.
- `root: i64`
- `count: i64`
- `cmp: move (&K, &K) => i64`

#### `SortedMap.ceil`

```milo
fn SortedMap.ceil(self: &SortedMap, key: &K): Option<K>
```

A copy of the smallest key >= `key`, or None. O(log n).

#### `SortedMap.clear`

```milo
fn SortedMap.clear(self: &mut SortedMap): void
```

Drop every entry.

#### `SortedMap.contains`

```milo
fn SortedMap.contains(self: &SortedMap, key: &K): bool
```

Whether `key` is present. O(log n).

#### `SortedMap.each`

```milo
fn SortedMap.each(self: &SortedMap, f: (&K, &V) => void): void
```

Call `f` on every entry in ascending key order, borrowed. O(n).

#### `SortedMap.first`

```milo
fn SortedMap.first(self: &SortedMap): Option<K>
```

A copy of the smallest key, or None when empty. O(log n).

#### `SortedMap.floor`

```milo
fn SortedMap.floor(self: &SortedMap, key: &K): Option<K>
```

A copy of the largest key &lt;= `key`, or None. O(log n).

#### `SortedMap.get`

```milo
fn SortedMap.get(self: &SortedMap, key: &K): Option<V>
```

A copy of the value under `key`, or None. O(log n).

#### `SortedMap.insert`

```milo
fn SortedMap.insert(self: &mut SortedMap, key: K, value: V): void
```

Insert or replace the value under `key`; a replaced value is dropped. O(log n).

#### `SortedMap.isEmpty`

```milo
fn SortedMap.isEmpty(self: &SortedMap): bool
```

True when there are no elements.

#### `SortedMap.keys`

```milo
fn SortedMap.keys(self: &SortedMap): Vec<K>
```

A copy of every key, ascending.

#### `SortedMap.last`

```milo
fn SortedMap.last(self: &SortedMap): Option<K>
```

A copy of the largest key, or None when empty. O(log n).

#### `SortedMap.len`

```milo
fn SortedMap.len(self: &SortedMap): i64
```

Number of entries.

#### `SortedMap.modify`

```milo
fn SortedMap.modify(self: &mut SortedMap, key: &K, f: (&mut V) => void): bool
```

Run `f` on the value under `key` in place; false (and `f` not run) when the
key is absent. O(log n).

#### `SortedMap.new`

```milo
fn SortedMap.new(): SortedMap<K, V>
```

An empty map ordered by the natural order of `<` on K (integers, floats,
strings).

A generic static takes its type arguments: `SortedMap<string, i64>.new()`.

#### `SortedMap.range`

```milo
fn SortedMap.range(self: &SortedMap, lo: &K, hi: &K, f: (&K, &V) => void): void
```

Call `f` on every entry with `lo <= key < hi`, in ascending key order,
borrowed. O(log n + entries visited).

#### `SortedMap.remove`

```milo
fn SortedMap.remove(self: &mut SortedMap, key: &K): Option<V>
```

Remove `key` and hand back its value, or None when absent. O(log n).

#### `SortedMap.values`

```milo
fn SortedMap.values(self: &SortedMap): Vec<V>
```

A copy of every value, in ascending key order.

#### `SortedMap.withCompare`

```milo
fn SortedMap.withCompare(cmp: move (&K, &K) => i64): SortedMap<K, V>
```

An empty map ordered by `cmp`; two keys are the same key when `cmp` returns 0.

### Functions

#### `bisectLeft`

```milo
pub fn bisectLeft<T>(v: &Vec<T>, x: &T): i64
```

The first index at which `x` could be inserted into the ascending `v` and keep
it sorted: before any element equal to `x` (Python's bisect_left). O(log n).

`v` must already be sorted ascending by `<`; on an unsorted Vec the answer is
some index in 0..=len, not an error.

#### `bisectRight`

```milo
pub fn bisectRight<T>(v: &Vec<T>, x: &T): i64
```

Like bisectLeft, but after any element equal to `x` (Python's bisect_right).

#### `insertSorted`

```milo
pub fn insertSorted<T>(v: &mut Vec<T>, x: T): void
```

Insert `x` into the ascending `v`, after any equal elements (Python's
insort_right). O(log n) to find the slot, O(n) to shift.

#### `nlargest`

```milo
pub fn nlargest<T>(items: &Vec<T>, n: i64): Vec<T>
```

The `n` largest elements of `items`, descending (Python's heapq.nlargest).
Copies the elements; `items` is untouched. O(m + n log m) for m items.

#### `nsmallest`

```milo
pub fn nsmallest<T>(items: &Vec<T>, n: i64): Vec<T>
```

The `n` smallest elements of `items`, ascending (Python's heapq.nsmallest).
Copies the elements; `items` is untouched. O(m + n log m) for m items.

#### `pushUnique`

```milo
pub fn pushUnique<T>(v: &mut Vec<T>, x: T): bool
```

Push `x` unless an element `==` to it is already there: a small ordered set that keeps
first-seen order. True when `x` was pushed. O(n) per call, so for more than a few
hundred elements keep a HashSet beside the Vec.

Unlike `v.contains(x)`, which compares scalars only, this works for any `T` with `==`,
including a struct that implements Eq.

<!-- /generated:api -->
