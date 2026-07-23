// E2E for M8h: native restart (DAP restart request), kill, session re-arm.
// Needs hades-web on [port] targeting /tmp/hades_nested (like e2e-multifile).
// Usage: bun tests/e2e-restart.ts [port]

const port = process.argv[2] ?? "8092";
const url = `ws://localhost:${port}/ws`;
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
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

const d = new Driver();
await d.connect();
const hello = await d.wait(m => m.type === "hello");
await d.wait(m => m.type === "source");

d.send({ cmd: "setBreakpoint", path: hello.sourcePath, line: 23 });
await d.wait(m => m.type === "breakpoint" && m.line === 23);
d.send({ cmd: "run", stopAtMain: true });
const s1 = await d.wait(m => m.type === "stopped");
ok(s1.line === 14, `stop-at-main (line ${s1.line})`);

// native restart: new process, stop-at-main rebinds, NO terminated leaks out
d.send({ cmd: "restart" });
const s2 = await d.wait(m => m.type === "stopped");
ok(s2.line === 14, `restart → stopped at main again (line ${s2.line})`);
ok(s2.tid !== s1.tid, `new process (tid ${s1.tid} → ${s2.tid})`);
ok(!d.queue.some(m => m.type === "terminated"), "no terminated during restart");
ok(!d.queue.some(m => m.type === "restartFailed"), "no restartFailed (lldb handles it)");

// line bp survives the restart
d.send({ cmd: "continue", tid: s2.tid });
const s3 = await d.wait(m => m.type === "stopped");
ok(s3.line === 23, `line bp persisted across restart (line ${s3.line})`);

// kill ends the session; run re-arms on the same connection
d.send({ cmd: "kill" });
await d.wait(m => m.type === "terminated");
ok(true, "kill → terminated");
d.send({ cmd: "run", stopAtMain: true });
const s4 = await d.wait(m => m.type === "stopped", 25000);
ok(s4.line === 14, `re-run after kill (line ${s4.line})`);
d.send({ cmd: "kill" });
await d.wait(m => m.type === "terminated");

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
