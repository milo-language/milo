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

// A second workspace for cross-file diagnostics. Kept apart from ROOT so its
// extra files cannot perturb the project-wide reference scan above.
const DROOT = mkdtempSync(join(tmpdir(), "milo-lsp-diag-"));
writeFileSync(join(DROOT, "data.txt"), "payload\n");
// The bare-embedFile warning sits on line 9 — past the end of the 6-line importer,
// so a diagnostic misattributed to the importer is unmissable.
const DHELPER = join(DROOT, "helper.milo");
writeFileSync(DHELPER, `// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n// 7\npub fn getData(): string {\n    return embedFile("data.txt")\n}\n`);
const DMAIN = join(DROOT, "main.milo");
// Line 6 (0-indexed 5) carries the importer's OWN copy of the same warning.
const DMAIN_SRC = `from "./helper" import {\n    getData\n}\n\nfn main() {\n    print(getData() + embedFile("data.txt"))\n}\n`;
writeFileSync(DMAIN, DMAIN_SRC);
const DMAIN_URI = pathToFileURL(DMAIN).href;

// A third workspace where the OPEN file's own private `tone` collides with an imported
// module's, so the per-module pass renames it (docs/plans/module-namespaces.md). The LSP
// looks a decl up by the identifier under the cursor, so a mangled `coll_main$tone` would
// not merely print wrong: hover and go-to-definition would find nothing at all.
const CROOT = mkdtempSync(join(tmpdir(), "milo-lsp-coll-"));
writeFileSync(join(CROOT, "helper.milo"), `fn tone(x: i64): i64 {\n    return x * 100\n}\n\npub fn fromHelper(): i64 {\n    return tone(10)\n}\n`);
const CMAIN = join(CROOT, "main.milo");
const CMAIN_SRC = `from "./helper" import { fromHelper }\n\nfn tone(x: i64): i64 {\n    return x + 1\n}\n\nfn main() {\n    print(tone(1) + fromHelper())\n}\n`;
writeFileSync(CMAIN, CMAIN_SRC);
const CMAIN_URI = pathToFileURL(CMAIN).href;

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
  await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: DMAIN_URI, languageId: "milo", version: 1, text: DMAIN_SRC } } });
  await send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: CMAIN_URI, languageId: "milo", version: 1, text: CMAIN_SRC } } });
});

afterAll(() => {
  proc?.kill();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(DROOT, { recursive: true, force: true });
  rmSync(CROOT, { recursive: true, force: true });
});

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

// The checker runs over the whole resolved program, so it reports warnings from
// imported files too. Those spans are line/col in the IMPORTED file; publishing
// them verbatim under the open document's URI squiggled an unrelated line.
test("a warning from an imported file is not squiggled on the importer", async () => {
  // Diagnostics are async notifications published after didOpen — poll until they
  // settle. The loop breaks the instant both diagnostics land, so a generous ceiling
  // costs fast machines nothing and only spends real time on a slow CI runner that
  // would otherwise time out and flake the release gate.
  const deadline = Date.now() + 30000;
  let diags: any[] | undefined;
  while (Date.now() < deadline) {
    diags = diagnosticsByUri.get(DMAIN_URI);
    if (diags && diags.length >= 2) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(diags?.length).toBe(2);

  // The importer's own warning keeps its true position: line 6, on `embedFile`.
  const own = diags!.find(d => !/^in imported file/.test(d.message))!;
  expect(own.message).toContain("compile-time builtin");
  expect(own.range.start.line).toBe(5);
  expect(own.range.start.character).toBe(22);

  // The helper's warning is hoisted to the top with its real location in the
  // message — never onto line 9, which the 7-line importer does not even have.
  const imported = diags!.find(d => /^in imported file/.test(d.message))!;
  expect(imported.message).toContain(`${DHELPER}:9:12`);
  expect(imported.message).toContain("compile-time builtin");
  expect(imported.range.start.line).toBe(0);
});

// `tone` on line 8 is the call site of this file's own private `tone`, which collides with
// the imported module's and is therefore renamed before the checker ever sees it.
test("hover on a collided private fn shows the name as written", async () => {
  const h = await req(20, "textDocument/hover", { textDocument: { uri: CMAIN_URI }, position: { line: 7, character: 11 } });
  const value: string = h?.contents?.value ?? "";
  expect(value).toContain("fn tone(x: i64): i64");
  expect(value).not.toContain("$");
});

test("go-to-definition on a collided private fn lands on its declaration", async () => {
  const d = await req(21, "textDocument/definition", { textDocument: { uri: CMAIN_URI }, position: { line: 7, character: 11 } });
  const hit = Array.isArray(d) ? d[0] : d;
  expect(hit?.uri).toBe(CMAIN_URI);
  expect(hit?.range?.start?.line).toBe(2);
});
