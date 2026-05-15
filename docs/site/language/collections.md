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

## Box\<T\>

Single-owner heap pointer. Useful for recursive data structures.

```milo
enum Tree {
    Node(Box<Tree>, Box<Tree>),
    Leaf(i32),
}

fn sum(t: Tree): i32 {
    match t {
        Tree.Leaf(n) => { return n }
        Tree.Node(left, right) => {
            return sum(*left) + sum(*right)
        }
    }
    return 0
}

let tree = Tree.Node(
    Box(Tree.Leaf(1)),
    Box(Tree.Leaf(2))
)
print(sum(tree))   // 3
```

All heap types (Vec, HashMap, Box) auto-free when they go out of scope. No GC pauses, no `free()`, no `defer`.

Next: [Strings →](./strings)
