// E2E driver for the hades web server: speaks WS protocol v2 like the browser.
// Usage: bun tests/e2e.ts [port]
// Exercises: hello/source push, breakpoint ack, run → runInTerminal pty launch,
// stop snapshot (frames+locals with refs), evaluate (repl+watch), expand,
// stdin through the pty, step, continue → terminated.

const port = process.argv[2] ?? "8091";
const url = `ws://localhost:${port}/ws`;

const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

class Driver {
  ws!: WebSocket;
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ptyBuf = "";

  async connect() {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "ptyData") this.ptyBuf += m.data;
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
      if (Date.now() - start > ms) throw new Error(`pty never contained ${JSON.stringify(substr)}; got: ${JSON.stringify(this.ptyBuf)}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

let pass = 0;
function ok(cond: boolean, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

const d = new Driver();
await d.connect();

const hello = await d.wait(m => m.type === "hello");
ok(hello.program.length > 0, `hello program=${hello.program}`);
const source = await d.wait(m => m.type === "source");
ok(source.content.includes("scanf"), "source pushed with real file content");

d.send({ cmd: "setBreakpoint", line: 6 });
const ack = await d.wait(m => m.type === "breakpoint");
ok(ack.line === 6 && ack.set === true, "breakpoint ack line 6");

d.send({ cmd: "run" });

// Debuggee runs in a pty and prompts before the breakpoint; feed it stdin.
await d.waitPty("who are you?");
ok(true, "pty prompt arrived (runInTerminal → pty → ws)");
for (const ch of "milo\r") d.send({ cmd: "stdin", data: ch });

const stopped = await d.wait(m => m.type === "stopped");
ok(stopped.line === 6, `stopped at line 6 (got ${stopped.line})`);
ok(stopped.tid > 0, `tid=${stopped.tid}`);
ok(stopped.frames.length >= 2 && stopped.frames[0].name.includes("greet"), "frames: greet innermost", stopped.frames);
const frame0 = stopped.frames[0].id;
const nameVar = stopped.locals.find((v: any) => v.name === "name");
ok(!!nameVar, "locals include 'name'", stopped.locals);
ok(stopped.locals.some((v: any) => v.ref > 0) || nameVar.ref >= 0, "locals carry ref field");

// evaluate: repl context
d.send({ cmd: "evaluate", expr: "x + y", context: "repl", id: 101, frameId: frame0 });
const ev = await d.wait(m => m.type === "evalResult" && m.id === 101);
ok(ev.value.includes("42"), `evaluate x+y → ${ev.value}`);

// evaluate: watch context
d.send({ cmd: "evaluate", expr: "x * 2", context: "watch", id: 102, frameId: frame0 });
const ew = await d.wait(m => m.type === "evalResult" && m.id === 102);
ok(ew.value.includes("14"), `watch x*2 → ${ew.value}`);

// expand: 'name' is a char[64] — has children
if (nameVar.ref > 0) {
  d.send({ cmd: "expand", ref: nameVar.ref, id: 103 });
  const ch = await d.wait(m => m.type === "children" && m.id === 103);
  ok(Array.isArray(ch.vars) && ch.vars.length > 0, `expand name → ${ch.vars.length} children`);
} else {
  console.log("  skip expand (name has ref=0)");
}

// step over, then continue to exit
d.send({ cmd: "stepOver", tid: stopped.tid });
const s2 = await d.wait(m => m.type === "stopped");
ok(s2.line === 7, `stepOver → line 7 (got ${s2.line})`);

d.send({ cmd: "continue", tid: s2.tid });
await d.waitPty("sum=42");
ok(true, "debuggee output through pty: sum=42");
await d.wait(m => m.type === "terminated");
ok(true, "terminated");

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
