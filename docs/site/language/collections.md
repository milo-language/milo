# Collections

## Arrays

Fixed-size, stack-allocated, bounds-checked.

```milo
let arr = [10, 20, 30]
print(arr[0])
print(arr.len)

// Repeat syntax
let zeros = [0; 100]      // 100 zeros

// Mutable arrays
var buf: [u8; 8192] = [0; 8192]
buf[0] = 42
```

Out-of-bounds access is a runtime panic, not silent corruption.

## Vec\<T\>

Dynamic array that owns its elements. Freed when it goes out of scope.

```milo
var v: Vec<i32> = Vec.new()
v.push(10)
v.push(20)
v.push(30)

print(v[0])           // bounds-checked
print(v.len)

let last = v.pop()    // removes and returns last element
```

```milo
var names: Vec<string> = Vec.new()
names.push("Alice")
names.push("Bob")
print(names[0])
```

The annotation is optional: an unannotated `var v = Vec.new()` (or `Vec.withCapacity(n)`) infers its element type from the first `push`.

```milo
var xs = Vec.new()    // element type inferred below
xs.push(10)           // xs is Vec<i64> — the default int width
xs.push(20)
```

## HashMap\<K, V\>

Open-addressing hash table with FNV-1a hashing.

```milo
var m: HashMap<string, i32> = HashMap.new()
m.insert("hello", 42)
m.insert("world", 99)

print(m.len)

if m.contains("hello") {
    print("found it")
}

let val = m.get("hello")       // returns Option<i32>
if let Option.Some(v) = val {
    print("value: ", v)
}

m.remove("hello")
```

## Heap\<T\>

Single-owner heap pointer. Three use cases: recursive types, runtime polymorphism via interfaces, and values that need to outlive their creating scope.

### Recursive data structures

A struct or enum can't contain itself directly (infinite size). Wrap the recursive case in `Heap<T>` to make it pointer-sized.

```milo
enum Tree {
    Node(Heap<Tree>, Heap<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
}

let tree = Tree.Node(
    Heap(Tree.Leaf(1)),
    Heap(Tree.Leaf(2))
)
print(sum(tree))   // 3
```

### Runtime polymorphism

`Heap<Interface>` stores different concrete types behind one [interface](/language/traits#interfaces), so they can share a collection.

```milo
interface Shape {
    fn area(self: &Self): f64
}

struct Circle { radius: f64 }
impl Circle {
    fn area(self: &Self): f64 { return 3.14159 * self.radius * self.radius }
}

struct Square { side: f64 }
impl Square {
    fn area(self: &Self): f64 { return self.side * self.side }
}

fn main(): i32 {
    var shapes: Vec<Heap<Shape>> = Vec.new()
    shapes.push(Heap(Circle { radius: 5.0 }))
    shapes.push(Heap(Square { side: 4.0 }))
    for s in shapes {
        print(s.area())    // method calls go through the Heap, no `*`
    }
    return 0
}
```

### Dereference

Use `*` to read the value through a heap pointer:

```milo
let h = Heap(42)
print(*h)          // 42
```

## Heap\<T\> vs Arena\<T\>

`Heap<T>` is single-owner: one value, one pointer, freed on drop. [`Arena<T>`](/stdlib/arena) is pool-based: many values in one allocation, referenced by copyable handles. Use Arena when you have graphs, caches, or cycles where ownership doesn't form a tree.

| | `Heap<T>` | `Arena<T>` |
|---|---|---|
| Holds | one value | many values of one type |
| You keep | the owning pointer (moves) | a `Handle<T>` (copies) |
| Freed | when the owner goes out of scope | one slot with `free`, all when the arena goes out of scope |
| Stale access | ruled out at compile time | `get` returns `None` at runtime |
| Use for | recursive types, interface values | graphs, parent pointers, caches, cycles |
| Allocation | one per value | one growable buffer for all values |

All heap types (Vec, HashMap, Heap) auto-free when they go out of scope. No GC pauses, no `free()`, no `defer`.
