// E2E for `hades mcp`: drives the MCP stdio protocol like an AI client would.
// Usage: bun tests/mcp.ts [path-to-hades]
import { spawn } from "bun";

const bin = process.argv[2] ?? "./hades";
const proc = spawn([bin, "mcp", "--program", "/tmp/hades_demo", "--source", "/tmp/hades_demo.c"], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
});

const reader = proc.stdout.getReader();
let buf = "";
async function readMsg(ms = 20000): Promise<any> {
  const deadline = Date.now() + ms;
  while (true) {
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) return JSON.parse(line);
      continue;
    }
    if (Date.now() > deadline) throw new Error("timeout waiting for MCP message");
    const { value, done } = await reader.read();
    if (done) throw new Error("mcp server closed stdout");
    buf += new TextDecoder().decode(value);
  }
}
function sendMsg(obj: any) { proc.stdin.write(JSON.stringify(obj) + "\n"); proc.stdin.flush(); }

let id = 0;
async function rpc(method: string, params?: any): Promise<any> {
  sendMsg({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) });
  const resp = await readMsg();
  if (resp.id !== id) throw new Error(`id mismatch: ${JSON.stringify(resp)}`);
  return resp;
}
async function tool(name: string, args: any = {}): Promise<any> {
  const resp = await rpc("tools/call", { name, arguments: args });
  if (resp.error) throw new Error(`rpc error: ${JSON.stringify(resp.error)}`);
  return JSON.parse(resp.result.content[0].text);
}

let pass = 0;
function ok(cond: boolean, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, JSON.stringify(detail).slice(0, 300)); process.exit(1); }
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
ok(init.result.serverInfo.name === "hades", "initialize → serverInfo hades");
sendMsg({ jsonrpc: "2.0", method: "notifications/initialized" });

const tools = await rpc("tools/list");
const names = tools.result.tools.map((t: any) => t.name);
ok(names.includes("debug_launch") && names.includes("debug_evaluate"), `tools/list → ${names.length} tools`);

const snap = await tool("debug_launch", { breakpoints: [6] });
ok(snap.stopped === true && snap.line === 6, "launch → stopped at 6", snap);
ok(snap.frames?.[0]?.name.includes("add"), "frame0 is add()", snap.frames);
ok(snap.locals?.some((v: any) => v.name === "a" && v.value === "7"), "locals a=7", snap.locals);

const ev = await tool("debug_evaluate", { expr: "a + b" });
ok(ev.value.includes("42"), `evaluate a+b → ${ev.value}`);

const step = await tool("debug_step", { kind: "over" });
ok(step.stopped === true && step.line === 7, "step over → line 7", step);

const cont = await tool("debug_continue", {});
ok(cont.exited === true, "continue → exited", cont);
ok(cont.output.includes("r=42"), "output captured r=42", cont.output);

const term = await tool("debug_terminate", {});
ok(term.ok === true, "terminate ok");

console.log(`\nall ${pass} assertions passed`);
proc.kill();
process.exit(0);
