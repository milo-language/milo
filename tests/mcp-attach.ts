// E2E for M9 co-debug: hades-mcp --attach joins a live hades-web session as a
// second peer. A "browser" ws peer drives to a stop, then the MCP peer reads
// state, steps, and evaluates — and the browser peer sees every stop too.
// Needs hades-web on [port] targeting /tmp/hades_nested. Usage: bun tests/mcp-attach.ts [port]

import { spawn } from "bun";

const port = process.argv[2] ?? "8092";
const url = `ws://localhost:${port}/ws`;
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

// browser peer
const q: any[] = []; const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
const ws = new WebSocket(url);
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  const i = waiters.findIndex(w => w.pred(m));
  if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else q.push(m);
};
const wait = (pred: (m: any) => boolean, ms = 20000): Promise<any> => {
  const i = q.findIndex(pred);
  if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
  return Promise.race([new Promise<any>(r => waiters.push({ pred, resolve: r })), timeout(ms)]);
};
await new Promise((res, rej) => { (ws as any).onopen = res; (ws as any).onerror = rej; });
const hello = await wait(m => m.type === "hello");
ws.send(JSON.stringify({ cmd: "setBreakpoint", path: hello.sourcePath, line: 23 }));
await wait(m => m.type === "breakpoint");
ws.send(JSON.stringify({ cmd: "run", stopAtMain: true }));
const s1 = await wait(m => m.type === "stopped");
ok(s1.line === 14, `browser peer stopped at main (line ${s1.line})`);

// MCP co-debug peer
const mcp = spawn(["./hades", "mcp", "--attach", `localhost:${port}`, "--source", hello.sourcePath],
                  { cwd: import.meta.dir + "/..", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const rl = mcp.stdout.getReader();
let outBuf = "";
async function rpc(obj: any, ms = 20000): Promise<any> {
  mcp.stdin.write(JSON.stringify(obj) + "\n");
  await mcp.stdin.flush();
  const dl = Date.now() + ms;
  while (true) {
    const nl = outBuf.indexOf("\n");
    if (nl >= 0) {
      const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
      if (line.trim()) { const m = JSON.parse(line); if (m.id === obj.id) return m; continue; }
      continue;
    }
    if (Date.now() > dl) throw new Error("mcp rpc timeout");
    const { value, done } = await Promise.race([rl.read(), timeout(dl - Date.now())]) as any;
    if (done) throw new Error("mcp stdout closed");
    outBuf += new TextDecoder().decode(value);
  }
}
const toolText = (r: any) => JSON.parse(r.result.content[0].text);

await new Promise(r => setTimeout(r, 500));  // let the ws attach + replay land
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
ok(init.result.serverInfo.name === "hades", "mcp initialize");
const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
ok(tools.result.tools.some((t: any) => t.name === "debug_state"), "debug_state tool listed");

// state reflects the stop the HUMAN drove
const st = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "debug_state", arguments: {} } });
const snap = toolText(st);
ok(snap.stopped === true && snap.line === 14, `mcp sees human's stop (line ${snap.line})`, snap);

// MCP steps; browser peer must see the resulting stop broadcast
const step = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "debug_step", arguments: { kind: "over" } } });
const snap2 = toolText(step);
ok(snap2.stopped === true && snap2.line !== 14, `mcp stepped (line ${snap2.line})`, snap2);
const sBrowser = await wait(m => m.type === "stopped");
ok(sBrowser.line === snap2.line, `browser saw mcp's step (line ${sBrowser.line})`);

// MCP evaluates in the shared frame
const ev = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "debug_evaluate", arguments: { expr: "shapes[0].sides" } } });
const evv = toolText(ev);
ok(typeof evv.value === "string" && evv.value.includes("3"), `mcp evaluate → ${evv.value}`, evv);

// MCP continues to the human's breakpoint
const cont = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "debug_continue", arguments: {} } });
const snap3 = toolText(cont);
ok(snap3.stopped === true && snap3.line === 23, `mcp continue → human's bp (line ${snap3.line})`, snap3);
await wait(m => m.type === "stopped" && m.line === 23);
ok(true, "browser saw that stop too");

// cleanup: browser kills the session; mcp peer keeps running (its ws just reports exited)
ws.send(JSON.stringify({ cmd: "kill" }));
await wait(m => m.type === "terminated");
const st2 = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "debug_state", arguments: {} } });
ok(toolText(st2).exited === true, "mcp sees session end");
mcp.kill();

console.log(`\nall ${pass} assertions passed`);
process.exit(0);
