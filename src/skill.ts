// `milo skill`: the agent guide. Loaded only by that subcommand, so the std scan below
// never runs on a compile. Every ```milo fence here is type-checked by
// tests/skillText.test.ts; the std module list is generated from each module's header
// comment, so it cannot name a module that no longer exists.
import { existsSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { STDLIB_DIR, readStd, bundledStdPaths } from "./stdlibBundle";

// One-line summary per std module, from the file's leading `// std/<name> — <what>`
// comment (or its first comment line when the header names no module). Platform arms
// (`event.darwin.milo`, `event.linux.milo`) collapse to one module.
export function stdModuleSummaries(): { module: string; summary: string }[] {
  const stdDir = resolve(STDLIB_DIR, "std");
  // Disk when present; otherwise the embedded bundle (a shipped `bun build --compile` binary).
  const files = existsSync(stdDir)
    ? readdirSync(stdDir).filter(f => f.endsWith(".milo") && !f.endsWith("_test.milo")).map(f => resolve(stdDir, f))
    : bundledStdPaths().filter(p => resolve(p, "..") === stdDir);
  const host = process.platform === "win32" ? "windows" : process.platform;
  const byModule = new Map<string, string>();
  // The host's platform arm describes the module as this machine builds it; any arm
  // with a header beats none (std/environ.linux has no header comment).
  const rank = (f: string) => f.endsWith(`.${host}.milo`) ? 0 : /\.(darwin|linux|windows|wasm)\.milo$/.test(f) ? 1 : 0;
  for (const file of files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const name = basename(file).replace(/\.milo$/, "").replace(/\.(darwin|linux|windows|wasm)$/, "");
    if (byModule.get(name)) continue;
    byModule.set(name, headerSummary(readStd(file) ?? "", name));
  }
  return [...byModule].sort(([a], [b]) => a.localeCompare(b)).map(([name, summary]) => ({ module: `std/${name}`, summary }));
}

function headerSummary(src: string, name: string): string {
  const para: string[] = [];
  for (const line of src.split("\n")) {
    const m = /^\/\/\s?(.*)$/.exec(line.trim());
    if (!m && line.trim() !== "") break;   // the header is the file's leading comment only
    if (!m || m[1]!.trim() === "") { if (para.length) break; else continue; }
    // A header wraps onto a lowercase continuation line; a capitalised next line is
    // implementation notes (std/json: "flat pool JSON parser" / "All nodes in one Vec").
    if (para.length && !/^[a-z(]/.test(m[1]!.trim())) break;
    para.push(m[1]!.trim());
  }
  let text = para.join(" ").replace(new RegExp(`^std/${name}\\s*(—|:|-)\\s*`), "");
  // First sentence only: several headers run on into implementation notes.
  const stop = text.search(/\.\s/);
  if (stop >= 0) text = text.slice(0, stop + 1);
  return text.replace(/\.$/, "");
}

export function renderSkill(): string {
  const modules = stdModuleSummaries().map(m => `- \`${m.module}\`: ${m.summary}`).join("\n");
  return SKILL_TEXT.replace("{{STD_MODULES}}", modules);
}

const SKILL_TEXT = `# Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references: no GC, no RC, no lifetime annotations.

## Compile & Run

\`\`\`bash
milo run file.milo              # compile + run (no artifacts)
milo build file.milo -o myapp   # compile to binary
milo check file.milo --json     # type-check only; diagnostics as JSON
milo fix file.milo              # apply every mechanical fix the checker reports
milo emit-ir file.milo          # emit LLVM IR
milo emit-hir file.milo         # typed HIR as JSON (every expr carries its type)
milo build file.milo --release  # -O3 optimized
milo explain <warning|@attr|kw> # what a warning/attribute/keyword means and how to fix it
\`\`\`

In a checkout of the compiler, \`bun run src/main.ts <args>\` is the same as \`milo <args>\`.

## Language Basics

\`\`\`milo
fn main(): i32 {
    print("hello")
    return 0
}
\`\`\`

### Variables
- \`let x = 42\`: immutable binding (cannot reassign)
- \`var x = 42\`: mutable binding
- Type inference works: \`let name = "milo"\` infers \`string\`

### Types
- Integers: \`i8\`, \`i16\`, \`i32\`, \`i64\`, \`u8\`, \`u16\`, \`u32\`, \`u64\`
- Floats: \`f32\`, \`f64\`
- \`bool\`, \`string\`, \`void\`
- \`Vec<T>\`, \`HashMap<K, V>\`, fixed arrays \`[T; N]\`, slices \`&[T]\`
- \`Option<T>\` (shorthand: \`T?\`), \`Result<T, E>\` (\`Result<T>\` means \`Result<T, string>\`)

### Functions
\`\`\`milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: &string): void {    // &T = shared borrow
    print($"hello, {name}!")
}

fn increment(x: &mut i64): void {  // &mut T = mutable borrow
    x = x + 1
}

// generics are monomorphized; type arguments are inferred
struct Pair<A, B> {
    first: A,
    second: B,
}

fn pairOf<A, B>(a: A, b: B): Pair<A, B> {
    return Pair { first: a, second: b }
}

fn main(): i32 {
    let name = "milo"
    greet(name)            // shared borrows are implicit: pass the value bare, never &name
    var n: i64 = 1
    increment(&mut n)      // a &mut argument is spelled &mut at the call site
    let p = pairOf(add(1, 2), "three")
    print($"{n} {p.first} {p.second}")
    return 0
}
\`\`\`

### Structs & Impl
\`\`\`milo
from "std/math" import { Math }

struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64): Point {
        return Point { x: x, y: y }
    }

    fn distance(self: &Self, other: &Point): f64 {
        let dx = self.x - other.x
        let dy = self.y - other.y
        return Math.sqrt(dx * dx + dy * dy)
    }
}

fn main(): i32 {
    let a = Point.new(0.0, 0.0)
    let b = Point.new(3.0, 4.0)
    print(a.distance(b))   // 5
    return 0
}
\`\`\`

### Enums & Match
\`\`\`milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Empty,
}

fn area(s: &Shape): f64 {
    return match s {
        Shape.Circle(r) => 3.14159 * r * r
        Shape.Rect(w, h) => w * h
        Shape.Empty => 0.0
    }
}
\`\`\`

### Option & Result
\`\`\`milo
fn find(items: &Vec<string>, target: &string): string? {
    for item in items {
        if item == target {
            return Option.Some(item.clone())
        }
    }
    return null   // sugar for Option.None
}

fn main(): i32 {
    var items: Vec<string> = Vec.new()
    items.push("key")
    // unwrap: expr!   propagate: expr?   default: expr ?? fallback
    let val = find(items, "key") ?? "default"
    print(val)
    return 0
}
\`\`\`

### Closures
\`\`\`milo
let double = (x: i32): i32 => x * 2
let result = double(21)
print(result)
\`\`\`

### Traits
\`\`\`milo
struct Point {
    x: f64,
    y: f64,
}

trait Display {
    fn display(self: &Self): string
}

impl Display for Point {
    fn display(self: &Self): string {
        return $"({self.x}, {self.y})"
    }
}

@derive(Eq)    // auto-derive equality
struct Id { value: i64 }
\`\`\`

### Imports
\`\`\`milo
from "std/fs" import { readFile, writeFile, isFile, isDir }
from "std/json" import { Json }
from "std/path" import { Path }
\`\`\`

\`from "<module>" import { a, b as c }\` is the only import form: no glob imports, and no
bare \`import "file"\`. A local file is imported by relative path the same way.

### Key Rules
- Move semantics: values have a single owner. After \`let y = x\`, using \`x\` is a compile error. Use \`.clone()\` for an explicit copy.
- References (\`&T\`, \`&mut T\`) are second-class: they appear as function parameters, are never stored in structs or collections, and free functions never return them. The one exception: a method may return a slice \`&[T]\` of its own receiver's storage.
- Shared borrows are implicit: pass the value bare (\`greet(name)\`); there is no \`&x\` expression. A \`&mut\` argument is written \`foo(&mut x)\` (method receivers stay implicit: \`v.push(1)\`).
- No null: use \`Option<T>\` (\`T?\`). \`null\` is sugar for \`Option.None\`.
- No exceptions: use \`Result<T, E>\` for fallible operations.
- No implicit conversions: use \`expr as Type\` for casts.
- Strings are owned UTF-8 byte buffers; a \`&string\` parameter borrows one.
- \`unsafe { ... }\` is required for raw pointers and FFI calls.
- String interpolation: \`$"hello {name}, count={count}"\`
- Statements are newline-delimited; a trailing \`;\` is allowed but \`milo fmt\` strips it.
- camelCase for functions/variables, PascalCase for types.
- Integer overflow, out-of-bounds indexing and failed unwraps trap; nothing wraps silently.

## Standard Library

Import with \`from "std/<name>" import { ... }\`. Don't guess names, look them up:

\`\`\`bash
milo api <terms>               # search std signatures by name and doc, ranked
milo api --module std/<name>   # one module's full API
milo api --json                # every std symbol as JSON
\`\`\`

Prelude names (\`Vec\`, \`HashMap\`, \`Option\`, \`Result\`, \`Heap\`, \`print\`, \`eprint\`) need no import.
Much of std is namespace objects: \`Math.sqrt(x)\`, \`Json.parse(s)\`, \`Path.join(a, b)\`, \`Uuid.v4()\`.

Modules (generated from each module's header):

{{STD_MODULES}}

## Argument Parsing (std/argparse)

This is the recommended way to build CLI tools:

\`\`\`milo
from "std/argparse" import { ArgParser }
from "std/fs" import { readFile }

fn main(): i32 {
    var parser = ArgParser.new("mytool", "process text files")
    parser.addPositional("file", "input file to process")
    parser.addOptionalPositional("output", "output path (default: stdout)")
    parser.addString("format", "f", "output format", "text")   // flag with default
    parser.addBool("verbose", "v", "enable verbose output")     // boolean flag
    parser.addI64("count", "n", "max items to process", 100)   // integer flag
    parser.addRequired("token", "t", "API token")              // required flag

    // parses the process arguments; handles --help and exits on a usage error
    let args = parser.parse()

    let file = args.getString("file") ?? ""
    let format = args.getString("format") ?? "text"
    let verbose = args.getBool("verbose")
    let count = args.getI64("count")
    print($"format={format} count={count}")

    if let Option.Some(out) = args.getString("output") {
        print(out)
    }

    match readFile(file) {
        Result.Ok(content) => {
            if verbose {
                print($"processing {file} ({content.len} bytes)")
            }
            print(content)
        }
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

\`\`\`bash
mytool input.txt --format json -v --token abc123
mytool --help    # prints auto-generated usage
\`\`\`

- Builders: \`addString(long, short, help, default)\`, \`addRequired(long, short, help)\`,
  \`addBool(long, short, help)\`, \`addI64(long, short, help, default)\`,
  \`addPositional(name, help)\`, \`addOptionalPositional(name, help)\`,
  \`enableTrailingArgs()\` (stop flag parsing after the first positional; \`--\` also ends flags).
- Parse: \`parse()\` from the process arguments, or \`parseFrom(argv)\` (argv[0] is the program name).
- Query: \`getString(name)\` returns \`Option<string>\` (\`None\` if not supplied and no default;
  \`--flag ""\` is \`Some("")\`), \`getI64\`, \`getU16\`, \`getBool\`, \`has(name)\`.

## Common Patterns

### Error Handling with Result
\`\`\`milo
from "std/fs" import { readFile }
from "std/io" import { IoError }

fn firstLine(path: &string): Result<string, IoError> {
    let content = readFile(path)?   // ? returns the Err to the caller
    let end = content.indexOf("\\n") ?? content.len
    return Result.Ok(content[0..end].clone())
}

fn main(): i32 {
    match firstLine("data.txt") {
        Result.Ok(line) => print(line)
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

### Vec Operations
\`\`\`milo
var items: Vec<string> = Vec.new()
items.push("three")
items.push("one")
items.push("two")
print($"count: {items.len}")   // 3
let first = items[0].clone()   // indexing borrows; clone to own a copy
for item in items {            // for-in borrows each element
    print(item)
}
\`\`\`

### HashMap
\`\`\`milo
var counts: HashMap<string, i64> = HashMap.new()
counts.insert("apples", 5)
counts.insert("oranges", 3)
if let Option.Some(n) = counts.get("apples") {
    print($"apples: {n}")
}
// iteration order is unspecified: never derive output order from a map
\`\`\`

### Green Tasks and Channels
\`\`\`milo
from "std/runtime" import { Task, Promise }
from "std/sync" import { Channel }

fn main(): i32 {
    let ch = Channel<i64>.new(1)!
    let tx = ch.clone()
    Task.spawn(move(): void => {        // green task on the scheduler
        tx.send(42)!
    })
    print($"got: {ch.recv()!}")

    // an OS thread for blocking or CPU-bound work
    let p = Promise<i64>.blocking(move(): i64 => {
        return 6 * 7
    })
    print($"computed: {p.await()!}")
    return 0
}
\`\`\`

### JSON
\`\`\`milo
from "std/json" import { Json }

@derive(Json)
struct Config {
    name: string,
    port: i64,
    debug: bool,
}

fn main(): i32 {
    let config = Config { name: "app", port: 8080, debug: false }
    let text = config.toJson()
    print(text)   // {"name":"app","port":8080,"debug":false}

    match Config.fromJson(text) {
        Result.Ok(back) => print(back.port)
        Result.Err(e) => print($"bad config: {e.message()}")
    }

    // untyped access
    let doc = Json.parse("{\\"port\\": 8080}")!
    if let Option.Some(port) = doc.get("port") {
        print(port.asI64() ?? 0)
    }
    return 0
}
\`\`\`

## What NOT to Do
- No garbage collector or reference counting: values are moved or cloned explicitly.
- Don't store references in structs or collections, or return them from free functions.
- Don't write \`&x\` to borrow: pass \`x\` bare; write \`&mut x\` only for a \`&mut\` argument.
- No raw pointers in safe code: \`unsafe { ... }\` for FFI and raw memory.
- No implicit type conversions: cast with \`as\`.
- No exceptions or try/catch: use \`Result<T, E>\` and \`?\` propagation.
- No null: use \`Option<T>\` (\`T?\`) and pattern match or \`??\` for defaults.
- No class inheritance: use traits and composition.
- Don't invent std names: \`milo api <terms>\` first.
`;
