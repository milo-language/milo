// End-to-end DAP session against java-dap: launch a real JVM, plant a deferred
// breakpoint, hit it, walk stack/scopes/variables, evaluate, step, continue,
// disconnect. Run: bun examples/tools/java-dap/scripts/dap-e2e.ts <adapter-bin>
//
// Exercises the same request sequence hades sends (initialize → launch →
// [initialized] → setBreakpoints → configurationDone → ...).

import { spawn } from "bun";

const adapterBin = process.argv[2];
if (!adapterBin) {
  console.error("usage: bun dap-e2e.ts <path-to-java-dap-binary>");
  process.exit(2);
}

const appDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const fixtures = `${appDir}/tests/fixtures`;
const program = `${fixtures}/HelloLoop.java`;
const jdwpPort = Number(process.env.JAVA_DAP_E2E_PORT ?? (16000 + Math.floor(Math.random() * 4000)));

const proc = spawn({
  cmd: [adapterBin],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

// stderr passthrough for debugging
(async () => {
  for await (const chunk of proc.stderr) {
    process.stderr.write(new TextDecoder().decode(chunk));
  }
})();

let seq = 0;
function send(command: string, args: unknown = {}) {
  seq += 1;
  const body = JSON.stringify({ seq, type: "request", command, arguments: args });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  proc.stdin.flush();
  return seq;
}

// incoming frame pump → message queue + waiters
type Msg = Record<string, any>;
const inbox: Msg[] = [];
const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
function offer(m: Msg) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].pred(m)) {
      const w = waiters.splice(i, 1)[0];
      w.resolve(m);
      return;
    }
  }
  inbox.push(m);
}
function waitFor(desc: string, pred: (m: Msg) => boolean, timeoutMs = 15000): Promise<Msg> {
  const i = inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${desc}`)), timeoutMs);
    waiters.push({
      pred,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}

(async () => {
  let buf = new Uint8Array(0);
  for await (const chunk of proc.stdout) {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    while (true) {
      const text = new TextDecoder().decode(buf);
      const m = text.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!m) break;
      const headerLen = m[0].length;
      const bodyLen = Number(m[1]);
      if (buf.length < headerLen + bodyLen) break;
      const body = new TextDecoder().decode(buf.slice(headerLen, headerLen + bodyLen));
      buf = buf.slice(headerLen + bodyLen);
      offer(JSON.parse(body));
    }
  }
})();

const response = (rs: number) => (m: Msg) => m.type === "response" && m.request_seq === rs;
const event = (name: string) => (m: Msg) => m.type === "event" && m.event === name;

function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok: ${what}`);
}

try {
  // initialize
  let rs = send("initialize", { adapterID: "java-dap", linesStartAt1: true });
  let r = await waitFor("initialize response", response(rs));
  check(r.success && r.body?.supportsConfigurationDoneRequest === true, "initialize capabilities");

  // launch (spawns JVM suspended)
  rs = send("launch", {
    program,
    classPaths: [fixtures],
    jdwpPort,
  });
  r = await waitFor("launch response", response(rs), 30000);
  check(r.success, "launch succeeds");
  await waitFor("initialized event", event("initialized"));
  console.log("ok: initialized event");

  // deferred breakpoint on `return n + 1;` in bump()
  rs = send("setBreakpoints", {
    source: { path: program },
    breakpoints: [{ line: 19 }],
  });
  r = await waitFor("setBreakpoints response", response(rs));
  check(r.success && r.body.breakpoints.length === 1, "setBreakpoints answered");
  check(r.body.breakpoints[0].verified === false, "breakpoint deferred (class not loaded)");

  // configurationDone → VM resumes → class loads → bp verifies → bp hits
  rs = send("configurationDone");
  r = await waitFor("configurationDone response", response(rs));
  check(r.success, "configurationDone");

  const bpEv = await waitFor("breakpoint verified event", (m) =>
    m.type === "event" && m.event === "breakpoint" && m.body?.breakpoint?.verified === true);
  check(bpEv.body.breakpoint.line === 19, "deferred breakpoint verified at line 19");

  const stopped = await waitFor("stopped event", event("stopped"));
  check(stopped.body.reason === "breakpoint", "stopped reason=breakpoint");
  const tid = stopped.body.threadId;

  // threads
  rs = send("threads");
  r = await waitFor("threads response", response(rs));
  const names = r.body.threads.map((t: Msg) => t.name);
  check(names.includes("main"), `threads include main (${names.join(", ")})`);

  // stackTrace
  rs = send("stackTrace", { threadId: tid });
  r = await waitFor("stackTrace response", response(rs));
  const top = r.body.stackFrames[0];
  check(top.name === "HelloLoop.bump", `top frame is HelloLoop.bump (${top.name})`);
  check(top.line === 19, `top frame line 19 (${top.line})`);
  check(top.source?.path === program, "top frame source path");
  check(r.body.stackFrames.some((f: Msg) => f.name === "HelloLoop.main"), "main on stack");

  // scopes + variables: local n
  rs = send("scopes", { frameId: top.id });
  r = await waitFor("scopes response", response(rs));
  const locals = r.body.scopes.find((s: Msg) => s.name === "Locals");
  check(!!locals, "Locals scope");

  rs = send("variables", { variablesReference: locals.variablesReference });
  r = await waitFor("variables response", response(rs));
  const nVar = r.body.variables.find((v: Msg) => v.name === "n");
  check(!!nVar && nVar.type === "int", "local n:int visible");
  check(nVar.value === "0", `n == 0 on first hit (${nVar?.value})`);

  // evaluate
  rs = send("evaluate", { expression: "n", frameId: top.id });
  r = await waitFor("evaluate response", response(rs));
  check(r.success && r.body.result === "0", `evaluate n → 0 (${r.body?.result})`);

  // step out of bump back into main
  rs = send("next", { threadId: tid });
  r = await waitFor("next response", response(rs));
  check(r.success, "next accepted");
  const stepStop = await waitFor("step stopped", event("stopped"));
  check(stepStop.body.reason === "step", "stopped reason=step");

  // continue → second bp hit, n should now be 1
  rs = send("continue", { threadId: tid });
  r = await waitFor("continue response", response(rs));
  check(r.success, "continue accepted");
  const stop2 = await waitFor("second bp stop", event("stopped"));
  check(stop2.body.reason === "breakpoint", "second stop is breakpoint");

  rs = send("stackTrace", { threadId: stop2.body.threadId });
  r = await waitFor("stackTrace2", response(rs));
  const top2 = r.body.stackFrames[0];
  rs = send("scopes", { frameId: top2.id });
  r = await waitFor("scopes2", response(rs));
  const locals2 = r.body.scopes.find((s: Msg) => s.name === "Locals");
  rs = send("variables", { variablesReference: locals2.variablesReference });
  r = await waitFor("variables2", response(rs));
  const nVar2 = r.body.variables.find((v: Msg) => v.name === "n");
  check(nVar2?.value === "1", `n == 1 on second hit (${nVar2?.value})`);

  // program output should have flowed as output events by now
  // (tick 1 printed between the two hits)
  rs = send("disconnect", { terminateDebuggee: true });
  r = await waitFor("disconnect response", response(rs));
  check(r.success, "disconnect");

  console.log("E2E PASS");
  process.exit(0);
} catch (e) {
  console.error(String(e));
  try { proc.kill(); } catch {}
  process.exit(1);
}
