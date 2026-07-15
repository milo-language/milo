// E2E for server-side config history (M11.4): single-writer append on launch,
// XDG persistence, dedup, historyChanged broadcast, hello.history, unconditional
// boot restore, and one-shot localStorage migration. Self-spawns hades-web with
// a throwaway $XDG_STATE_HOME so it never touches the real history file.
// Usage: bun tests/e2e-history.ts [binary]   (needs /tmp/hades_nested built)

const bin = process.argv[2] ?? "./hades";
const root = import.meta.dir + "/..";
const xdg = `/tmp/hades_hist_test_${process.pid}`;
const prog = "/tmp/hades_nested";
const src = `${root}/examples/nested/main.c`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

class Peer {
  ws!: WebSocket; queue: any[] = []; waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  async connect(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const i = this.waiters.findIndex(w => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(o: any) { this.ws.send(JSON.stringify(o)); }
  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([new Promise<any>(r => this.waiters.push({ pred, resolve: r })), timeout(ms)]);
  }
}

let port = 8130;
async function spawnSrv(args: string[]): Promise<any> {
  const p = port++;
  const srv = Bun.spawn([bin, "web", "--port", String(p), "--quiet", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HADES_NO_OPEN: "1", XDG_STATE_HOME: xdg },
  });
  for (let i = 0; i < 60; i++) {
    try { const t = new Peer(); await t.connect(p); t.ws.close(); return { srv, port: p }; }
    catch { await sleep(100); }
  }
  throw new Error("server never came up");
}

// ── part 1: append on launch + dedup + persistence + broadcast ──

let { srv, port: p1 } = await spawnSrv(["--program", prog, "--source", src]);
let a = new Peer(); await a.connect(p1);
const h1 = await a.wait(m => m.type === "hello");
ok(Array.isArray(h1.history) && h1.history.length === 0, "hello.history empty before any run", h1.history);

a.send({ cmd: "run", stopAtMain: true });
const hc = await a.wait(m => m.type === "historyChanged");
ok(hc.history.length === 1 && hc.history[0].program === prog, "historyChanged after launch, entry has program", hc.history[0]);
ok(hc.history[0].type === "lldb" && typeof hc.history[0].lastRunAt === "number", "entry canonical (type + lastRunAt)", hc.history[0]);
await a.wait(m => m.type === "stopped");
a.send({ cmd: "kill" }); await a.wait(m => m.type === "terminated");

// persisted to XDG
const file = `${xdg}/hades/history.json`;
const onDisk = JSON.parse(await Bun.file(file).text());
ok(onDisk.length === 1 && onDisk[0].program === prog, "persisted to $XDG_STATE_HOME/hades/history.json", onDisk);

// re-run same target → deduped (still 1)
a.send({ cmd: "run", stopAtMain: true });
const hc2 = await a.wait(m => m.type === "historyChanged");
ok(hc2.history.length === 1, "re-run same target deduped (1 entry)", hc2.history.length);
await a.wait(m => m.type === "stopped");
a.send({ cmd: "kill" }); await a.wait(m => m.type === "terminated");
a.ws.close();
srv.kill();
await sleep(200);

// ── part 2: unconditional boot restore (no --program) ──

const boot = await spawnSrv([]);  // no --program → restore history[0]
const b = new Peer(); await b.connect(boot.port);
const hb = await b.wait(m => m.type === "hello");
ok(hb.program === prog, "boot restore: hello.program = history[0]", hb.program);
ok(hb.restored === true, "boot restore: hello.restored flag set", hb.restored);
ok(!hb.phase, "boot restore is staged, not launched (no running phase)", hb.phase);
// and it actually runs from the restored config
b.send({ cmd: "run", stopAtMain: true });
const sb = await b.wait(m => m.type === "stopped");
ok(sb.line === 14, "restored target launches on Run", sb.line);
b.send({ cmd: "kill" }); await b.wait(m => m.type === "terminated");
b.ws.close();
boot.srv.kill();
await sleep(200);

// ── part 3: one-shot localStorage migration ──

const mig = await spawnSrv([]);
const c = new Peer(); await c.connect(mig.port);
await c.wait(m => m.type === "hello");
c.send({ cmd: "importHistory", entries: [{ type: "python", program: "/tmp/legacy.py" }] });
const hmig = await c.wait(m => m.type === "historyChanged");
ok(hmig.history.some((h: any) => h.program === "/tmp/legacy.py"), "importHistory merges legacy entries", hmig.history.map((h: any) => h.program));
c.ws.close();
mig.srv.kill();

await Bun.$`rm -rf ${xdg}`.quiet();
console.log(`\ne2e-history: ${pass} assertions passed`);
process.exit(0);
