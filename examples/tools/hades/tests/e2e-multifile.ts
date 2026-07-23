// E2E for M8m (per-file breakpoints, cross-file frames), M8f (completions),
// M8k (readMemory), M8i granularity stepping. Needs hades-web on [port]
// targeting /tmp/hades_nested with --source .../examples/nested/main.c.
// Usage: bun tests/e2e-multifile.ts [port]

const port = process.argv[2] ?? "8092";
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
}

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

const d = new Driver();
await d.connect();
const hello = await d.wait(m => m.type === "hello");
const mainC = hello.sourcePath as string;
const shapesC = mainC.replace(/main\.c$/, "shapes.c");
await d.wait(m => m.type === "source");

// per-file bps: one in each file, before launch
d.send({ cmd: "setBreakpoint", path: shapesC, line: 24 });
await d.wait(m => m.type === "breakpoint" && m.line === 24);
d.send({ cmd: "setBreakpoint", path: mainC, line: 23 });
await d.wait(m => m.type === "breakpoint" && m.line === 23);
// exception filters before run — exercises the ebInit configuration step
d.send({ cmd: "setExceptions", filters: ["cpp_throw"] });

d.send({ cmd: "run" });
const s1 = await d.wait(m => m.type === "stopped");
ok(s1.frames[0].path.endsWith("shapes.c") && s1.line === 24,
   `first stop in shapes.c:24 (got ${s1.frames[0].path}:${s1.line})`);
ok(s1.frames.some((f: any) => f.path.endsWith("main.c")), "stack crosses files", s1.frames);

// nested data: expand param s → struct members
const sVar = s1.locals.find((v: any) => v.name === "s");
ok(sVar && sVar.ref > 0, "param s expandable", s1.locals);
d.send({ cmd: "expand", ref: sVar.ref, id: 401 });
let kids = (await d.wait(m => m.type === "children" && m.id === 401)).vars;
// pointer param: first level may be the pointee — drill once if needed
if (kids.length === 1 && kids[0].ref > 0) {
  d.send({ cmd: "expand", ref: kids[0].ref, id: 402 });
  kids = (await d.wait(m => m.type === "children" && m.id === 402)).vars;
}
ok(kids.some((v: any) => v.name === "center") && kids.some((v: any) => v.name === "verts"),
   "nested struct members visible (center, verts)", kids);

// M8f completions
d.send({ cmd: "complete", text: "su", column: 3, frameId: s1.frames[0].id, id: 403 });
const comp = await d.wait(m => m.type === "completions" && m.id === 403);
ok(Array.isArray(comp.targets), `completions returned ${comp.targets.length} targets`);

// M8k readMemory at the pc — code bytes, 256 of them
d.send({ cmd: "readMem", memoryReference: s1.frames[0].ipRef, count: 256, id: 404 });
const memR = await d.wait(m => m.type === "memory" && m.id === 404);
ok(!memR.error && typeof memR.data === "string" && atob(memR.data).length > 0,
   `readMemory → ${memR.data ? atob(memR.data).length : 0} bytes at ${memR.address}`);

// M8i: instruction line mapping + granularity step
d.send({ cmd: "disassemble", memoryReference: s1.frames[0].ipRef, id: 405 });
const da = await d.wait(m => m.type === "disasm" && m.id === 405, 20000);
ok(da.instructions.length > 0 && da.instructions.some((i: any) => i.line > 0),
   "disasm carries source-line mapping", da.instructions.slice(0, 2));
d.send({ cmd: "stepOver", tid: s1.tid, granularity: "instruction" });
const s2 = await d.wait(m => m.type === "stopped");
ok(s2.tid === s1.tid, `instruction step → stopped again (line ${s2.line})`);

// live per-file clear: drop the shapes.c bp, next stop must be main.c:23
d.send({ cmd: "clearBreakpoint", path: shapesC, line: 24 });
await d.wait(m => m.type === "breakpoint" && m.line === 24 && m.set === false);
d.send({ cmd: "continue", tid: s2.tid });
const s3 = await d.wait(m => m.type === "stopped");
ok(s3.frames[0].path.endsWith("main.c") && s3.line === 23,
   `after clearing shapes.c bp, stop at main.c:23 (got ${s3.frames[0].path}:${s3.line})`);

// openSource for the other file
d.send({ cmd: "openSource", path: shapesC });
const src = await d.wait(m => m.type === "source" && m.path === shapesC);
ok(src.content.includes("perimeter"), "openSource shapes.c");

// finish: remaining main.c bp hits once more (second shape), then exit
d.send({ cmd: "continue", tid: s3.tid });
const s4 = await d.wait(m => m.type === "stopped");
ok(s4.line === 23, "second main.c:23 hit");
d.send({ cmd: "continue", tid: s4.tid });
await d.wait(m => m.type === "terminated");
ok(d.ptyBuf.includes("total=15.588"), `program completed (pty: ${JSON.stringify(d.ptyBuf.slice(-80))})`);

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
