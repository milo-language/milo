// Debug-target config drawer: a schema-validated Monaco JSON editor holding ONE
// VS Code launch-configuration object. The editor is the single source of truth
// — App reads its live text on Run (no auto-apply, no staging, no autoformat).
// The server only overwrites it on initial load and history-entry click; the
// user's own typing is never reformatted or clobbered. A template picker seeds a
// starter config; per-type schema drives autocomplete. History is server-owned.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// NB: this ESM build EXPORTS jsonDefaults — it does not attach languages.json,
// so `monaco.languages.json?.jsonDefaults` is silently undefined. Import it.
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";

// The config IS a VS Code launch-configuration object: program + any launch.json
// keys (type/request/name/args/env/cwd/...) pass through verbatim to the adapter.
export type DebugConfig = { type?: string; request?: string; program?: string; source?: string; dapPath?: string; [k: string]: any };

// Per-type schema (allOf + if/then keyed on `type`) so Monaco autocompletes the
// keys each adapter actually understands. additionalProperties stays true: any
// adapter-specific key we didn't enumerate is warned (below) but still valid and
// passed verbatim to the DAP body — matches how VS Code treats launch.json.
const COMMON = {
  type: { type: "string", enum: ["lldb", "python", "go", "java", "node"], description: "debugger dialect (inferred from program when unset)" },
  request: { type: "string", enum: ["launch", "attach"], description: "launch a program (default) or attach to a running one" },
  name: { type: "string", description: "optional label — shown in history" },
  program: { type: "string", description: "launch: path to the debuggee binary/script" },
  args: { type: "array", items: { type: "string" }, description: "command-line arguments to the debuggee" },
  cwd: { type: "string", description: "working directory for the debuggee" },
  env: { type: "object", additionalProperties: { type: "string" }, description: "environment variables" },
  stopOnEntry: { type: "boolean", description: "break at the program's entry point" },
  stopAtMain: { type: "boolean", description: "hades: break at main / first user line on launch" },
  // ── hades transport envelope (stripped before the DAP request) ──
  dapPath: { type: "string", description: 'DAP adapter command for stdio, e.g. "lldb-dap", "dlv dap", "python3 -m debugpy.adapter" (else probed from type)' },
  port: { type: "integer", description: "connect to a DAP adapter over TCP on this port instead of spawning one" },
  host: { type: "string", description: "TCP host for `port` (default 127.0.0.1)" },
  source: { type: "string", description: "main source file (optional — auto-detected from the first stop)" },
};

const SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: COMMON,
  required: ["type"],
  allOf: [
    {
      if: { properties: { type: { const: "lldb" } } },
      then: { properties: {
        initCommands: { type: "array", items: { type: "string" }, description: "lldb commands run before the target is created" },
        preRunCommands: { type: "array", items: { type: "string" }, description: "lldb commands run after the target is created, before launch" },
        stopCommands: { type: "array", items: { type: "string" }, description: "lldb commands run each time the program stops" },
        exitCommands: { type: "array", items: { type: "string" }, description: "lldb commands run when the program exits" },
        launchCommands: { type: "array", items: { type: "string" }, description: "custom lldb commands to launch (replaces the default launch)" },
        attachCommands: { type: "array", items: { type: "string" }, description: "custom lldb commands to attach" },
        disableASLR: { type: "boolean", description: "disable address-space layout randomization" },
        pid: { type: "integer", description: "attach: process id to attach to" },
        waitFor: { type: "boolean", description: "attach: wait for the next process named like `program` to launch" },
      } },
    },
    {
      if: { properties: { type: { const: "python" } } },
      then: { properties: {
        module: { type: "string", description: "run a module (python -m) instead of a program file" },
        python: { type: "string", description: "python interpreter path" },
        justMyCode: { type: "boolean", description: "restrict debugging to user-written code" },
        console: { type: "string", enum: ["integratedTerminal", "internalConsole", "externalTerminal"], description: "where the debuggee's stdio goes" },
        subProcess: { type: "boolean", description: "follow child processes" },
        processId: { type: "integer", description: "attach: process id to attach to" },
        connect: { type: "object", properties: { host: { type: "string" }, port: { type: "integer" } }, description: "attach: connect to a running debugpy server" },
      } },
    },
    {
      if: { properties: { type: { const: "go" } } },
      then: { properties: {
        mode: { type: "string", enum: ["debug", "exec", "test"], description: "delve launch mode" },
        buildFlags: { type: "string", description: "flags passed to `go build`" },
        processId: { type: "integer", description: "attach: process id to attach to" },
      } },
    },
    {
      if: { properties: { type: { const: "node" } } },
      then: { properties: {
        runtimeExecutable: { type: "string", description: "node/deno/etc executable" },
        runtimeArgs: { type: "array", items: { type: "string" } },
        skipFiles: { type: "array", items: { type: "string" }, description: "glob patterns to skip while stepping" },
        outFiles: { type: "array", items: { type: "string" }, description: "generated-JS glob patterns for source-map lookup" },
      } },
    },
  ],
};

// The config dialect is JSONC, exactly like VS Code's launch.json: comments and
// trailing commas are fine. Templates lean on that — optional keys ship
// commented out, uncomment what you need. stripJsonc() cleans the text before
// it's parsed/sent; the server is equally lenient (jsonParseJsonc).
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  comments: "ignore",         // severity keys — allowComments alone still flags them
  trailingCommas: "ignore",
  schemas: [{ uri: "hades://launch-config", fileMatch: ["*"], schema: SCHEMA }],
});

// Comments + trailing commas → strict JSON (string-aware; mirrors the server's
// jsonStripJsonc so both ends accept the same dialect).
export function stripJsonc(s: string): string {
  let out = "", i = 0, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; }
    else if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; }
    else out += s[i++];
  }
  // trailing commas: `,` directly before a closing bracket (whitespace between ok)
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// One template per debugger — minimal active keys, common options commented
// out. Uncomment a line instead of hunting a flat launch×attach×type menu.
const TEMPLATES: { label: string; text: string }[] = [
  {
    label: "C / C++ / Rust (lldb)",
    text: `{
  "type": "lldb",
  "program": "/path/to/program",
  "args": [],
  // "stopAtMain": true,
  // "env": { "KEY": "value" },
  // "cwd": "/working/dir",
  // attach to a running process instead:
  // "request": "attach",
  // "pid": 1234,
  // lldb hooks:
  // "initCommands": ["settings set target.x86-disassembly-flavor intel"],
}`,
  },
  {
    label: "Python (debugpy)",
    text: `{
  "type": "python",
  "program": "/path/to/script.py",
  "args": [],
  // "python": "/usr/bin/python3",
  // "justMyCode": false,
  // "env": { "KEY": "value" },
  // attach to a running process instead:
  // "request": "attach",
  // "processId": 1234,
}`,
  },
  {
    label: "Go (delve)",
    text: `{
  "type": "go",
  "program": "/path/to/main.go",
  "args": [],
  // "mode": "debug",           // debug | exec | test
  // attach to a running process instead:
  // "request": "attach",
  // "processId": 1234,
}`,
  },
  {
    label: "Connect over TCP",
    text: `{
  // connect to an already-running DAP adapter, e.g. \`dlv dap --listen=:4711\`
  "type": "go",
  "request": "attach",
  "host": "127.0.0.1",
  "port": 4711,
}`,
  },
];

export default function ConfigDrawer({ config, sessionActive, error, history, onChange, onRun, onClose }: {
  config: DebugConfig; sessionActive: boolean; error: string;
  history: DebugConfig[];
  onChange: (text: string) => void;   // fires on every edit — App keeps the live text
  onRun: () => void;                  // ▶ Run (drawer mirrors the toolbar button)
  onClose: () => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [parseErr, setParseErr] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  // Set while we push a server-originated config into the editor, so the change
  // event doesn't echo it straight back to App as a "user edit".
  const syncingRef = useRef(false);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  const setValue = (v: string) => {
    const ed = edRef.current; if (!ed) return;
    syncingRef.current = true;
    ed.setValue(v);
    syncingRef.current = false;
    onChangeRef.current(v);   // keep App's live text in sync with a programmatic load
  };

  const validate = (text: string) => {
    try { JSON.parse(stripJsonc(text)); setParseErr(""); }
    catch (e: any) { setParseErr(`invalid JSON: ${e.message}`); }
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
    onChangeRef.current(ed.getValue());
    const sub = ed.onDidChangeModelContent(() => {
      const v = ed.getValue();
      validate(v);
      if (!syncingRef.current) onChangeRef.current(v);  // a genuine user edit
    });
    return () => { sub.dispose(); ed.dispose(); };
  }, []);

  // Keep the editor in sync with the server's canonical config (initial load,
  // another peer changing the target) — but never while the user is typing in
  // it, and never when the editor already SAYS the same thing: the canonical
  // echo after your own Run must not eat your comments and formatting.
  const sortDeep = (o: any): any =>
    Array.isArray(o) ? o.map(sortDeep)
    : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]))
    : o;
  const canon = (o: any): string => JSON.stringify(sortDeep(o));
  const cfgJson = JSON.stringify(config, null, 2);
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || ed.hasTextFocus()) return;
    if (ed.getValue() === cfgJson) return;
    try { if (canon(JSON.parse(stripJsonc(ed.getValue()))) === canon(config)) return; } catch {}
    setValue(cfgJson);
  }, [cfgJson]);

  // Load a history entry into the editor, dropping the server-only lastRunAt stamp.
  const load = (c: DebugConfig) => {
    const { lastRunAt, ...cfg } = c as any;
    setValue(JSON.stringify(cfg, null, 2));
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <h2>Debug Target</h2>
        {/* codicon chevron-left — the ttf ships with monaco (see App.tsx CI table) */}
        <button className="drawer-hide" title="Hide panel" onClick={onClose}>
          <span className="ci">{String.fromCodePoint(0xeab5)}</span>
        </button>
      </div>
      <div className="drawer-actions">
        <div className="tpl">
          <button className="tpl-btn" onClick={() => setTplOpen((v) => !v)}>New config ▾</button>
          {tplOpen && (
            <div className="tpl-menu" onMouseLeave={() => setTplOpen(false)}>
              {TEMPLATES.map((t) => (
                <div key={t.label} className="tpl-item"
                     onClick={() => { setValue(t.text); setTplOpen(false); }}>{t.label}</div>
              ))}
            </div>
          )}
        </div>
        <button className="run-cfg" onClick={onRun} title="Run this config">▶ Run</button>
      </div>
      <div className="drawer-editor" ref={elRef} />
      {sessionActive
        ? <div className="cfg-note">a session is active — Run will ask to kill it and relaunch</div>
        : <div className="cfg-note">edit the config, then Run ▶ to launch</div>}
      {(parseErr || error) && <div className="cfg-err">{parseErr || error}</div>}
      <div className="drawer-hist">
        <h2>History</h2>
        {history.length
          ? history.map((h, i) => (
              <div key={i} className="hist-row" onClick={() => load(h)} title={h.dapPath || h.type || ""}>
                <span className="hist-prog">
                  {h.type && <span className={"hist-type dt-" + h.type}>{h.type}</span>}
                  {h.name ? <span className="hist-name">{h.name}</span> : null}
                  {h.program}{h.args && (h.args as string[]).length ? " " + (h.args as string[]).join(" ") : ""}
                </span>
                {h.source && <span className="hist-src">{h.source}</span>}
              </div>
            ))
          : <span className="hint">no previous targets</span>}
      </div>
    </div>
  );
}
