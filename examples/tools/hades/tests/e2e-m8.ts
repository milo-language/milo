// E2E for M8b (conditional bps / logpoints) + M8d (frame navigation) + M8i-lite
// (disassemble). Speaks WS protocol v2 like tests/e2e.ts; needs a hades-web on
// [port] targeting /tmp/hades_inter. Runs two debug sessions on one WS
// connection to exercise bp upsert + session re-arm.
// Usage: bun tests/e2e-m8.ts [port]

const port = process.argv[2] ?? "8091";
const url = `ws://localhost:${port}/ws`;

const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

class Driver {
  ws!: WebSocket;
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ptyBuf = "";
  outBuf = "";

  async connect() {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "ptyData") this.ptyBuf += m.data;
      if (m.type === "output") this.outBuf += m.text;
      const i = this.waiters.findIndex(w => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(obj: any) { this.ws.send(JSON.stringify(obj)); }
  wait(pred: (m: any) => boolean, ms = 15000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([
      new Promise<any>(resolve => this.waiters.push({ pred, resolve })),
      timeout(ms),
    ]);
  }
  async waitPty(substr: string, ms = 15000) {
    const start = Date.now();
    while (!this.ptyBuf.includes(substr)) {
      if (Date.now() - start > ms) throw new Error(`pty timeout waiting for ${JSON.stringify(substr)}; got ${JSON.stringify(this.ptyBuf.slice(-200))}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

const d = new Driver();
await d.connect();
await d.wait(m => m.type === "hello");
await d.wait(m => m.type === "source");

// ── Session 1: false condition means the bp never fires ──
d.send({ cmd: "setBreakpoint", line: 6, condition: "x == 999" });
await d.wait(m => m.type === "breakpoint" && m.line === 6);
d.send({ cmd: "run" });
await d.waitPty("who are you?");
for (const ch of "milo\r") d.send({ cmd: "stdin", data: ch });
// Wait for terminated only (a raced stopped-waiter would linger and swallow
// session 2's stop event); a stray stop would be sitting in the queue.
await d.wait(m => m.type === "terminated");
ok(!d.queue.some(m => m.type === "stopped"), "condition x==999 → ran to exit without stopping");

// ── Session 2: true condition stops; logpoint logs without stopping ──
d.ptyBuf = ""; d.outBuf = "";
d.send({ cmd: "setBreakpoint", line: 6, condition: "x == 7" }); // upsert same line
await d.wait(m => m.type === "breakpoint" && m.line === 6);
d.send({ cmd: "setBreakpoint", line: 7, logMessage: "SUMLOG {sum}" });
await d.wait(m => m.type === "breakpoint" && m.line === 7);
d.send({ cmd: "run" });
await d.waitPty("who are you?");
for (const ch of "milo\r") d.send({ cmd: "stdin", data: ch });
const stopped = await d.wait(m => m.type === "stopped");
ok(stopped.line === 6, `condition x==7 → stopped at 6 (got ${stopped.line})`);

// M8d: frames carry path + ipRef
ok(stopped.frames[0].path?.endsWith("hades_inter.c"), "frame0 has source path", stopped.frames[0]);
ok(typeof stopped.frames[0].ipRef === "string" && stopped.frames[0].ipRef.startsWith("0x"), "frame0 has ipRef", stopped.frames[0]);

// M8d: scopes for a parent frame (main) — locals differ from frame 0's
const main = stopped.frames.find((f: any) => f.name.includes("main"));
ok(!!main, "main frame present", stopped.frames);
d.send({ cmd: "frameScopes", frameId: main.id, id: 201 });
const fl = await d.wait(m => m.type === "frameLocals" && m.id === 201);
ok(fl.vars.some((v: any) => v.name === "r"), "main frame locals include 'r'", fl.vars);

// M8d: openSource round-trip
d.send({ cmd: "openSource", path: main.path });
const src = await d.wait(m => m.type === "source");
ok(src.content.includes("scanf") && src.path === main.path, "openSource pushes file content");

// M8i-lite: disassemble around frame0's pc
d.send({ cmd: "disassemble", memoryReference: stopped.frames[0].ipRef, id: 202 });
const da = await d.wait(m => m.type === "disasm" && m.id === 202, 20000);
ok(Array.isArray(da.instructions) && da.instructions.length > 0, `disasm returned ${da.instructions.length} instructions`);
const pc = BigInt(stopped.frames[0].ipRef);
ok(da.instructions.some((i: any) => { try { return BigInt(i.addr) === pc; } catch { return false; } }),
   "disasm window contains the pc", da.instructions.slice(0, 3));

// M8e: setVariable on param x (7 → 58) before `sum = x + y` runs; downstream
// output must show sum=93, proving the write hit the debuggee.
ok(stopped.scopeRef > 0, `stopped carries scopeRef (got ${stopped.scopeRef})`);
d.send({ cmd: "setVar", ref: stopped.scopeRef, name: "x", value: "58", id: 301 });
const sv = await d.wait(m => m.type === "setVarResult" && m.id === 301);
ok(!sv.error && sv.value.includes("58"), `setVar x=58 → ${sv.value}`, sv);
d.send({ cmd: "evaluate", expr: "x", context: "repl", id: 302, frameId: stopped.frames[0].id });
const ev = await d.wait(m => m.type === "evalResult" && m.id === 302);
ok(ev.value.includes("58"), `evaluate x after setVar → ${ev.value}`);

// logpoint: continue → line-7 logpoint emits output (with edited sum), no stop
d.send({ cmd: "continue", tid: stopped.tid });
await d.waitPty("sum=93");
ok(true, "pty shows sum=93 — setVariable changed program behavior");
await d.wait(m => m.type === "terminated");
ok(d.outBuf.includes("SUMLOG") && d.outBuf.includes("93"), `logpoint output seen (got ${JSON.stringify(d.outBuf.slice(-200))})`);

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
