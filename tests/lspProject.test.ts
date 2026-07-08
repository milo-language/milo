// Tier-3 references/rename: scan the whole project on disk, not just open
// buffers. Set up a temp workspace with two files, open only one, and assert a
// reference is found in the file that was never opened.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

const ROOT = mkdtempSync(join(tmpdir(), "milo-lsp-proj-"));
writeFileSync(join(ROOT, "helper.milo"), `fn helper(x: i32): i32 {\n    return x + 1\n}\n`);
const MAIN = join(ROOT, "main.milo");
writeFileSync(MAIN, `fn main() {\n    let y = helper(41)\n}\n`);
const MAIN_URI = pathToFileURL(MAIN).href;
const HELPER_URI = pathToFileURL(join(ROOT, "helper.milo")).href;

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
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, (v) => { clearTimeout(t); resolve(v); });
    await send({ jsonrpc: "2.0", id, method, params });
  });
}

beforeAll(async () => {
  proc = spawn(["bun", "run", COMPILER, "lsp"], { cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "inherit" });
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
  // Advertise the temp dir as the workspace root.
  await req(1, "initialize", { rootUri: pathToFileURL(ROOT).href, capabilities: {} });
  await send({ jsonrpc: "2.0", method: "initialized", params: {} });
  // Open ONLY main.milo — helper.milo stays on disk, never opened.
  await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: MAIN_URI, languageId: "milo", version: 1, text: `fn main() {\n    let y = helper(41)\n}\n` } } });
});

afterAll(() => { proc?.kill(); rmSync(ROOT, { recursive: true, force: true }); });

test("references finds occurrences in an unopened on-disk file", async () => {
  // `helper` at its call site in main.milo (line 1, col 12)
  const refs = await req(10, "textDocument/references", { textDocument: { uri: MAIN_URI }, position: { line: 1, character: 12 } });
  const uris = refs.map((r: any) => r.uri);
  expect(uris).toContain(HELPER_URI); // declaration in the file we never opened
  expect(uris).toContain(MAIN_URI);   // call site
});

test("rename edits both the open file and the unopened declaration", async () => {
  const edit = await req(11, "textDocument/rename", { textDocument: { uri: MAIN_URI }, position: { line: 1, character: 12 }, newName: "increment" });
  expect(Object.keys(edit.changes)).toContain(HELPER_URI);
  expect(Object.keys(edit.changes)).toContain(MAIN_URI);
});
