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

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

const STDLIB_SRC = `from "std/string" import { strStartsWith }

fn main() {
    let ok = strStartsWith("hello", "he")
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

// A user fn shadowing a prelude/std fn (strIndexOf) with a different signature.
// Must surface as a diagnostic squiggled on the fn name, not a dead file.
const SHADOW_SRC = `fn strIndexOf(s: &string, sub: &string, start: i64): i64 {
    return start
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
  for (const [uri, text] of [[STDLIB_URI, STDLIB_SRC], [RICH_URI, RICH_SRC], [MATCH_URI, MATCH_SRC], [BUILTIN_URI, BUILTIN_SRC], [PRIM_URI, PRIM_SRC], [GLOBAL_URI, GLOBAL_SRC], [IMPL_URI, IMPL_SRC], [ENUM_URI, ENUM_SRC], [METHOD_URI, METHOD_SRC], [SCOPE_URI, SCOPE_SRC], [SHADOW_URI, SHADOW_SRC], [ARRAY_URI, ARRAY_SRC]] as const) {
    await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "milo", version: 1, text } } });
  }
});

afterAll(() => { proc?.kill(); });

// strStartsWith is on line 4 (0-based 3), column 13.
const STDLIB_POS = { line: 3, character: 13 };

test("hover on imported stdlib symbol returns without hanging", async () => {
  const hover = await req(2, "textDocument/hover", { textDocument: { uri: STDLIB_URI }, position: STDLIB_POS });
  expect(hover?.contents?.value).toContain("strStartsWith");
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
});
