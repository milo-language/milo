// E2E for M9 shared session: two WS peers on one debug session — broadcast
// state, late-join replay (hello phase, capabilities, bpSync, stopped), and
// cross-peer control (B steps, A sees the stop).
// Needs hades-web on [port] targeting /tmp/hades_nested. Usage: bun tests/e2e-codebug.ts [port]

const port = process.argv[2] ?? "8092";
const url = `ws://localhost:${port}/ws`;
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

class Peer {
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

// peer A: drives the session like a browser
const a = new Peer();
await a.connect();
const helloA = await a.wait(m => m.type === "hello");
ok(!helloA.phase, "A joins idle session (no phase)");
a.send({ cmd: "setBreakpoint", path: helloA.sourcePath, line: 23, condition: "i == 1" });
await a.wait(m => m.type === "breakpoint" && m.line === 23);
a.send({ cmd: "run", stopAtMain: true });
await a.wait(m => m.type === "capabilities");
const sA = await a.wait(m => m.type === "stopped");
ok(sA.line === 14, `A stopped at main (line ${sA.line})`);

// peer B: late joiner — must get the full session picture from replay alone
const b = new Peer();
await b.connect();
const helloB = await b.wait(m => m.type === "hello");
ok(helloB.phase === "running", "B hello carries phase=running");
const capsB = await b.wait(m => m.type === "capabilities");
ok(JSON.parse(capsB.raw).body?.supportsDisassembleRequest === true, "B got capabilities replay");
const bpB = await b.wait(m => m.type === "bpSync");
ok(bpB.line === 23 && bpB.condition === "i == 1", "B got bpSync replay w/ condition", bpB);
const sB = await b.wait(m => m.type === "stopped");
ok(sB.line === 14 && sB.tid === sA.tid, "B got stopped snapshot replay");

// cross-peer control: B steps, BOTH peers see the new stop
b.send({ cmd: "stepOver", tid: sB.tid });
const s2A = await a.wait(m => m.type === "stopped");
const s2B = await b.wait(m => m.type === "stopped");
ok(s2A.line === s2B.line && s2A.line !== 14, `B stepped, both saw stop at line ${s2A.line}`);

// B evaluates; result is broadcast (id-correlated, A's UI would ignore it)
b.send({ cmd: "evaluate", expr: "shapes[0].sides", context: "repl", id: 9000001, frameId: s2B.frames[0].id });
const ev = await b.wait(m => m.type === "evalResult" && m.id === 9000001);
ok(!ev.error, `B evaluate through shared adapter (${ev.value})`);

// A disconnects mid-session; session must survive for B
a.ws.close();
await new Promise(r => setTimeout(r, 300));
b.send({ cmd: "continue", tid: s2B.tid });
const s3B = await b.wait(m => m.type === "stopped");
ok(s3B.line === 23, `session survived A's disconnect — bp hit at ${s3B.line}`);

// C joins after A left; replay still coherent
const c = new Peer();
await c.connect();
await c.wait(m => m.type === "hello");
const sC = await c.wait(m => m.type === "stopped");
ok(sC.line === 23, "C late-joins and sees current stop");

b.send({ cmd: "kill" });
await b.wait(m => m.type === "terminated");
await c.wait(m => m.type === "terminated");
ok(true, "kill broadcast to all peers");

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
