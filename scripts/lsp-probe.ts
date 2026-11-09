// Crash-safety probe for the Milo language server (src/lsp.ts).
//
// Runs a scripted JSON-RPC sequence and asserts on the responses/notifications,
// not just that the server answered *something* (an LSP that answers null to
// every request looks like it works; this probe fails that case on purpose, see
// the "never silently empty" checks below). Usage: bun scripts/lsp-probe.ts
import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";

// stderr is "inherit" so the server's own diagnostics reach the terminal — that makes
// child.stderr null, which ChildProcessWithoutNullStreams does not model.
type ProbeChild = ChildProcessByStdio<Writable, Readable, null>;
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Json = any;

function frame(obj: object): Buffer {
  const json = JSON.stringify(obj);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, "utf-8");
}

// Framed-message reader over a child's stdout: buffers bytes, yields whole
// JSON bodies as they complete, and lets a caller wait for the next message
// matching a predicate (used for "the response with this id" / "a
// publishDiagnostics notification for this uri").
class FrameReader {
  private buf = Buffer.alloc(0);
  private queue: Json[] = [];
  private waiters: { pred: (m: Json) => boolean; resolve: (m: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  feed(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buf.slice(0, headerEnd).toString("utf-8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return;
      const body = this.buf.slice(bodyStart, bodyStart + len).toString("utf-8");
      this.buf = this.buf.slice(bodyStart + len);
      let parsed: Json;
      try { parsed = JSON.parse(body); } catch { continue; }
      this.deliver(parsed);
    }
  }

  private deliver(msg: Json) {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    this.queue.push(msg);
  }

  // Wait for a message matching `pred`, checking the backlog first so a
  // message that already arrived before this call isn't missed.
  waitFor(pred: (m: Json) => boolean, timeoutMs: number, label: string): Promise<Json> {
    for (let i = 0; i < this.queue.length; i++) {
      if (pred(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.resolve === resolveP);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectP(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveP, reject: rejectP, timer });
    });
  }
}

interface Server {
  child: ProbeChild;
  reader: FrameReader;
  send(obj: object): void;
  nextId(): number;
  stop(): void;
}

function startServer(): Server {
  const child: ProbeChild = spawn("bun", ["run", resolve(ROOT, "src/main.ts"), "lsp"], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
  const reader = new FrameReader();
  child.stdout.on("data", (c: Buffer) => reader.feed(c));
  let id = 1;
  return {
    child,
    reader,
    send(obj: object) { child.stdin.write(frame(obj)); },
    nextId() { return id++; },
    stop() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

// ── Assertion bookkeeping ──
let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// ── Fixture sources ──
const CLEAN_MILO = [
  "fn add(a: i32, b: i32): i32 {",
  "    return a + b",
  "}",
  "",
  "fn main() {",
  "    print(add(1, 2).toString())",
  "}",
  "",
].join("\n");

// A LEX-FATAL buffer (unterminated string): the server must report it and stay up.
const LEX_FATAL_MILO = [
  "fn broken(: i32 {",
  '    let s = "unterminated',
  "}",
  "",
].join("\n");

// A real semantic error (undefined function) — exercises the checker's
// structured diagnostics, not the lex-fatal fallback path.
const TYPE_ERROR_MILO = [
  "fn main() {",
  "    thisFunctionDoesNotExist(1, 2)",
  "}",
  "",
].join("\n");

async function run() {
  const server = startServer();
  const uri = "file:///tmp/lsp_probe_fixture.milo";

  const diagFor = (m: Json) => m.method === "textDocument/publishDiagnostics" && m.params?.uri === uri;

  try {
    // 1. initialize
    const initId = server.nextId();
    server.send({ jsonrpc: "2.0", id: initId, method: "initialize", params: { rootUri: null, capabilities: {} } });
    const initResp = await server.reader.waitFor(m => m.id === initId, 15000, "initialize response");
    check("initialize responds with a result object", typeof initResp.result === "object" && initResp.result !== null);
    check("initialize advertises textDocumentSync", initResp.result?.capabilities?.textDocumentSync !== undefined);

    server.send({ jsonrpc: "2.0", method: "initialized", params: {} });

    // 2. didOpen clean source -> empty diagnostics (not silence: we assert
    // the array itself, not just "we got some message").
    server.send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "milo", version: 1, text: CLEAN_MILO } } });
    const cleanDiag = await server.reader.waitFor(diagFor, 20000, "publishDiagnostics for clean source");
    check("clean source publishes a diagnostics array", Array.isArray(cleanDiag.params?.diagnostics));
    check("clean source has zero diagnostics", (cleanDiag.params?.diagnostics ?? []).length === 0,
      JSON.stringify(cleanDiag.params?.diagnostics));

    // 3. didChange to a real type error -> at least one error diagnostic.
    server.send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: TYPE_ERROR_MILO }] } });
    const typeErrDiag = await server.reader.waitFor(diagFor, 20000, "publishDiagnostics for type-error source");
    const typeDiags = typeErrDiag.params?.diagnostics ?? [];
    check("undefined-function call produces at least one diagnostic", typeDiags.length >= 1, JSON.stringify(typeDiags));
    check("undefined-function diagnostic is severity error(1)", typeDiags[0]?.severity === 1, JSON.stringify(typeDiags[0]));

    // 4. didChange to a lex-fatal buffer -> still exactly one clean error
    // diagnostic, AND the server must still be alive afterward (the crash-
    // safety property this whole subprocess architecture exists for).
    server.send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: LEX_FATAL_MILO }] } });
    const lexDiag = await server.reader.waitFor(diagFor, 20000, "publishDiagnostics for lex-fatal source");
    const lexDiags = lexDiag.params?.diagnostics ?? [];
    check("lex-fatal buffer produces at least one diagnostic (never silent)", lexDiags.length >= 1, JSON.stringify(lexDiags));
    check("lex-fatal diagnostic is severity error(1) or warning(2)", [1, 2].includes(lexDiags[0]?.severity), JSON.stringify(lexDiags[0]));

    // 5. Prove the server survived #4: send one more request and get a real
    // reply. A crashed server would time out here, not answer null.
    const shutdownId = server.nextId();
    server.send({ jsonrpc: "2.0", id: shutdownId, method: "shutdown", params: null });
    const shutdownResp = await server.reader.waitFor(m => m.id === shutdownId, 15000, "shutdown response after lex-fatal buffer");
    check("server survives a lex-fatal buffer and still answers shutdown", shutdownResp.result === null, JSON.stringify(shutdownResp));

    server.send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
    server.send({ jsonrpc: "2.0", method: "exit", params: null });

    const exited = await new Promise<boolean>(resolveP => {
      const t = setTimeout(() => resolveP(false), 10000);
      server.child.once("exit", () => { clearTimeout(t); resolveP(true); });
    });
    check("server exits after `exit` notification", exited);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL exception during run — ${e.message ?? e}`);
  } finally {
    server.stop();
  }
}

async function main() {
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
