// Debug-target config drawer: Monaco JSON editor (schema-validated) showing the
// server's live config. Edits auto-apply (debounced) via the setConfig WS
// command while idle — Run then launches whatever's applied. History is
// server-owned (arrives via hello / historyChanged); the drawer only displays it
// and re-applies on click.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";

// The config IS a VS Code launch-configuration object: program + any launch.json
// keys (type/request/name/args/env/cwd/...) pass through verbatim. `launch` is
// the legacy nested shape, still accepted.
export type DebugConfig = { program?: string; source?: string; dapPath?: string; launch?: Record<string, any>; [k: string]: any };

const SCHEMA = {
  type: "object",
  additionalProperties: true,   // launch.json passthrough: args/env/cwd + any adapter-specific keys all valid
  properties: {
    // ── envelope: how hades reaches the adapter (first-classed + validated) ──
    type: { type: "string", enum: ["lldb", "cppdbg", "python", "node", "go"], description: "dialect (inferred from program if unset)" },
    request: { type: "string", enum: ["launch", "attach"], description: "launch a program (default) or attach to a running one" },
    dapPath: { type: "string", description: 'explicit DAP adapter command for stdio, e.g. "lldb-dap", "dlv dap", "python3 -m debugpy.adapter" (else probed from type)' },
    port: { type: "integer", description: "connect to a DAP adapter over TCP on this port instead of spawning one (e.g. `dlv dap --listen=:PORT`)" },
    host: { type: "string", description: "TCP host for `port` (default 127.0.0.1)" },
    // ── body: passed verbatim into the DAP launch/attach request ──
    program: { type: "string", description: "launch: path to the debuggee binary/script" },
    source: { type: "string", description: "main source file (optional — auto-detected from the first stop)" },
    pid: { type: "integer", description: "attach: process id to attach to" },
    stopOnEntry: { type: "boolean", description: "break at program entry" },
    launch: {
      type: "object",
      description: "legacy nested body (flat keys preferred): args, env, cwd, lldb initCommands/preRunCommands/stopCommands, \u2026",
    },
  },
};

monaco.languages.json?.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  schemas: [{ uri: "hades://launch-config", fileMatch: ["*"], schema: SCHEMA }],
});

export default function ConfigDrawer({ config, caps, idle, error, history, onApply, onClose }: {
  config: DebugConfig; caps: Record<string, any>; idle: boolean; error: string;
  history: DebugConfig[];
  onApply: (c: DebugConfig) => void; onClose: () => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [parseErr, setParseErr] = useState("");
  const idleRef = useRef(idle); idleRef.current = idle;
  const applyTimer = useRef<any>(null);
  // Set while we push a server-originated config into the editor, so the
  // resulting change event doesn't bounce a redundant setConfig back.
  const syncingRef = useRef(false);
  // A user edit is pending since the last apply — gates the apply-on-idle flush
  // so mounting / server-sync never fire a spurious setConfig.
  const dirtyRef = useRef(false);
  // Reassigned every render so the (once-attached) change listener always runs
  // the latest onApply / idle.
  const scheduleRef = useRef<() => void>(() => {});

  const applyNow = () => {
    let c: DebugConfig;
    try { c = JSON.parse(edRef.current!.getValue()); }
    catch (e: any) { setParseErr(`invalid JSON: ${e.message}`); return; }
    // Attach targets a pid, not a program — only launch needs one.
    const isAttach = c.request === "attach";
    if (!isAttach && !c.program) { setParseErr("program is required"); return; }
    // A freshly-picked template ships a placeholder path — don't auto-apply until filled in.
    if (c.program && /^\/path\/to\//.test(c.program)) { setParseErr(""); return; }
    // Attach with the pid still at its 0 placeholder: wait, same as above.
    if (isAttach && !c.pid) { setParseErr(""); return; }
    setParseErr("");
    dirtyRef.current = false;
    onApply(c);   // server records history on a successful launch — client never saves
  };
  scheduleRef.current = () => {
    if (syncingRef.current) return;   // programmatic server-sync, not a user edit
    dirtyRef.current = true;
    if (!idleRef.current) return;     // can't apply mid-session; flushes when it ends
    clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(applyNow, 600);
  };

  useEffect(() => {
    const ed = monaco.editor.create(elRef.current!, {
      value: JSON.stringify(config, null, 2),
      language: "json",
      theme: "vs-dark",
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbers: "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      folding: false,
    });
    edRef.current = ed;
    (window as any).__hadesConfigEditor = ed;  // test hook (browser_repro2)
    const sub = ed.onDidChangeModelContent(() => {
      scheduleRef.current();
      // Mirror the editor into the form dropdowns (best-effort — ignore
      // mid-edit invalid JSON). Runs for server-syncs too, so the form always
      // reflects what's in the editor.
      try { setFormCfg(JSON.parse(ed.getValue())); } catch {}
    });
    return () => { sub.dispose(); ed.dispose(); };
  }, []);

  // Keep the editor in sync with the server's live config (last-run restore,
  // other tabs, session end) unless the user is actively editing it.
  const cfgJson = JSON.stringify(config, null, 2);
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || ed.hasTextFocus()) return;
    if (ed.getValue() === cfgJson) return;
    syncingRef.current = true;
    ed.setValue(cfgJson);
    syncingRef.current = false;
  }, [cfgJson]);

  // Flush a pending user edit once a running session ends ("applies after it
  // ends"). Only when actually dirty — never on mount or server-sync.
  useEffect(() => { if (idle && dirtyRef.current) scheduleRef.current(); }, [idle]);

  // Load a history entry into the editor, dropping the server-only lastRunAt stamp.
  const load = (c: DebugConfig) => {
    const { lastRunAt, ...cfg } = c as any;
    edRef.current?.setValue(JSON.stringify(cfg, null, 2));
  };

  // ── config form: three orthogonal axes over the same JSON config ──
  // Debugger picks the adapter (type + stdio command); Mode is launch vs
  // attach; Transport is spawn-over-stdio vs connect-over-TCP. Each writes into
  // the editor (the source of truth) — power fields (args/env/…) stay in JSON.
  const [formCfg, setFormCfg] = useState<DebugConfig>(config);

  const DEBUGGERS: Record<string, { label: string; type: string; dapPath: string }> = {
    lldb:   { label: "C / C++ / Rust (lldb)", type: "lldb",   dapPath: "lldb-dap" },
    python: { label: "Python (debugpy)",      type: "python", dapPath: "python3 -m debugpy.adapter" },
    go:     { label: "Go (delve)",            type: "go",     dapPath: "dlv dap" },
  };
  const dbgKey =
    formCfg.type === "python" || formCfg.type === "go" ? formCfg.type :
    formCfg.type === "lldb" || formCfg.type === "cppdbg" ? "lldb" :
    String(formCfg.dapPath || "").includes("debugpy") ? "python" :
    String(formCfg.dapPath || "").includes("dlv") ? "go" : "lldb";
  const mode = formCfg.request === "attach" ? "attach" : "launch";
  const transport = formCfg.port ? "tcp" : "stdio";

  // Write a mutated config back to the editor (which re-triggers apply-on-idle).
  const patchCfg = (mut: (c: DebugConfig) => void) => {
    const c: DebugConfig = { ...formCfg };
    mut(c);
    setFormCfg(c);
    edRef.current?.setValue(JSON.stringify(c, null, 2));
  };
  // dapPath only makes sense over stdio — on TCP the adapter is already running.
  const pickDebugger = (k: string) => patchCfg((c) => { c.type = DEBUGGERS[k].type; if (!c.port) c.dapPath = DEBUGGERS[k].dapPath; else delete c.dapPath; });
  const pickMode = (m: string) => patchCfg((c) => {
    if (m === "attach") { c.request = "attach"; if (c.pid === undefined) c.pid = 0; }
    else { delete c.request; delete c.pid; }
  });
  const pickTransport = (t: string) => patchCfg((c) => {
    // TCP connects to a running adapter — dapPath (a stdio spawn command) no
    // longer applies, so drop it to avoid a misleading value.
    if (t === "tcp") { c.port = c.port || 12345; c.host = c.host || "127.0.0.1"; delete c.dapPath; }
    else { delete c.port; delete c.host; if (!c.dapPath) c.dapPath = DEBUGGERS[dbgKey].dapPath; }
  });

  return (
    <div className="drawer">
      <div className="drawer-head">
        <h2>Debug Target</h2>
        {/* codicon chevron-left — the ttf ships with monaco (see App.tsx CI table) */}
        <button className="drawer-hide" title="Hide panel" onClick={onClose}>
          <span className="ci">{String.fromCodePoint(0xeab5)}</span>
        </button>
      </div>
      <div className="drawer-form">
        <label className="cfg-field">
          <span>Debugger</span>
          <select value={dbgKey} onChange={(e) => pickDebugger(e.target.value)}>
            {Object.entries(DEBUGGERS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
          </select>
        </label>
        <label className="cfg-field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => pickMode(e.target.value)}>
            <option value="launch">Launch a program</option>
            <option value="attach">Attach to a process</option>
          </select>
        </label>
        {mode === "attach" && (
          <label className="cfg-field">
            <span>PID</span>
            <input type="number" min={0} value={formCfg.pid ?? 0}
                   onChange={(e) => patchCfg((c) => { c.pid = Number(e.target.value); })} />
          </label>
        )}
        <label className="cfg-field">
          <span>Transport</span>
          <select value={transport} onChange={(e) => pickTransport(e.target.value)}>
            <option value="stdio">Spawn the adapter (stdio)</option>
            <option value="tcp">Connect to a running adapter (TCP)</option>
          </select>
        </label>
        {transport === "tcp" && (
          <div className="cfg-hostport">
            <label className="cfg-field">
              <span>Host</span>
              <input value={formCfg.host ?? "127.0.0.1"}
                     onChange={(e) => patchCfg((c) => { c.host = e.target.value; })} />
            </label>
            <label className="cfg-field">
              <span>Port</span>
              <input type="number" min={1} max={65535} value={formCfg.port ?? 12345}
                     onChange={(e) => patchCfg((c) => { c.port = Number(e.target.value); })} />
            </label>
          </div>
        )}
      </div>
      <div className="drawer-editor" ref={elRef} />
      {!idle
        ? <div className="cfg-note">session active — edits apply after it ends</div>
        : <div className="cfg-note">edits apply automatically — then press ▶ Run to launch</div>}
      {(parseErr || error) && <div className="cfg-err">{parseErr || error}</div>}
      {Object.keys(caps).length > 0 && (
        <div className="drawer-caps">
          <h2>Adapter Capabilities</h2>
          <div className="caps-list">
            {Object.keys(caps).filter((k) => caps[k] === true).sort()
              .map((k) => <span key={k} className="cap">{k.replace(/^supports/, "")}</span>)}
          </div>
        </div>
      )}
      <div className="drawer-hist">
        <h2>History</h2>
        {history.length
          ? history.map((h, i) => (
              <div key={i} className="hist-row" onClick={() => load(h)} title={h.dapPath || h.type || ""}>
                <span className="hist-prog">
                  {h.type && <span className={"hist-type dt-" + h.type}>{h.type}</span>}
                  {h.program}{h.args ? " " + (h.args as string[]).join(" ") : ""}
                </span>
                {h.source && <span className="hist-src">{h.source}</span>}
              </div>
            ))
          : <span className="hint">no previous targets</span>}
      </div>
    </div>
  );
}
