// Integration proof: hades (the repo's DAP client) debugging Java through
// java-dap. Drives `hades mcp` over stdio JSON-RPC:
//   debug_launch{breakpoints:[19]} → stop snapshot → debug_evaluate n →
//   debug_step → debug_continue → debug_terminate.
// Run: bun hades-e2e.ts <hades-bin> <java-dap-bin>

import { spawn } from "bun";

const [hadesBin, adapterBin] = [process.argv[2], process.argv[3]];
if (!hadesBin || !adapterBin) {
  console.error("usage: bun hades-e2e.ts <hades-bin> <java-dap-bin>");
  process.exit(2);
}

const appDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const program = `${appDir}/tests/fixtures/HelloLoop.java`;

const proc = spawn({
  cmd: [hadesBin, "mcp", "--program", program, "--source", program, "--dapPath", adapterBin],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
(async () => {
  for await (const chunk of proc.stderr) process.stderr.write(new TextDecoder().decode(chunk));
})();

let nextId = 0;
const pending = new Map<number, (v: any) => void>();
function call(method: string, params: unknown = {}): Promise<any> {
  nextId += 1;
  const id = nextId;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  proc.stdin.flush();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 60000);
    pending.set(id, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}
function toolCall(name: string, args: unknown = {}): Promise<any> {
  return call("tools/call", { name, arguments: args }).then((r) => {
    const text = r?.result?.content?.[0]?.text ?? "{}";
    return JSON.parse(text);
  });
}

(async () => {
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += new TextDecoder().decode(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  }
})();

function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok: ${what}`);
}

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  check(init?.result?.serverInfo?.name === "hades", "hades mcp initialize");

  const snap = await toolCall("debug_launch", { breakpoints: [19] });
  check(snap.line === 19, `stopped at line 19 (got ${snap.line})`);
  check(JSON.stringify(snap).includes("bump"), "snapshot mentions bump frame");
  const locals = snap.locals ?? snap.frames?.[0]?.locals ?? [];
  check(JSON.stringify(locals).includes('"n"'), "locals include n");

  const ev = await toolCall("debug_evaluate", { expr: "n" });
  check(JSON.stringify(ev).includes("0"), `evaluate n → 0 (${JSON.stringify(ev)})`);

  const step = await toolCall("debug_step", { kind: "over" });
  check(typeof step.line === "number" && step.line !== 19, `step moved off 19 (line ${step.line})`);

  const cont = await toolCall("debug_continue", {});
  check(cont.line === 19, `continue re-hits bp at 19 (line ${cont.line})`);

  const ev2 = await toolCall("debug_evaluate", { expr: "n" });
  check(JSON.stringify(ev2).includes("1"), `second hit: n == 1 (${JSON.stringify(ev2)})`);

  await toolCall("debug_terminate", {});
  console.log("HADES E2E PASS");
  proc.kill();
  process.exit(0);
} catch (e) {
  console.error(String(e));
  try { proc.kill(); } catch {}
  process.exit(1);
}
