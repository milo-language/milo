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
}
`;
const BUILTIN_URI = "file:///tmp/milo-lsp-builtin.milo";

// Hover on a scalar primitive and on a raw pointer (`*u8`) at an FFI boundary.
const PRIM_SRC = `fn openPad(): *u8 {
    let n: i64 = 3
    let p: *u32 = 0 as *u32
    return 0 as *u8
}
`;
const PRIM_URI = "file:///tmp/milo-lsp-prim.milo";

let proc: Subprocess<"pipe", "pipe", "inherit">;
let buf = new Uint8Array(0);
const pending = new Map<number, (v: any) => void>();

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
  for (const [uri, text] of [[STDLIB_URI, STDLIB_SRC], [RICH_URI, RICH_SRC], [MATCH_URI, MATCH_SRC], [BUILTIN_URI, BUILTIN_SRC], [PRIM_URI, PRIM_SRC]] as const) {
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

test("goto-definition on imported stdlib symbol resolves to std/string.milo", async () => {
  const def = await req(3, "textDocument/definition", { textDocument: { uri: STDLIB_URI }, position: STDLIB_POS });
  expect(def?.uri).toContain("std/string.milo");
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
