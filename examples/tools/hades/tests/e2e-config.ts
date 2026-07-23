// E2E for the launch-config redesign: run carries the config inline (no
// staging), force-run kills a live session and relaunches, setConfig is
// idle-only, config validation errors are actionable, history caps at 10 and
// keeps `name`. Self-spawns hades-web with a throwaway $XDG_STATE_HOME.
// Usage: bun tests/e2e-config.ts [binary]   (needs /tmp/hades_nested + /tmp/hades_inter built)

const bin = process.argv[2] ?? "./hades";
const root = import.meta.dir + "/..";
const xdg = `/tmp/hades_cfg_test_${process.pid}`;
const nested = "/tmp/hades_nested";
const inter = "/tmp/hades_inter";

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

let port = 8150;
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

// ── part 1: run with inline config; force-run kills + relaunches ──

const { srv, port: p1 } = await spawnSrv([]);   // boots idle, no target
const a = new Peer(); await a.connect(p1);
const h0 = await a.wait(m => m.type === "hello");
ok(typeof h0.config === "object", "hello carries a config object", h0.config);

// run with the config inline — no setConfig round-trip
a.send({ cmd: "run", stopAtMain: true, config: { type: "lldb", name: "nested run", program: nested } });
const hi1 = await a.wait(m => m.type === "hello");     // target-changed re-hello
ok(hi1.program === nested && hi1.config.program === nested, "run applies inline config (hello echoes it)", hi1.config);
await a.wait(m => m.type === "stopped");

// run again without force → rejected, session untouched
a.send({ cmd: "run", config: { type: "lldb", program: inter } });
const rej = await a.wait(m => m.type === "configError");
ok(/already active/.test(rej.error), "run on a live session without force is rejected", rej.error);

// run with force → old session dies, new config launches
a.send({ cmd: "run", stopAtMain: true, force: true, config: { type: "lldb", name: "inter run", program: inter } });
await a.wait(m => m.type === "terminated");
const hi2 = await a.wait(m => m.type === "hello");
ok(hi2.program === inter, "force-run kills the session and applies the new config", hi2.program);
await a.wait(m => m.type === "stopped");

// setConfig is idle-only
a.send({ cmd: "setConfig", type: "lldb", program: nested });
const rej2 = await a.wait(m => m.type === "configError");
ok(/session is active/.test(rej2.error), "setConfig mid-session is rejected (no staging)", rej2.error);

a.send({ cmd: "kill" }); await a.wait(m => m.type === "terminated");

// ── part 2: validation errors are actionable ──

a.send({ cmd: "run", config: { type: "lldb", program: nested, dapPath: "lldb-dap", port: 4711 } });
const v1 = await a.wait(m => m.type === "configError");
ok(/dapPath.*port|port.*dapPath/.test(v1.error), "dapPath+port conflict rejected", v1.error);

a.send({ cmd: "run", config: { type: "lldb", request: "attach" } });
const v2 = await a.wait(m => m.type === "configError");
ok(/attach needs a target/.test(v2.error), "attach without pid/processId/connect rejected", v2.error);

a.send({ cmd: "run", config: { type: "lldb", request: "reboot", program: nested } });
const v3 = await a.wait(m => m.type === "configError");
ok(/request/.test(v3.error), "bad request value rejected", v3.error);

// ── part 3: history keeps name, caps at 10 ──

const hist1 = await a.wait(m => m.type === "historyChanged" || m.type === "hello", 1000).catch(() => null);
// history was appended on the two successful launches above; read from a fresh hello
const b = new Peer(); await b.connect(p1);
const hb = await b.wait(m => m.type === "hello");
ok(hb.history.length === 2, "two launches → two history entries", hb.history.length);
ok(hb.history.some((h: any) => h.name === "inter run"), "history entry keeps `name`", hb.history);

// cap: merge 12 legacy entries → total ≤ 10, newest first
const legacy = Array.from({ length: 12 }, (_, i) => ({ type: "lldb", program: `/tmp/fake_${i}` }));
b.send({ cmd: "importHistory", entries: legacy });
const hcap = await b.wait(m => m.type === "historyChanged");
ok(hcap.history.length === 10, "history capped at 10", hcap.history.length);

a.ws.close(); b.ws.close();
srv.kill();
await Bun.$`rm -rf ${xdg}`.quiet();
console.log(`\ne2e-config: ${pass} assertions passed`);
process.exit(0);
