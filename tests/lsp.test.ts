// Regression: hover/goto-def on an imported stdlib symbol must not hang.
// std/os <-> std/runtime is a cyclic import; the transitive-import walkers in
// lsp.ts (findDocInImports / findInImportedFiles) used to recurse that cycle
// forever, pinning a CPU at 100%. Any file importing std/string (transitively
// pulls in the cycle) reproduced it. These tests drive the real milod over
// stdio and fail via timeout if the spin ever returns.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
// server.milo hits it via strStartsWith; here we use a self-contained doc so the
// test doesn't depend on any external repo.
const SRC = `from "std/string" import { strStartsWith }

fn main() {
    let ok = strStartsWith("hello", "he")
}
`;
const URI = "file:///tmp/milo-lsp-regression.milo";

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
  await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "milo", version: 1, text: SRC } } });
});

afterAll(() => { proc?.kill(); });

// strStartsWith is on line 4 (0-based 3), starting at column 13.
const POS = { line: 3, character: 13 };

test("hover on imported stdlib symbol returns without hanging", async () => {
  const hover = await req(2, "textDocument/hover", { textDocument: { uri: URI }, position: POS });
  expect(hover?.contents?.value).toContain("strStartsWith");
  expect(hover?.contents?.value).toContain("std/string");
});

test("goto-definition on imported stdlib symbol resolves to std/string.milo", async () => {
  const def = await req(3, "textDocument/definition", { textDocument: { uri: URI }, position: POS });
  expect(def?.uri).toContain("std/string.milo");
});
