// End-to-end DAP session for exception breakpoints: launch Thrower, arm the
// caught+uncaught filters, catch the stopped(reason=exception), and verify
// exceptionInfo reports the NPE type + break mode. Then a second session drives
// a caught IllegalStateException("boom") to confirm detailMessage extraction
// (walks Throwable's superclass) and breakMode=always.
// Run: bun examples/apps/java-dap/scripts/exception-e2e.ts <adapter-bin>

import { spawn } from "bun";

const adapterBin = process.argv[2];
if (!adapterBin) {
  console.error("usage: bun exception-e2e.ts <path-to-java-dap-binary>");
  process.exit(2);
}

const appDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const fixtures = `${appDir}/tests/fixtures`;

type Msg = Record<string, any>;

// One scripted DAP session over a fresh adapter process.
function session() {
  const proc = spawn({ cmd: [adapterBin], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  (async () => {
    for await (const chunk of proc.stderr) process.stderr.write(new TextDecoder().decode(chunk));
  })();

  let seq = 0;
  const send = (command: string, args: unknown = {}) => {
    seq += 1;
    const body = JSON.stringify({ seq, type: "request", command, arguments: args });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    proc.stdin.flush();
    return seq;
  };

  const inbox: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  const offer = (m: Msg) => {
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) { waiters.splice(i, 1)[0].resolve(m); return; }
    }
    inbox.push(m);
  };
  const waitFor = (desc: string, pred: (m: Msg) => boolean, timeoutMs = 20000): Promise<Msg> => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${desc}`)), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };

  (async () => {
    let buf = new Uint8Array(0);
    for await (const chunk of proc.stdout) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf); merged.set(chunk, buf.length); buf = merged;
      while (true) {
        const text = new TextDecoder().decode(buf);
        const m = text.match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m) break;
        const headerLen = m[0].length, bodyLen = Number(m[1]);
        if (buf.length < headerLen + bodyLen) break;
        offer(JSON.parse(new TextDecoder().decode(buf.slice(headerLen, headerLen + bodyLen))));
        buf = buf.slice(headerLen + bodyLen);
      }
    }
  })();

  return { proc, send, waitFor };
}

const response = (rs: number) => (m: Msg) => m.type === "response" && m.request_seq === rs;
const event = (name: string) => (m: Msg) => m.type === "event" && m.event === name;
function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok: ${what}`);
}

// Launch `mainClass`, arm `filters`, return the stopped event + exceptionInfo body.
async function runToException(mainClass: string, filters: string[]) {
  const s = session();
  try {
    let rs = s.send("initialize", { adapterID: "java-dap", linesStartAt1: true });
    let r = await s.waitFor("initialize response", response(rs));
    check(r.success, `[${mainClass}] initialize`);
    check(Array.isArray(r.body?.exceptionBreakpointFilters)
      && r.body.exceptionBreakpointFilters.some((f: Msg) => f.filter === "uncaught")
      && r.body.exceptionBreakpointFilters.some((f: Msg) => f.filter === "caught"),
      `[${mainClass}] advertises caught+uncaught filters`);
    check(r.body?.supportsExceptionInfoRequest === true, `[${mainClass}] supportsExceptionInfoRequest`);

    const jdwpPort = 16000 + Math.floor(Math.random() * 4000);
    rs = s.send("launch", { mainClass, classPaths: [fixtures], jdwpPort });
    r = await s.waitFor("launch response", response(rs), 30000);
    check(r.success, `[${mainClass}] launch`);
    await s.waitFor("initialized event", event("initialized"));

    rs = s.send("setExceptionBreakpoints", { filters });
    r = await s.waitFor("setExceptionBreakpoints response", response(rs));
    check(r.success, `[${mainClass}] setExceptionBreakpoints`);

    rs = s.send("configurationDone");
    await s.waitFor("configurationDone response", response(rs));

    const stopped = await s.waitFor("stopped(exception)", event("stopped"));
    check(stopped.body.reason === "exception", `[${mainClass}] stopped reason=exception (${stopped.body.reason})`);

    rs = s.send("exceptionInfo", { threadId: stopped.body.threadId });
    r = await s.waitFor("exceptionInfo response", response(rs));
    check(r.success, `[${mainClass}] exceptionInfo`);
    return { stopped, info: r.body as Msg };
  } finally {
    try { s.send("disconnect", { terminateDebuggee: true }); } catch {}
    await new Promise((res) => setTimeout(res, 400));
    try { s.proc.kill(); } catch {}
  }
}

try {
  // 1) uncaught NPE
  const npe = await runToException("Thrower", ["caught", "uncaught"]);
  check(/NullPointerException/.test(npe.info.exceptionId ?? ""), `NPE exceptionId (${npe.info.exceptionId})`);
  check(npe.info.breakMode === "unhandled", `NPE breakMode=unhandled (${npe.info.breakMode})`);

  // 2) caught IllegalStateException with a message → detailMessage extracted
  const ise = await runToException("Caught", ["caught"]);
  check(/IllegalStateException/.test(ise.info.exceptionId ?? ""), `ISE exceptionId (${ise.info.exceptionId})`);
  check(ise.info.breakMode === "always", `ISE breakMode=always (${ise.info.breakMode})`);
  check(/boom message/.test(ise.info.details?.message ?? ""), `ISE detailMessage extracted (${ise.info.details?.message})`);

  console.log("EXCEPTION E2E PASS");
  process.exit(0);
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
