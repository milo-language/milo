// E2E for session persistence: browser-refresh reattach (M9 replay path),
// stable sessionId across reconnects, and --idle-ttl reaping when no peers
// stay attached. Part 1 runs against the provided server; part 2 spawns its
// own hades-web with a short TTL.
// Needs hades-web on [port] targeting /tmp/hades_nested. Usage: bun tests/e2e-session.ts [port]

const port = process.argv[2] ?? "8092";
const ttlPort = Number(port) + 3;
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Peer {
  ws!: WebSocket;
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  async connect(p: string | number = port) {
    this.ws = new WebSocket(`ws://localhost:${p}/ws`);
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

// ── part 1: refresh-reattach against the shared server ──

const a = new Peer();
await a.connect();
const hello1 = await a.wait(m => m.type === "hello");
ok(typeof hello1.sessionId === "string" && hello1.sessionId.length === 36, "hello carries sessionId uuid", hello1.sessionId);
a.send({ cmd: "setBreakpoint", path: hello1.sourcePath, line: 23 });
await a.wait(m => m.type === "breakpoint" && m.line === 23);
a.send({ cmd: "run", stopAtMain: true });
await a.wait(m => m.type === "capabilities");
const s1 = await a.wait(m => m.type === "stopped");
ok(s1.line === 14, `stopped at main (line ${s1.line})`);

// simulate browser refresh: drop the socket, reconnect, expect full replay
a.ws.close();
await sleep(300);
const a2 = new Peer();
await a2.connect();
const hello2 = await a2.wait(m => m.type === "hello");
ok(hello2.sessionId === hello1.sessionId, "sessionId stable across refresh");
ok(hello2.phase === "running", "reattach hello carries phase");
const bp2 = await a2.wait(m => m.type === "bpSync");
ok(bp2.line === 23, "breakpoint replayed on reattach");
const s2 = await a2.wait(m => m.type === "stopped");
ok(s2.line === s1.line && s2.tid === s1.tid, "stopped snapshot replayed on reattach");

// session is still driveable after the refresh
a2.send({ cmd: "stepOver", tid: s2.tid });
const s3 = await a2.wait(m => m.type === "stopped");
ok(s3.line !== s1.line, `stepped after reattach (line ${s3.line})`);
a2.send({ cmd: "kill" });
await a2.wait(m => m.type === "terminated");
ok(true, "killed part-1 session");
a2.ws.close();

// ── part 1.5: newSession command — deliberate fresh start ──

const n1 = new Peer();
await n1.connect();
const helloN = await n1.wait(m => m.type === "hello");
n1.send({ cmd: "setBreakpoint", path: helloN.sourcePath, line: 23 });
await n1.wait(m => m.type === "breakpoint" && m.line === 23);
n1.send({ cmd: "run", stopAtMain: true });
await n1.wait(m => m.type === "stopped");
n1.send({ cmd: "newSession" });
const helloN2 = await n1.wait(m => m.type === "hello");
ok(helloN2.sessionId !== helloN.sessionId, "newSession mints a fresh sessionId");
ok(helloN2.program === helloN.program, "target config survives newSession");
await n1.wait(m => m.type === "terminated");
ok(true, "newSession ended the running debuggee");
n1.ws.close();
// a late joiner must see none of the old session's replay state
const n2 = new Peer();
await n2.connect();
const helloN3 = await n2.wait(m => m.type === "hello");
ok(helloN3.sessionId === helloN2.sessionId, "joiner lands in the new session");
ok(!helloN3.phase, "new session is idle");
await sleep(300);
ok(!n2.queue.some(m => m.type === "bpSync" || m.type === "stopped"),
   "no bp/stop replay leaks from the old session", n2.queue);
// and it's a fully usable session: run again
n2.send({ cmd: "run", stopAtMain: true });
const sN = await n2.wait(m => m.type === "stopped");
ok(sN.line === 14, "fresh session runs to main");
n2.send({ cmd: "kill" });
await n2.wait(m => m.type === "terminated");
n2.ws.close();

// ── part 2: idle TTL reaps a peerless session ──

const srv = Bun.spawn([
  "./hades", "web", "--program", "/tmp/hades_nested",
  "--port", String(ttlPort), "--idle-ttl", "2",
], {
  cwd: import.meta.dir + "/..", stdout: "ignore", stderr: "pipe",
  // Must NOT auto-open a browser: a real tab reconnects (M9b) and stays a
  // peer, so gPeers never reaches 0 and the idle reaper never fires.
  env: { ...process.env, HADES_NO_OPEN: "1" },
});
// wait for the listener
for (let i = 0; i < 50; i++) {
  try { const p = new Peer(); await p.connect(ttlPort); p.ws.close(); break; }
  catch { await sleep(100); }
}

const b = new Peer();
await b.connect(ttlPort);
const helloB = await b.wait(m => m.type === "hello");
b.send({ cmd: "run", stopAtMain: true });
const sB = await b.wait(m => m.type === "stopped");
ok(sB.line === 14, "ttl-server session started");

// stay attached past the TTL: session must NOT be reaped while a peer is here
await sleep(3500);
b.send({ cmd: "stepOver", tid: sB.tid });
const sB2 = await b.wait(m => m.type === "stopped");
ok(sB2.line !== sB.line, "attached peer keeps session alive past ttl");

// detach; ttl=2s + 1s tick → reaped well within 6s
b.ws.close();
await sleep(6000);
const c = new Peer();
await c.connect(ttlPort);
const helloC = await c.wait(m => m.type === "hello");
ok(!helloC.phase, "peerless session reaped after idle-ttl (rejoin sees idle)");
ok(helloC.sessionId === helloB.sessionId, "server (and sessionId) survive the reap");
// and the server is still usable: run again
c.send({ cmd: "run", stopAtMain: true });
const sC = await c.wait(m => m.type === "stopped");
ok(sC.line === 14, "fresh run works after reap");
c.send({ cmd: "kill" });
await c.wait(m => m.type === "terminated");
c.ws.close();
srv.kill();

console.log(`e2e-session: ${pass}/${pass} passed`);
process.exit(0);
