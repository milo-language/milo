// E2E for M8l: threads panel — threads broadcast on stop, per-thread stacks,
// late-joiner replay, stepping on the stopped thread.
// Needs hades-web on [port] targeting /tmp/hades_threads:
//   clang -g -O0 examples/threads.c -o /tmp/hades_threads   (compile from repo; DWARF points at examples/threads.c)
//   ./hades web --program /tmp/hades_threads --port 8093
// Usage: bun tests/e2e-threads.ts [port]

const port = process.argv[2] ?? "8093";
const url = `ws://localhost:${port}/ws`;
const SRC = new URL("../examples/threads.c", import.meta.url).pathname;
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

class Driver {
  ws!: WebSocket;
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  async connect() {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const i = this.waiters.findIndex(w => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(obj: any) { this.ws.send(JSON.stringify(obj)); }
  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([
      new Promise<any>(resolve => this.waiters.push({ pred, resolve })),
      timeout(ms),
    ]);
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

// Stop main at `go = 0;` — all 3 workers are alive in their loops.
d.send({ cmd: "setBreakpoint", path: SRC, line: 25 });
await d.wait(m => m.type === "breakpoint" && m.line === 25);
d.send({ cmd: "run", stopAtMain: false });
const stopped = await d.wait(m => m.type === "stopped");
ok(stopped.line === 25, "stopped at go=0", stopped);

// ── threads broadcast on stop ──
// lldb-dap fills its thread list lazily; the server re-polls, so early
// broadcasts may carry only the stopping thread — wait for the full set.
const thr = await d.wait(m => m.type === "threads" && m.threads.length === 4);
ok(Array.isArray(thr.threads) && thr.threads.length === 4, "4 threads (main + 3 workers)", thr);
ok(thr.current === stopped.tid, "current == stopping tid", thr);

// ── per-thread stack ──
const other = thr.threads.find((t: any) => t.id !== thr.current);
d.send({ cmd: "threadStack", tid: other.id, id: 71 });
const ts = await d.wait(m => m.type === "threadStack" && m.id === 71);
ok(ts.tid === other.id, "threadStack tid echoes request", ts);
ok(ts.frames.length > 0 && ts.frames.some((f: any) => f.name.includes("worker")),
   "worker thread stack contains worker()", ts.frames);

// locals of the worker's own frame via the existing frameScopes flow
const wf = ts.frames.find((f: any) => f.name.includes("worker"));
d.send({ cmd: "frameScopes", frameId: wf.id, id: 72 });
const fl = await d.wait(m => m.type === "frameLocals" && m.id === 72);
ok(fl.vars.some((v: any) => v.name === "acc"), "worker frame locals include acc", fl.vars);

// ── late joiner gets the threads replay ──
const d2 = new Driver();
await d2.connect();
await d2.wait(m => m.type === "hello");
await d2.wait(m => m.type === "stopped");
const thr2 = await d2.wait(m => m.type === "threads");
ok(thr2.threads.length === 4 && thr2.current === thr.current, "late joiner: threads replayed", thr2);

// ── step the stopped (main) thread, then run to exit ──
d.queue = d.queue.filter(m => m.type !== "threads");   // drop pre-step re-polls
d.send({ cmd: "stepOver", tid: stopped.tid });
const st2 = await d.wait(m => m.type === "stopped");
ok(st2.line === 26, "step over lands on join loop", st2);
// go=0 already landed, so workers may be mid-exit — count is 1..4 here.
const thr3 = await d.wait(m => m.type === "threads");
ok(thr3.threads.length >= 1 && thr3.current === st2.tid, "threads refreshed after step", thr3);

d.send({ cmd: "clearBreakpoint", path: SRC, line: 25 });
await d.wait(m => m.type === "breakpoint" && m.line === 25 && m.set === false);
d.send({ cmd: "continue", tid: st2.tid });
await d.wait(m => m.type === "terminated", 30000);
ok(true, "ran to exit after clearing bp");

console.log(`\ne2e-threads: ${pass}/${pass} passed`);
process.exit(0);
