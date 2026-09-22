// milod LSP end-to-end tests: drive the real server over stdio JSON-RPC.
//
// Regression anchor: hover/goto-def on an imported stdlib symbol must not hang.
// std/os <-> std/runtime is a cyclic import; the transitive-import walkers in
// lsp.ts (findDocInImports / findInImportedFiles) used to recurse that cycle
// forever, pinning a CPU at 100%. The per-request timeout below fails if the
// spin ever returns. The rest exercise the Tier 1/2 capabilities.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

const STDLIB_SRC = `from "std/string" import { asciiIsDigit }

fn main() {
    let ok = asciiIsDigit(104)
}
`;
const STDLIB_URI = "file:///tmp/milo-lsp-regression.milo";

// Rich doc for outline/refs/rename/sighelp/codeaction/workspace-symbol.
const RICH_SRC = `struct Point {
    x: i32,
    y: i32,
}

fn add(a: i32, b: i32): i32 {
    return a + b
}

fn main() {
    let p = Point { x: 1, y: 2 }
    let s = add(p.x, p.y)
    unsafe { let z = 1 }
}
`;
const RICH_URI = "file:///tmp/milo-lsp-rich.milo";

// Two functions, each with its own param `a`. Renaming one must not touch the other:
// they are different bindings that merely share a name. The existing rename test only
// covers `add`, a unique global — the case a text-based rename gets right by luck.
const SCOPE_SRC = `fn f(a: i32): i32 {
    return a
}

fn g(a: i32): i32 {
    return a * 2
}
`;
const SCOPE_URI = "file:///tmp/milo-lsp-scope.milo";

// Hover on an enum-pattern payload binding (`n` in `Option.Some(n)`).
const MATCH_SRC = `struct Node {
    name: string,
}

fn nodeName(g: Option<Node>): string {
    match g {
        Option.Some(n) => {
            return n.name
        }
        Option.None => {
            return "<invalid>"
        }
    }
}
`;
const MATCH_URI = "file:///tmp/milo-lsp-match.milo";

// Hover on a builtin collection type and its static constructor.
const BUILTIN_SRC = `fn main() {
    let v: Vec<i32> = Vec.new()
    v.push(1)
    var w: Vec<i32> = Vec.new()
    let x = w.pop()
}
`;
const BUILTIN_URI = "file:///tmp/milo-lsp-builtin.milo";

// A user fn shadowing a prelude/std fn (asciiIsDigit) with a different signature.
// Must surface as a diagnostic squiggled on the fn name, not a dead file.
const SHADOW_SRC = `fn asciiIsDigit(ch: u8, extra: i64): bool {
    return extra > 0
}
`;
const SHADOW_URI = "file:///tmp/milo-lsp-shadow.milo";

// Goto-definition on a local impl-method call (`s.greet()`). Methods live in
// program.impls, not program.functions, so this used to resolve nowhere.
const IMPL_SRC = `struct Speaker {
    name: string,
}

impl Speaker {
    fn greet(self: &Speaker): string {
        return "hi " + self.name
    }
}

fn main() {
    let s = Speaker { name: "x" }
    let g = s.greet()
    print(g)
}
`;
const IMPL_URI = "file:///tmp/milo-lsp-impl.milo";

// Goto-definition on an enum variant (`Shape.Circle`). Clicking the variant
// used to resolve nowhere — only the enum name did.
const ENUM_SRC = `enum Shape {
    Circle(f64),
    Square(f64),
}

fn area(s: Shape): f64 {
    match s {
        Shape.Circle(r) => {
            return r
        }
        Shape.Square(w) => {
            return w
        }
    }
}
`;
const ENUM_URI = "file:///tmp/milo-lsp-enum.milo";

// Hover on a local inside an impl METHOD body (not a free fn). Method bodies
// live in program.impls, so the enclosing-fn scoping used to skip them and
// hover on any method local — including `if let` bindings — returned nothing.
const METHOD_SRC = `struct Store {
    n: i32,
}

impl Store {
    fn run(self: &Store) {
        let total = 42
        if let Option.Some(v) = firstOf() {
            print(v)
        }
    }
}

fn firstOf(): Option<i32> {
    return Option.Some(1)
}
`;
const METHOD_URI = "file:///tmp/milo-lsp-method.milo";

// Hover on a scalar primitive and on a raw pointer (`*u8`) at an FFI boundary.
const PRIM_SRC = `fn openPad(): *u8 {
    let n: i64 = 3
    let p: *u32 = 0 as *u32
    return 0 as *u8
}
`;
const PRIM_URI = "file:///tmp/milo-lsp-prim.milo";

// A `?&mut T` parameter and the binding its `let … else` unwrap produces. The binding
// escapes into the enclosing scope but comes from no pattern, so the pattern-binding
// hover path could not see it.
const NULLREF_SRC = `extern struct Bump {
    x: i32,
}

@externalLinkage
pub fn bumpX(b: ?&mut Bump): i32 {
    let p = b else {
        return -1
    }
    return p.x
}
`;
const NULLREF_URI = "file:///tmp/milo-lsp-nullref.milo";

// A C function-pointer field. `cfn` is a TypeKind the LSP had never had to print or
// complete against, and the field's restricted use rules run in the same checker the
// server drives on every keystroke.
const CFNFIELD_SRC = `extern struct Ops {
    read: (*u8, i32) => i32,
}

fn bump(_p: *u8, n: i32): i32 {
    return n + 1
}

pub fn main() {
    let ops = Ops {
        read: bump,
    }
    unsafe {
        print(ops.read(0 as *u8, 41))
    }
}
`;
const CFNFIELD_URI = "file:///tmp/milo-lsp-cfnfield.milo";

// `@parks` is a caller-facing contract (it decides whether a call is legal inside a
// for-in over a global), so hover shows it the way it shows `@pure`.
const PARKS_SRC = `@parks
fn pause(): void {
}

pub fn main() {
    pause()
}
`;
const PARKS_URI = "file:///tmp/milo-lsp-parks.milo";

// Hover on a global variable, both at its decl and at a reference in a fn.
const GLOBAL_SRC = `var ptr: *u8 = 0 as *u8

fn main(): i32 {
    print(ptr as i64)
    return 0
}
`;
const GLOBAL_URI = "file:///tmp/milo-lsp-global.milo";

// Hover on a fixed-array-typed local. The explicit-type path used to render
// `stmt.type.name` (the bare element `u8`), dropping the `[...; N]` wrapper.
const ARRAY_SRC = `fn main() {
    var ev: [u8; 64] = [0; 64]
    print(ev[0] as i64)
}
`;
const ARRAY_URI = "file:///tmp/milo-lsp-array.milo";

// Bare `embedFile(...)` — warns (bare-embedfile) with a quickfix that inserts the '@'.
const EMBED_SRC = `fn main() {
    let s = embedFile("a.txt")
    print(s)
}
`;
const EMBED_URI = "file:///tmp/milo-lsp-embed.milo";

// Member completion: `s.tr` on a string-typed local must offer the builtin
// method `trim()`. String ops are methods (not free fns), so this is the
// autocomplete path that replaces the old prelude-free-function completion.
const MEMBER_SRC = `fn main() {
    let s = "hello world"
    let t = s.tr
}
`;
const MEMBER_URI = "file:///tmp/milo-lsp-member.milo";

// Integer member completion. The wrapping/saturating/checked families are the only
// way to opt out of the default overflow trap, and until src/builtin-members.ts made
// one table the source of truth the LSP had no scalar table at all — the escape hatch
// was undiscoverable from the editor.
const INT_MEMBER_SRC = `fn main() {
    var n: i64 = 1
    let t = n.wrapp
}
`;
const INT_MEMBER_URI = "file:///tmp/milo-lsp-int-member.milo";

// Namespace completion: `Json.pa` must offer the static methods parse/parseJsonc
// (imported namespace-object API). Proves `Crypto.`, `Math.` etc. will complete too.
const NS_SRC = `from "std/json" import { Json }

fn main() {
    let d = Json.pa
}
`;
const NS_URI = "file:///tmp/milo-lsp-ns.milo";

// Keyword + extern hovers. A keyword carries no type and no declaration site, so every
// other hover path had nothing to say about `pub`/`extern`/`fn` — and the extern branch
// of the symbol lookup was skipped outright, so an FFI declaration hovered to nothing.
// `Edge.from` is here because `from` is a SOFT keyword: it must stay a field hover.
const KEYWORD_SRC = `pub extern fn sqlite3_open(filename: *u8, db: *u8): i32
extern fn malloc(size: u64): *u8

struct Edge {
    from: i32,
    to: i32,
}

pub fn main(): i32 {
    let n = 1
    for i in 0..2 {
        print(i)
    }
    let r = sqlite3_open("a.db", 0 as *u8)
    return 0
}
`;
const KEYWORD_URI = "file:///tmp/milo-lsp-keyword.milo";

// An off-by-default lint reaches the editor only through the project's milo.json, so this
// needs a real directory on disk rather than the in-memory /tmp URIs the other docs use.
const LINTS_DIR = mkdtempSync(join(tmpdir(), "milo-lsp-lints-"));
writeFileSync(join(LINTS_DIR, "milo.json"), `{ "name": "lspdemo", "version": "0.1.0", "lints": { "deny": ["single-variant-match"] } }\n`);
const LINTS_URI = `file://${join(LINTS_DIR, "main.milo")}`;
const LINTS_SRC = `fn sink(x: i64) { print(x.toString()) }

fn main() {
    let o = Option.Some(3)
    match o {
        Option.Some(s) => { sink(s) }
        Option.None => {}
    }
}
`;

// Inlay hints after the explicit-`&mut` rule: `bump(&mut p)` carries its own marker, so
// the only hint left is the `&mut self` receiver of `v.push(1)`, which stays implicit.
const INLAY_URI = "file:///tmp/milo-lsp-inlay.milo";
const INLAY_SRC = `struct P { n: i64 }
impl P {
    fn inc(self: &mut Self, by: i64): void { self.n = self.n + by }
}
fn bump(p: &mut P): void { p.n = p.n + 1 }
fn main(): i32 {
    var p = P { n: 1 }
    bump(&mut p)
    p.inc(2)
    return p.n as i32
}
`;

let proc: Subprocess<"pipe", "pipe", "inherit">;
let buf = new Uint8Array(0);
const pending = new Map<number, (v: any) => void>();
// Latest published diagnostics per document URI (server→client notifications).
const diagnosticsByUri = new Map<string, any[]>();

function frame(msg: any): Uint8Array {
  const body = JSON.stringify(msg);
  return new TextEncoder().encode(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
async function send(msg: any) { proc.stdin.write(frame(msg)); await proc.stdin.flush(); }

function pump() {
  while (true) {
    const s = new TextDecoder().decode(buf);
    const hi = s.indexOf("\r\n\r\n");
    if (hi < 0) break;
    const m = s.slice(0, hi).match(/Content-Length:\s*(\d+)/i);
    if (!m) { buf = buf.slice(hi + 4); continue; }
    const len = parseInt(m[1]);
    const start = hi + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(new TextDecoder().decode(buf.slice(start, start + len)));
    buf = buf.slice(start + len);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
    else if (msg.method === "textDocument/publishDiagnostics") { diagnosticsByUri.set(msg.params.uri, msg.params.diagnostics); }
  }
}

function req(id: number, method: string, params: any, timeoutMs = 4000): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms (import-cycle spin?)`)); }, timeoutMs);
    pending.set(id, (v) => { clearTimeout(t); resolve(v); });
    await send({ jsonrpc: "2.0", id, method, params });
  });
}

beforeAll(async () => {
  proc = spawn(["bun", "run", COMPILER, "lsp"], {
    cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  (async () => {
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length); buf = merged;
      pump();
    }
  })();
  await req(1, "initialize", { capabilities: {} });
  await send({ jsonrpc: "2.0", method: "initialized", params: {} });
  for (const [uri, text] of [[STDLIB_URI, STDLIB_SRC], [RICH_URI, RICH_SRC], [MATCH_URI, MATCH_SRC], [BUILTIN_URI, BUILTIN_SRC], [PRIM_URI, PRIM_SRC], [GLOBAL_URI, GLOBAL_SRC], [IMPL_URI, IMPL_SRC], [ENUM_URI, ENUM_SRC], [METHOD_URI, METHOD_SRC], [SCOPE_URI, SCOPE_SRC], [SHADOW_URI, SHADOW_SRC], [ARRAY_URI, ARRAY_SRC], [EMBED_URI, EMBED_SRC], [MEMBER_URI, MEMBER_SRC], [INT_MEMBER_URI, INT_MEMBER_SRC], [NS_URI, NS_SRC], [KEYWORD_URI, KEYWORD_SRC], [LINTS_URI, LINTS_SRC], [NULLREF_URI, NULLREF_SRC], [CFNFIELD_URI, CFNFIELD_SRC], [PARKS_URI, PARKS_SRC], [INLAY_URI, INLAY_SRC]] as const) {
    await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "milo", version: 1, text } } });
  }
});

afterAll(() => { proc?.kill(); });

// asciiIsDigit is on line 4 (0-based 3), column 13.
const STDLIB_POS = { line: 3, character: 13 };

test("hover on imported stdlib symbol returns without hanging", async () => {
  const hover = await req(2, "textDocument/hover", { textDocument: { uri: STDLIB_URI }, position: STDLIB_POS });
  expect(hover?.contents?.value).toContain("asciiIsDigit");
  expect(hover?.contents?.value).toContain("std/string");
});

test("hover on enum-pattern payload binding shows its type", async () => {
  // `n` in the pattern `Option.Some(n)` (line 6, char 20).
  const inPat = await req(20, "textDocument/hover", { textDocument: { uri: MATCH_URI }, position: { line: 6, character: 20 } });
  expect(inPat?.contents?.value).toContain("n:");
  expect(inPat?.contents?.value).toContain("Node");
  // `n` used in the arm body `return n.name` (line 7, char 19).
  const inBody = await req(21, "textDocument/hover", { textDocument: { uri: MATCH_URI }, position: { line: 7, character: 19 } });
  expect(inBody?.contents?.value).toContain("Node");
});

test("hover on a nullable-extern-ref unwrap binding shows the reference type", async () => {
  // `p` on the `let p = b else {` line, and again where the body reads it.
  const atBind = await req(60, "textDocument/hover", { textDocument: { uri: NULLREF_URI }, position: { line: 6, character: 8 } });
  expect(atBind?.contents?.value).toContain("&mut Bump");
  const inBody = await req(61, "textDocument/hover", { textDocument: { uri: NULLREF_URI }, position: { line: 9, character: 11 } });
  expect(inBody?.contents?.value).toContain("&mut Bump");
});

test("hover on a @parks fn leads with the attribute and glosses it", async () => {
  // `pause` at its call site (line 5, char 5).
  const hover = await req(78, "textDocument/hover", { textDocument: { uri: PARKS_URI }, position: { line: 5, character: 5 } });
  expect(hover?.contents?.value).toContain("@parks fn pause()");
  expect(hover?.contents?.value).toContain("may park the current green task");
});

test("hover and completion on a C function-pointer field do not crash", async () => {
  // hover on the field name at its declaration (line 1, char 5)
  const onDecl = await req(70, "textDocument/hover", { textDocument: { uri: CFNFIELD_URI }, position: { line: 1, character: 5 } });
  expect(onDecl === null || typeof onDecl?.contents?.value === "string").toBe(true);
  // hover on the receiver at the call site
  const onRecv = await req(71, "textDocument/hover", { textDocument: { uri: CFNFIELD_URI }, position: { line: 13, character: 15 } });
  expect(onRecv?.contents?.value).toContain("Ops");
  // member completion after `ops.` offers the field
  const comp = await req(72, "textDocument/completion", { textDocument: { uri: CFNFIELD_URI }, position: { line: 13, character: 18 } });
  // The server answers rather than throwing: a `cfn` member is a TypeKind the
  // completion walk had never seen, and an unhandled tag there kills the request.
  expect(Array.isArray(comp) || Array.isArray(comp?.items)).toBe(true);
  // and the server publishes no error for a legal use of the field
  const deadline = Date.now() + 4000;
  let diags: any[] | undefined;
  while (Date.now() < deadline) {
    diags = diagnosticsByUri.get(CFNFIELD_URI);
    if (diags) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect((diags ?? []).filter((d: any) => d.severity === 1)).toEqual([]);
});

test("hover on builtin Vec type and Vec.new constructor", async () => {
  // `Vec` in the annotation `Vec<i32>` (line 1, char 12).
  const onType = await req(22, "textDocument/hover", { textDocument: { uri: BUILTIN_URI }, position: { line: 1, character: 12 } });
  expect(onType?.contents?.value).toContain("Vec<T>");
  // `new` in `Vec.new()` (line 1, char 27).
  const onCtor = await req(23, "textDocument/hover", { textDocument: { uri: BUILTIN_URI }, position: { line: 1, character: 27 } });
  expect(onCtor?.contents?.value).toContain("Vec.new");
});

test("shadowing a stdlib fn with a different signature is a squiggled diagnostic", async () => {
  // Diagnostics are async notifications published after didOpen — poll briefly.
  const deadline = Date.now() + 4000;
  let diags: any[] | undefined;
  while (Date.now() < deadline) {
    diags = diagnosticsByUri.get(SHADOW_URI);
    if (diags && diags.length) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(diags && diags.length).toBeTruthy();
  const shadow = diags!.find(d => /shadows a standard-library function/.test(d.message));
  expect(shadow).toBeTruthy();
  // Squiggled on the fn name (`strIndexOf` starts at line 0, char 3), not floating at file top.
  expect(shadow.range.start.line).toBe(0);
  expect(shadow.range.start.character).toBe(3);
  // An error's internal code is sent, but only a warning name gets a doc link.
  expect(shadow.code).toBe("shadows-stdlib");
  expect(shadow.codeDescription).toBeUndefined();
});

test("a lint denied in milo.json is published, squiggled on the match keyword", async () => {
  const deadline = Date.now() + 4000;
  let diags: any[] | undefined;
  while (Date.now() < deadline) {
    diags = diagnosticsByUri.get(LINTS_URI);
    if (diags && diags.length) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const d = diags?.find((x: any) => /only acts on one variant/.test(x.message));
  expect(d).toBeTruthy();
  // `match` is on 0-based line 4, column 4, and the range covers the keyword, not the
  // whole-file fallback a span-less diagnostic collapses to (line 0, chars 0..1).
  expect(d.range.start).toEqual({ line: 4, character: 4 });
  expect(d.range.end).toEqual({ line: 4, character: 9 });
  expect(d.severity).toBe(1); // denied, so an error
  expect(d.message).toContain("if let Option.Some(s) = o");
  // The editor gets the name `--allow=` takes, linked to its generated reference entry.
  expect(d.code).toBe("single-variant-match");
  expect(d.codeDescription?.href).toEndWith("/language/warnings-and-errors#single-variant-match");
});

test("hover on builtin Vec instance methods (.push / .pop) shows a specialized sig", async () => {
  // `push` in `v.push(1)` (line 2, char 7) — element type resolved to i32.
  const onPush = await req(40, "textDocument/hover", { textDocument: { uri: BUILTIN_URI }, position: { line: 2, character: 7 } });
  expect(onPush?.contents?.value).toContain("Vec<i32>.push(value: i32)");
  // `pop` in `let x = w.pop()` (line 4, char 15) — returns Option of the element type.
  const onPop = await req(41, "textDocument/hover", { textDocument: { uri: BUILTIN_URI }, position: { line: 4, character: 15 } });
  expect(onPop?.contents?.value).toContain("Vec<i32>.pop(): Option<i32>");
});

test("hover on a raw pointer and a scalar primitive", async () => {
  // `u8` inside the `*u8` return type (line 0, char 15) — pointer explanation leads.
  const onPtr = await req(24, "textDocument/hover", { textDocument: { uri: PRIM_URI }, position: { line: 0, character: 15 } });
  expect(onPtr?.contents?.value).toContain("*u8");
  expect(onPtr?.contents?.value).toContain("unsafe");
  // `u32` inside `*u32` (line 2, char 12) — same pointer treatment as `*u8`.
  const onPtr32 = await req(26, "textDocument/hover", { textDocument: { uri: PRIM_URI }, position: { line: 2, character: 12 } });
  expect(onPtr32?.contents?.value).toContain("*u32");
  expect(onPtr32?.contents?.value).toContain("unsafe");
  // `i64` in a plain annotation (line 1, char 11) — scalar doc, no pointer note.
  const onScalar = await req(25, "textDocument/hover", { textDocument: { uri: PRIM_URI }, position: { line: 1, character: 11 } });
  expect(onScalar?.contents?.value).toContain("64-bit signed integer");
  expect(onScalar?.contents?.value).not.toContain("Raw pointer");
});

test("hover on a global variable shows its kind and type", async () => {
  // Reference in main: `    print(ptr as i64)` — `ptr` at line 3, char 11.
  const onRef = await req(27, "textDocument/hover", { textDocument: { uri: GLOBAL_URI }, position: { line: 3, character: 11 } });
  expect(onRef?.contents?.value).toContain("var ptr");
  expect(onRef?.contents?.value).toContain("*u8");
  // Decl site: `var ptr: *u8 …` — `ptr` at line 0, char 5.
  const onDecl = await req(28, "textDocument/hover", { textDocument: { uri: GLOBAL_URI }, position: { line: 0, character: 5 } });
  expect(onDecl?.contents?.value).toContain("var ptr");
  expect(onDecl?.contents?.value).toContain("*u8");
});

test("goto-definition on imported stdlib symbol resolves to std/string.milo", async () => {
  const def = await req(3, "textDocument/definition", { textDocument: { uri: STDLIB_URI }, position: STDLIB_POS });
  expect(def?.uri).toContain("std/string.milo");
});

test("goto-definition on a local impl-method call jumps to the method decl", async () => {
  // `    let g = s.greet()` — `greet` is on line 12 (0-based), char 16.
  const def = await req(30, "textDocument/definition", { textDocument: { uri: IMPL_URI }, position: { line: 12, character: 16 } });
  expect(def?.uri).toBe(IMPL_URI);
  // `impl Speaker { fn greet(...) }` — the `fn greet` line is 0-based line 5.
  expect(def?.range?.start?.line).toBe(5);
});

test("goto-definition on an enum variant jumps to the variant decl line", async () => {
  // `        Shape.Circle(r) => {` — `Circle` is on line 7 (0-based), char 14.
  const def = await req(31, "textDocument/definition", { textDocument: { uri: ENUM_URI }, position: { line: 7, character: 14 } });
  expect(def?.uri).toBe(ENUM_URI);
  // `    Circle(f64),` — the variant decl is 0-based line 1.
  expect(def?.range?.start?.line).toBe(1);
});

test("hover on a local and an if-let binding inside an impl method", async () => {
  // `        let total = 42` — `total` at line 6, char 12.
  const onLocal = await req(32, "textDocument/hover", { textDocument: { uri: METHOD_URI }, position: { line: 6, character: 12 } });
  expect(onLocal?.contents?.value).toContain("total");
  // `        if let Option.Some(v) = firstOf()` — `v` binding at line 7, char 27.
  const onBind = await req(33, "textDocument/hover", { textDocument: { uri: METHOD_URI }, position: { line: 7, character: 27 } });
  expect(onBind?.contents?.value).toContain("v");
});

test("documentSymbol lists top-level decls with nesting", async () => {
  const syms = await req(10, "textDocument/documentSymbol", { textDocument: { uri: RICH_URI } });
  const names = syms.map((s: any) => s.name);
  expect(names).toContain("Point");
  expect(names).toContain("add");
  expect(names).toContain("main");
  const point = syms.find((s: any) => s.name === "Point");
  expect(point.children.map((c: any) => c.name)).toEqual(["x", "y"]);
  // VS Code rejects the response unless selectionRange ⊆ range and child ⊆ parent.
  const inside = (a: any, b: any) =>
    (a.start.line > b.start.line || (a.start.line === b.start.line && a.start.character >= b.start.character)) &&
    (a.end.line < b.end.line || (a.end.line === b.end.line && a.end.character <= b.end.character));
  const walk = (s: any, parent: any) => {
    expect(inside(s.selectionRange, s.range)).toBe(true);
    if (parent) expect(inside(s.range, parent.range)).toBe(true);
    for (const c of s.children ?? []) walk(c, s);
  };
  for (const s of syms) walk(s, null);
});

test("references finds declaration and use sites", async () => {
  // `add` on the fn decl line (line 5, col 3)
  const refs = await req(11, "textDocument/references", { textDocument: { uri: RICH_URI }, position: { line: 5, character: 3 } });
  expect(refs.length).toBeGreaterThanOrEqual(2); // fn add + call site
  expect(refs.every((r: any) => r.uri === RICH_URI)).toBe(true);
});

test("rename produces edits for every occurrence", async () => {
  const edit = await req(12, "textDocument/rename", { textDocument: { uri: RICH_URI }, position: { line: 5, character: 3 }, newName: "plus" });
  expect(edit.changes[RICH_URI].length).toBeGreaterThanOrEqual(2);
  expect(edit.changes[RICH_URI].every((e: any) => e.newText === "plus")).toBe(true);
});

test("rename of a param stays inside its own function", async () => {
  // `a` on f's param (line 0, char 5). g's `a` is a different binding.
  const edit = await req(40, "textDocument/rename", { textDocument: { uri: SCOPE_URI }, position: { line: 0, character: 5 }, newName: "n" });
  const lines = (edit.changes[SCOPE_URI] ?? []).map((e: any) => e.range.start.line).sort();
  expect(lines).toEqual([0, 1]); // f's decl + f's use — NOT g's on lines 4/5
});

test("documentHighlight highlights occurrences in the file", async () => {
  // `Point` on the struct decl line (line 0, col 7)
  const hl = await req(13, "textDocument/documentHighlight", { textDocument: { uri: RICH_URI }, position: { line: 0, character: 7 } });
  expect(hl.length).toBeGreaterThanOrEqual(2); // struct Point + Point { ... }
});

test("signatureHelp reports the active signature and parameter", async () => {
  // inside add( |p.x, p.y ) on line 11; place cursor just after the open paren
  const line = RICH_SRC.split("\n")[11];
  const open = line.indexOf("add(") + 4;
  const help = await req(14, "textDocument/signatureHelp", { textDocument: { uri: RICH_URI }, position: { line: 11, character: open } });
  expect(help.signatures[0].label).toContain("add(a: i32, b: i32)");
  expect(help.activeParameter).toBe(0);
});

test("codeAction offers to remove an unnecessary unsafe block", async () => {
  const action = await req(15, "textDocument/codeAction", {
    textDocument: { uri: RICH_URI },
    range: { start: { line: 12, character: 0 }, end: { line: 12, character: 20 } },
    context: { diagnostics: [] },
  });
  expect(action.length).toBeGreaterThanOrEqual(1);
  expect(action[0].title).toContain("unsafe");
  const edit = action[0].edit.changes[RICH_URI][0];
  expect(edit.newText).toBe("let z = 1");
});

test("workspaceSymbol matches by substring across open docs", async () => {
  const syms = await req(16, "workspace/symbol", { query: "Poin" });
  expect(syms.map((s: any) => s.name)).toContain("Point");
});

test("hover on a fixed-array local keeps the [T; N] wrapper", async () => {
  // `ev` is on line 2 (0-based 1); 4-space indent + "var " → char 8.
  const hover = await req(17, "textDocument/hover", { textDocument: { uri: ARRAY_URI }, position: { line: 1, character: 8 } });
  expect(hover?.contents?.value).toContain("var ev: [u8; 64]");
  // Plain-English gloss so `[u8; 64]` isn't jargon + a mystery number.
  expect(hover?.contents?.value).toContain("64** × `u8`");
  expect(hover?.contents?.value).toContain("64 bytes");
  // A local fixed array is a stack allocation — say so (readers from GC langs don't know).
  expect(hover?.contents?.value).toContain("stack");
});

test("codeAction offers the '@embedFile' fix for the bare spelling", async () => {
  const action = await req(18, "textDocument/codeAction", {
    textDocument: { uri: EMBED_URI },
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 30 } },
    context: { diagnostics: [] },
  });
  const fix = action.find((a: any) => a.title.includes("@embedFile"));
  expect(fix).toBeDefined();
  const edit = fix.edit.changes[EMBED_URI][0];
  expect(edit.newText).toBe("@");
  // Pure insertion at the start of `embedFile` — nothing is replaced.
  expect(edit.range.start).toEqual(edit.range.end);
  expect(edit.range.start.line).toBe(1);
  expect(edit.range.start.character).toBe(12);
});

test("completion suggests the sigil spelling of embedFile", async () => {
  // Cursor after `embed` on the `let s = embedFile(...)` line (0-based line 1, char 17).
  const res = await req(19, "textDocument/completion", {
    textDocument: { uri: EMBED_URI }, position: { line: 1, character: 17 },
  });
  const item = res.items.find((i: any) => i.filterText === "embedFile");
  expect(item).toBeDefined();
  expect(item.label).toBe("@embedFile");
  expect(item.detail).toBe("compile-time builtin");
});

test("member completion offers builtin string methods (s.tr → trim)", async () => {
  // Cursor after `s.tr` on `    let t = s.tr` (0-based line 2, char 16).
  const res = await req(50, "textDocument/completion", {
    textDocument: { uri: MEMBER_URI }, position: { line: 2, character: 16 },
  });
  const labels = res.items.map((i: any) => i.label);
  expect(labels).toContain("trim");
  expect(labels).toContain("trimStart");
  expect(labels).toContain("trimEnd");
  // partial "tr" must filter out unrelated methods
  expect(labels).not.toContain("split");
  expect(labels.every((l: string) => l.startsWith("tr"))).toBe(true);
});

test("member completion offers builtin int methods (n.wrapp → wrappingAdd)", async () => {
  // Cursor after `n.wrapp` on `    let t = n.wrapp` (0-based line 2, char 19).
  const res = await req(61, "textDocument/completion", {
    textDocument: { uri: INT_MEMBER_URI }, position: { line: 2, character: 19 },
  });
  const labels = res.items.map((i: any) => i.label);
  expect(labels).toContain("wrappingAdd");
  expect(labels).toContain("wrappingSub");
  expect(labels).toContain("wrappingMul");
  expect(labels).not.toContain("checkedAdd");
});

test("namespace completion offers a type's static methods (Json.pa → parse)", async () => {
  // Cursor after `Json.pa` on `    let d = Json.pa` (0-based line 3, char 19).
  const res = await req(51, "textDocument/completion", {
    textDocument: { uri: NS_URI }, position: { line: 3, character: 19 },
  });
  const labels = res.items.map((i: any) => i.label);
  expect(labels).toContain("parse");
  expect(labels).toContain("parseJsonc");
  // filtered by "pa" — obj/arr must not appear
  expect(labels).not.toContain("obj");
  expect(labels.every((l: string) => l.startsWith("pa"))).toBe(true);
});

test("hover on the declaration keywords teaches them (pub / extern / fn / let / in)", async () => {
  const at = (id: number, line: number, character: number) =>
    req(id, "textDocument/hover", { textDocument: { uri: KEYWORD_URI }, position: { line, character } });

  const onPub = await at(70, 0, 1);
  expect(onPub?.contents?.value).toContain("file-private by default");
  expect(onPub?.contents?.value).toContain("@externalLinkage");

  const onExtern = await at(71, 0, 5);
  expect(onExtern?.contents?.value).toContain("outside** Milo");
  expect(onExtern?.contents?.value).toContain("unsafe");

  const onFn = await at(72, 0, 11);
  expect(onFn?.contents?.value).toContain("Declares a function");
  expect(onFn?.contents?.value).toContain("void");

  const onLet = await at(73, 9, 5);
  expect(onLet?.contents?.value).toContain("immutable");

  // `in` is a soft keyword — it earns the hover in for-loop position.
  const onIn = await at(74, 10, 10);
  expect(onIn?.contents?.value).toContain("loop variable");
});

test("a soft keyword used as an ordinary name keeps its own hover", async () => {
  // `from` as a struct field must hover as the field, not as import syntax.
  const onField = await req(75, "textDocument/hover", { textDocument: { uri: KEYWORD_URI }, position: { line: 4, character: 5 } });
  expect(onField?.contents?.value).toContain("Edge.from");
  expect(onField?.contents?.value).not.toContain("import");
});

test("hover on an extern declaration shows its signature and the unsafe rule", async () => {
  // The FFI symbol itself (`sqlite3_open`, line 0 char 18) — the extern branch of the
  // free-function lookup used to skip these entirely.
  const scalarRet = await req(76, "textDocument/hover", { textDocument: { uri: KEYWORD_URI }, position: { line: 0, character: 18 } });
  expect(scalarRet?.contents?.value).toContain("pub extern fn sqlite3_open(filename: *u8, db: *u8): i32");
  expect(scalarRet?.contents?.value).toContain("auto-coerces");
  expect(scalarRet?.contents?.value).toContain("C linker");

  // A pointer return forces `unsafe` at EVERY call site — say so, don't leave it to
  // trial and error.
  const ptrRet = await req(77, "textDocument/hover", { textDocument: { uri: KEYWORD_URI }, position: { line: 1, character: 12 } });
  expect(ptrRet?.contents?.value).toContain("extern fn malloc(size: u64): *u8");
  expect(ptrRet?.contents?.value).toContain("every call needs an `unsafe` block");
  // Not `pub` — the hover says so rather than staying silent about visibility.
  expect(ptrRet?.contents?.value).toContain("private");
});

test("inlay hints: a &mut self receiver gets a hint, an argument written &mut x does not", async () => {
  const hints = await req(90, "textDocument/inlayHint", {
    textDocument: { uri: INLAY_URI }, range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
  });
  const at = hints.map((h: any) => `${h.position.line}:${h.position.character}:${h.label}`);
  expect(at).toEqual(["8:4:&mut"]); // `p` of `p.inc(2)`; nothing on line 7's `bump(&mut p)`
});
