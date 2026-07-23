// Hades web UI — React + xterm.js. Talks WS protocol v2 (see docs/design.md).
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import SourceView, { langFor, BpMeta, BpPopover } from "./SourceView";
import ConfigDrawer, { DebugConfig, stripJsonc } from "./ConfigDrawer";

type Frame = { id: number; name: string; line: number; path: string; ipRef: string };
type Thread = { id: number; name: string };
type Insn = { addr: string; text: string; sym: string; line: number };
type Var = { name: string; value: string; ref: number; mref?: string; type?: string };
type Watch = { expr: string; value: string | null };
// Enriched hover payload: the evaluated value plus, for aggregates/pointers,
// one level of expanded members (name/type/value) rendered in the tooltip.
type HoverInfo = { value: string; children?: Var[] };

let ws: WebSocket | null = null;
function send(obj: any) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

let evalSeq = 0;
// id → routing for evalResult/children/frameLocals/disasm/completions/memory
const pending = new Map<number, any>();

// A memory-map region from lldb's `memory region --all` (server-parsed).
// s/e are hex address strings; p = perms "rw-"; n = segment name or "".
type Region = { s: string; e: string; p: string; n: string };
type RegionType = "stack" | "heap" | "code" | "const" | "data";
// A region with numeric bounds + its classified type — the shared substrate for
// both the addr→type classifier and the birds-eye region map.
type RegionSpan = { s: number; e: number; type: RegionType | null; name: string; perms: string };

// Classify each mapped region into a type, in map order. The stack is whichever
// writable region holds sp (only the client knows sp). Heuristics, honest but
// coarse: executable→code, __DATA_CONST/__LINKEDIT/ro→const, __DATA→data,
// writable-anon→heap.
function classifyRegions(regions: Region[], spHex: string): RegionSpan[] {
  const sp = spHex ? parseInt(spHex, 16) : NaN;
  const bounds = regions.map((r) => ({ s: parseInt(r.s, 16), e: parseInt(r.e, 16), r }));
  const spIdx = bounds.findIndex((b) => !isNaN(sp) && sp >= b.s && sp < b.e);
  return bounds.map((b, i) => {
    const r = b.r;
    let type: RegionType | null;
    if (r.p.includes("x")) type = "code";
    else if (r.n === "__DATA_CONST" || r.n === "__LINKEDIT") type = "const";
    else if (r.n.startsWith("__DATA")) type = "data";
    else if (r.p.includes("w")) type = i === spIdx ? "stack" : (r.n === "" ? "heap" : "data");
    else if (r.p === "r--") type = "const";
    else type = null;   // "---" unmapped, or read-only anon
    return { s: b.s, e: b.e, type, name: r.n, perms: r.p };
  });
}

// Build a classifier addr→RegionType over the current memory map.
function buildRegionClassifier(regions: Region[], spHex: string): (addr: string) => RegionType | null {
  const spans = classifyRegions(regions, spHex);
  return (addr: string) => {
    const a = parseInt(addr, 16);
    if (isNaN(a)) return null;
    for (const s of spans) if (a >= s.s && a < s.e) return s.type;
    return null;
  };
}

// Promise wrapper over the expand round-trip, for code that needs to chain
// several fetches (e.g. the register panel walking scope → groups → leaves).
function expandRef(ref: number): Promise<Var[]> {
  return new Promise((resolve) => {
    const id = ++evalSeq;
    pending.set(id, { kind: "expand", done: (v: Var[]) => resolve(v) });
    send({ cmd: "expand", ref, id });
  });
}

// Locals (args included — DAP's first scope) of any frame, not just the selected
// one. Used by the stack drawing to fill every frame box at once. Resolves []
// for frames the adapter can't scope (no debug info).
function frameLocalsOf(frameId: number): Promise<Var[]> {
  return new Promise((resolve) => {
    const id = ++evalSeq;
    pending.set(id, { kind: "frameLocals", done: (v: Var[]) => resolve(v) });
    send({ cmd: "frameScopes", frameId, id });
    setTimeout(() => { if (pending.delete(id)) resolve([]); }, 3000);
  });
}

// Printable-ASCII prefix of a byte buffer, up to the first NUL. Returns "" if it
// doesn't start with a decent (≥2 char) run — i.e. probably not a C string.
function decodeCStr(bytes: Uint8Array | null): string {
  if (!bytes) return "";
  let s = "";
  for (const b of bytes) {
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return "";           // non-printable → not a string
    s += String.fromCharCode(b);
    if (s.length >= 40) { s += "…"; break; }
  }
  return s.length >= 2 ? s : "";
}

// Read raw bytes at an address WITHOUT touching the main memory view — used to
// peek what a pointer targets (e.g. a const's string). Resolves null on failure.
function readMemAt(addr: string, count: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const id = ++evalSeq;
    pending.set(id, { kind: "peek", done: resolve });
    send({ cmd: "readMem", memoryReference: addr, count, id });
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 3000);
  });
}

const EMPTY_BPS = new Map<number, any>();
const noop = () => {};
const base = (p: string) => p.split("/").pop() || p;
// A frame has real source only with a readable file path. lldb hands back
// "module`symbol" pseudo-paths for no-debug-info frames (dyld/libc) — those get
// the disassembly view, not a bogus source tab.
const hasSrc = (p: string) => !!p && !p.includes("`");
// Breakpoints are keyed per file; newline can't appear in a path.
const bpKey = (path: string, line: number) => `${path}\n${line}`;

// ── Merged terminal (program + debugger output in one xterm) ──
// VS Code interleaves the debuggee's tty and the debugger's own output in a
// single view; we do the same. Program bytes (pty / DAP category "stdout")
// render raw — they own their SGR. Everything from the debugger — DAP "console"
// output, REPL echo/results, adapter errors — gets a dim color and a per-line
// tag (the adapter id: lldb/debugpy/…) so the two streams never blur together.
let dbgTag = "debugger";  // set from hello — keeps the tag generic across adapters
const SGR = {
  reset: "\x1b[0m",
  dbg: "\x1b[38;5;80m",    // debugger console — cyan
  err: "\x1b[38;5;203m",   // stderr / failures — red
  cmd: "\x1b[2;37m",       // REPL echo — dim
};
// Per-stream begin-of-line flags so a message split across events (or a partial
// pty line) isn't re-tagged mid-line.
const atBol: Record<string, boolean> = {};
// Write `text` to the terminal in `color`, prefixing each line-start with `tag`.
// DAP/REPL text uses bare "\n"; xterm needs CRLF, so we translate and drop the
// program's own "\r" for tagged streams.
function writeTagged(term: Terminal | null, key: string, text: string, color: string, tag: string) {
  if (!term || !text) return;
  if (atBol[key] === undefined) atBol[key] = true;
  let out = color;
  for (const ch of text) {
    if (ch === "\r") continue;                 // we emit our own CRLF
    if (atBol[key]) { out += tag; atBol[key] = false; }
    if (ch === "\n") { out += "\r\n"; atBol[key] = true; }
    else out += ch;
  }
  term.write(out + SGR.reset);
}

// VS Code codicon glyphs (font ships inside monaco; build.sh copies the ttf).
// Codepoints from monaco's codiconsLibrary.js — stable public API of the font.
const CI = {
  run: 0xead3, cont: 0xeacf, pause: 0xead1,
  stepOver: 0xead6, stepInto: 0xead4, stepOut: 0xead5,
  restart: 0xead2, stop: 0xead7, chip: 0xec19, add: 0xea60, gear: 0xeaf8,
  chevRight: 0xeab6,   // 0xeab5 (chevron-left) used directly in ConfigDrawer
  info: 0xea74,
};
const Ico = ({ g, sub }: { g: number; sub?: string }) => (
  <>
    <span className="ci">{String.fromCodePoint(g)}</span>
    {sub && <span className="ci-sub">{sub}</span>}
  </>
);

// Disassembly pane text: one line per instruction, pc line for the arrow.
// Addresses compare via BigInt — lldb pads instructionPointerReference wider
// than the per-instruction address strings.
function buildAsm(d: { lines: Insn[]; pc: string }): { text: string; pcLine: number } {
  const norm = (a: string) => { try { return BigInt(a).toString(16); } catch { return a; } };
  const pcN = norm(d.pc);
  let pcLine = 0;
  const text = d.lines.map((ins, i) => {
    if (norm(ins.addr) === pcN) pcLine = i + 1;
    return `${ins.addr}  ${ins.text}${ins.sym ? `    ; ${ins.sym}` : ""}`;
  }).join("\n");
  return { text, pcLine };
}

export default function App() {
  const [status, setStatus] = useState({ text: "connecting…", cls: "" });
  const [program, setProgram] = useState("");
  const [srcPath, setSrcPath] = useState("");   // configured main source (hello)
  const [viewPath, setViewPath] = useState(""); // file currently displayed
  const [files, setFiles] = useState<Map<string, string>>(new Map()); // path → content
  const [tabs, setTabs] = useState<string[]>([]);
  const [bps, setBps] = useState<Map<string, BpMeta>>(new Map()); // bpKey → meta
  const [stopLine, setStopLine] = useState(0);
  const [stopPath, setStopPath] = useState("");  // file the stop/selected frame is in
  const [frames, setFrames] = useState<Frame[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [tlocs, setTlocs] = useState<Map<number, { label: string; pc: string }>>(new Map());
  const [curTid, setCurTid] = useState(-1);               // thread frames/stepping follow
  const [locals, setLocals] = useState<Var[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "stopped" | "done">("idle");
  // The server's canonical launch-config object (hello.config) — seeds the
  // drawer editor. The editor is the source of truth once the user types; this
  // only re-seeds it on load / history restore (see cfgTextRef for the live text).
  const [cfg, setCfg] = useState<DebugConfig>({});
  const [cfgHist, setCfgHist] = useState<DebugConfig[]>([]);   // server-owned config history
  const [tab, setTab] = useState<"term" | "mem" | "stack" | "regs">("term");
  const [dbgLabel, setDbgLabel] = useState("debugger");  // legend + line tag
  const [bottomH, setBottomH] = useState(240);
  const [asideW, setAsideW] = useState(340);
  const [adapterCmd, setAdapterCmd] = useState("");    // resolved adapter command (ⓘ popover)
  const [showConfig, setShowConfig] = useState(true);  // open by default; |◂| hides it
  const [showInfo, setShowInfo] = useState(false);     // ⓘ session-info popover
  const [configErr, setConfigErr] = useState("");
  const [caps, setCaps] = useState<Record<string, any>>({});
  const [stopMain, setStopMain] = useState(() => localStorage.getItem("hades.stopAtMain") !== "0");
  const [selFrame, setSelFrame] = useState(0);
  // Monotonic counters so re-clicking the same line still reveals it.
  const [jump, setJump] = useState({ line: 0, n: 0 });
  const [disasm, setDisasm] = useState<{ lines: Insn[]; pc: string } | null>(null);
  // Parent container ref for top-level locals — what setVariable needs.
  const [scopeRef, setScopeRef] = useState(0);
  const [registersRef, setRegistersRef] = useState(0);  // register scope ref (0 = adapter exposes none)
  // Bumped on every stop. lldb-dap keeps the register scope/group refs stable
  // across a session, so a ref-keyed refetch never refires — the panel would
  // freeze at the first stop's values. This forces a re-read each stop.
  const [stopSeq, setStopSeq] = useState(0);
  const [regions, setRegions] = useState<Region[]>([]);  // memory map for region-coloring (lldb only)
  // Frame registers reported up from RegistersPanel — sp drives stack detection,
  // fp/lr let the memory view annotate saved-frame / return-address slots.
  const [regFrame, setRegFrame] = useState<{ sp: string; fp: string; lr: string }>({ sp: "", fp: "", lr: "" });
  const regSp = regFrame.sp;
  // Shared region classifier — one map+sp, used by both Registers and Memory so
  // a value's hue means the same thing in both. null until a map arrives.
  const classifyRegion = useMemo(
    () => (regions.length ? buildRegionClassifier(regions, regSp) : null),
    [regions, regSp]);
  const [bpEdit, setBpEdit] = useState<{ path: string; line: number; x: number; y: number } | null>(null);  // panel ✎ editor
  const [excSel, setExcSel] = useState<Set<string>>(new Set());
  const [excInit, setExcInit] = useState(false);
  const [mem, setMem] = useState<{ addr: string; bytes: Uint8Array } | null>(null);
  const [memAddr, setMemAddr] = useState("");
  const [memErr, setMemErr] = useState("");   // shown in the Memory pane, not the terminal

  const tidRef = useRef(-1);
  const sidRef = useRef("");      // current sessionId — a change means "new session, wipe state"
  // True only right after a fresh/new-session hello (terminal was cleared), so
  // replayed output history renders once; a same-session reconnect keeps its own
  // scrollback and drops the replay to avoid duplicating it.
  const acceptReplayRef = useRef(false);
  const frame0Ref = useRef(-1);   // frameId evals run in — follows the selected frame
  const frameReqRef = useRef(0);  // latest frameScopes id; stale frameLocals replies are dropped
  const phaseRef = useRef(phase);
  const pendingRestart = useRef(false);           // kill+rerun fallback in flight
  const runRef = useRef<() => void>(() => {});    // ws handler needs a fresh run()
  // Live text of the drawer's config editor — THE config Run launches. Seeded
  // from hello.config, updated by every drawer edit; parsed only on Run.
  const cfgTextRef = useRef("");
  phaseRef.current = phase;
  const termRef = useRef<Terminal | null>(null);
  const watchesRef = useRef<Watch[]>([]);
  watchesRef.current = watches;
  const viewPathRef = useRef("");
  viewPathRef.current = viewPath;
  const srcPathRef = useRef("");   // ws handler ([] deps) needs the live source path on terminate
  srcPathRef.current = srcPath;
  const filesRef = useRef(files);
  filesRef.current = files;
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const disasmOpenRef = useRef(false);
  disasmOpenRef.current = disasm !== null;
  // Cross-file jump lands once the file's source arrives.
  const pendJumpRef = useRef<{ path: string; line: number } | null>(null);

  // Debugger-side text into the merged terminal: REPL echo/results and adapter
  // failures. "in" = the echoed command (dim), "err" = failure (red), else the
  // REPL result (cyan). Program output takes the untagged path (pty / output).
  const consoleAppend = useCallback((text: string, cls = "") => {
    const t = termRef.current;
    if (cls === "err") writeTagged(t, "err", text, SGR.err, "");
    else if (cls === "in") writeTagged(t, "cmd", text, SGR.cmd, "");
    else writeTagged(t, "dbg", text, SGR.dbg, "");
  }, []);

  // Monaco hover → DAP evaluate(context:"hover") while stopped.
  // Hover → evaluate; if the result is an aggregate/pointer (ref>0), expand one
  // level so the tooltip can show its members instead of a bare "Shape[2]".
  const evalHover = useCallback((expr: string) => new Promise<HoverInfo | null>((resolve) => {
    if (phaseRef.current !== "stopped") return resolve(null);
    const id = ++evalSeq;
    pending.set(id, { kind: "hover", done: (m: any) => {
      if (!m || m.value == null) return resolve(null);
      if (m.ref > 0) expandRef(m.ref).then(
        (kids) => resolve({ value: m.value, children: kids }),
        () => resolve({ value: m.value }));
      else resolve({ value: m.value });
    } });
    send({ cmd: "evaluate", expr, context: "hover", id, frameId: frame0Ref.current });
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 2000);
  }), []);

  // fetch a disassembly window around a frame's pc.
  const requestDisasm = useCallback((f: Frame) => {
    const c = capsRef.current;
    if (Object.keys(c).length > 0 && !c.supportsDisassembleRequest) return;
    if (!f.ipRef) return;
    const id = ++evalSeq;
    pending.set(id, { kind: "disasm", pc: f.ipRef });
    send({ cmd: "disassemble", memoryReference: f.ipRef, id });
  }, []);

  const evalWatches = useCallback(() => {
    watchesRef.current.forEach((w) => {
      const id = ++evalSeq;
      pending.set(id, { kind: "watch", expr: w.expr });
      send({ cmd: "evaluate", expr: w.expr, context: "watch", id, frameId: frame0Ref.current });
    });
  }, []);

  // edit a variable; resolves with the adapter's formatted new value, or
  // null on failure/timeout (the node reverts). Watches re-evaluate on success.
  const setVar = useCallback((parentRef: number, name: string, value: string) =>
    new Promise<any>((resolve) => {
      const id = ++evalSeq;
      pending.set(id, { kind: "setVar", done: resolve });
      send({ cmd: "setVar", ref: parentRef, name, value, id });
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 3000);
    }).then((r) => { if (r) evalWatches(); return r; }), [evalWatches]);

  // fetch + show a memory window in the Memory tab.
  const viewMemory = useCallback((addr: string) => {
    setMemAddr(addr);
    setMemErr("");
    setTab("mem");
    const id = ++evalSeq;
    pending.set(id, { kind: "memory", addr });
    send({ cmd: "readMem", memoryReference: addr, count: 256, id });
  }, []);
  const memLinks = !!caps.supportsReadMemoryRequest;

  // switch to (and lazily load) a file tab.
  const openFile = useCallback((path: string, jumpLine?: number) => {
    if (jumpLine) pendJumpRef.current = { path, line: jumpLine };
    if (filesRef.current.has(path)) {
      setViewPath(path);
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      if (jumpLine) { setJump((j) => ({ line: jumpLine, n: j.n + 1 })); pendJumpRef.current = null; }
    } else {
      send({ cmd: "openSource", path });
    }
  }, []);

  useEffect(() => {
    let gone = false;   // effect torn down — don't reconnect after unmount
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { retries = 0; setStatus({ text: "ready — set breakpoints, then Run", cls: "" }); };
    // The server session survives disconnects and replays full state on
    // rejoin, so a dropped socket is always worth retrying.
    ws.onclose = () => {
      if (gone) return;
      const delay = Math.min(500 * 2 ** retries, 5000);
      retries++;
      setStatus({ text: "disconnected — reconnecting…", cls: "" });
      timer = setTimeout(connect, delay);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "hello") {
        setProgram(m.program); setSrcPath(m.sourcePath || ""); setViewPath(m.sourcePath || "");
        setAdapterCmd(m.adapterCmd || ""); setConfigErr(""); setBps(new Map());
        dbgTag = m.adapterId || "debugger"; setDbgLabel(dbgTag);
        setFiles(new Map()); setTabs(m.sourcePath ? [m.sourcePath] : []);
        setStopPath(""); setDisasm(null);
        // canonical config from the server; seed the live run text too so Run
        // works even before the drawer editor mounts.
        setCfg(m.config || {});
        if (!cfgTextRef.current) cfgTextRef.current = JSON.stringify(m.config || {}, null, 2);
        // A different sessionId is a genuinely new session (newSession command
        // or server restart) — wipe everything a same-session reconnect would
        // have replayed. A rejoin replay repopulates via bpSync/stopped/etc.
        const fresh = !!m.sessionId && m.sessionId !== sidRef.current;
        acceptReplayRef.current = fresh;   // only a cleared terminal renders replay
        if (fresh) {
          sidRef.current = m.sessionId;
          setFrames([]); setThreads([]); setTlocs(new Map()); setCurTid(-1);
          setLocals([]); setWatches([]); setStopLine(0);
          setSelFrame(0); setMem(null); setMemAddr(""); setMemErr("");
          if (phaseRef.current !== "idle") setPhase("idle");
          termRef.current?.clear();
        }
        // Session identity in the URL: shareable, and a reload/reconnect can
        // tell "same session" from "server restarted" (state resets either way).
        if (m.sessionId) {
          const u = new URL(location.href);
          u.searchParams.set("s", m.sessionId);
          history.replaceState(null, "", u);
        }
        // joining a live shared session — a stopped replay may refine this.
        if (m.phase === "running") { setPhase("running"); setStatus({ text: "joined live session…", cls: "running" }); }
        // History is server-owned: seed it from hello, then run the one-shot
        // localStorage → server migration and retire the client-local store.
        setCfgHist(m.history || []);
        try {
          const legacy = localStorage.getItem("hades.configHistory");
          if (legacy) {
            const entries = JSON.parse(legacy);
            if (Array.isArray(entries) && entries.length) send({ cmd: "importHistory", entries });
            localStorage.removeItem("hades.configHistory");
          }
        } catch {}
        // Boot restore is server-side now (it stages history[0], so m.program is
        // set when there was something to restore). Still empty → nothing to
        // restore, open the drawer.
        if (!m.program) {
          setShowConfig(true);
          setStatus({ text: "configure a debug target (⚙) to begin", cls: "" });
        }
        // no --source — the first stop's frame fills the editor.
        else if (!m.sourcePath) setStatus({ text: "no source configured — Run stops at main and loads it", cls: "" });
      }
      else if (m.type === "bpSync") {
        // Late-join replay: server's bp set is truth (acks are optimistic).
        setBps((b) => new Map(b).set(bpKey(m.path, m.line), {
          ...(m.condition ? { condition: m.condition } : {}),
          ...(m.hitCondition ? { hitCondition: m.hitCondition } : {}),
          ...(m.logMessage ? { logMessage: m.logMessage } : {}),
          ...(m.enabled === false ? { enabled: false } : {}),
        }));
      }
      else if (m.type === "historyChanged") setCfgHist(m.history || []);
      else if (m.type === "configError") setConfigErr(m.error);
      else if (m.type === "capabilities") { try { setCaps(JSON.parse(m.raw).body || {}); } catch {} }
      else if (m.type === "source") {
        if (m.path) {
          setFiles((f) => new Map(f).set(m.path, m.content));
          setTabs((t) => (t.includes(m.path) ? t : [...t, m.path]));
          setViewPath(m.path);
          const pj = pendJumpRef.current;
          if (pj && pj.path === m.path) {
            setJump((j) => ({ line: pj.line, n: j.n + 1 }));
            pendJumpRef.current = null;
          }
        }
      }
      else if (m.type === "threads") {
        // sent on every stop (and replayed to late joiners).
        setThreads(m.threads || []);
        setCurTid(m.current ?? -1);
        // Top frame per thread for the panel (id-correlated fetches — they
        // don't touch the user's thread/frame selection).
        setTlocs(new Map());
        for (const t of m.threads || []) {
          const id = ++evalSeq;
          pending.set(id, { kind: "tloc", done: (r: any) => {
            const f = r.frames?.[0];
            if (f) setTlocs((p) => new Map(p).set(t.id, { label: `${f.name}:${f.line}`, pc: f.ipRef || "" }));
          }});
          send({ cmd: "threadStack", tid: t.id, id });
        }
      }
      else if (m.type === "threadStack") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.done(m); }
      }
      else if (m.type === "stopped") {
        tidRef.current = m.tid;
        setCurTid(m.tid);
        frame0Ref.current = m.frames?.[0]?.id ?? -1;
        setSelFrame(0);
        const f0 = m.frames?.[0];
        const sp = (f0?.path || m.path || "");
        setStopPath(sp);
        // The server's source-push dedup tracks only what *it* last sent; make
        // sure we have and show the stop file (real source only — pseudo-paths
        // get disassembly instead, and keep the last real file in the editor).
        if (hasSrc(sp)) {
          if (!filesRef.current.has(sp)) send({ cmd: "openSource", path: sp });
          else setViewPath(sp);
          setTabs((t) => (t.includes(sp) ? t : [...t, sp]));
        }
        setStopLine(m.line);
        setFrames(m.frames || []);
        setLocals(m.locals || []);
        setScopeRef(m.scopeRef || 0);
        setRegistersRef(m.registersRef || 0);
        setStopSeq((s) => s + 1);
        setPhase("stopped");
        setStatus({ text: `stopped at line ${m.line}`, cls: "stopped" });
        // Keep the asm pane live across steps; auto-open it for no-source frames.
        if (f0 && (!hasSrc(f0.path) || disasmOpenRef.current) && f0.ipRef) requestDisasm(f0);
        else setDisasm(null);
        evalWatches();
      } else if (m.type === "evalResult") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (p.kind === "repl") p.done(m.value, m.error);
        else if (p.kind === "hover") p.done(m.error ? null : m);
        else if (p.kind === "watch")
          setWatches((wsx) => wsx.map((w) => (w.expr === p.expr ? { ...w, value: m.value } : w)));
      } else if (m.type === "regions") {
        setRegions(m.regions || []);
      } else if (m.type === "children") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.done(m.vars || []); }
      } else if (m.type === "frameLocals") {
        // Two callers: frame selection (routed by frameReqRef — stale replies
        // dropped) and frameLocalsOf's promise (carries its own `done`).
        const p = pending.get(m.id);
        if (pending.delete(m.id)) {
          if (p?.done) p.done(m.vars || []);
          else if (frameReqRef.current === m.id) {
            setLocals(m.vars || []);
            setScopeRef(m.scopeRef || 0);
          }
        }
      } else if (m.type === "setVarResult") {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error) consoleAppend(`setVariable failed: ${m.value}\n`, "err");
          p.done(m.error ? null : m);
        }
      } else if (m.type === "disasm") {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.instructions?.length) setDisasm({ lines: m.instructions, pc: p.pc });
        }
      } else if (m.type === "completions") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.done(m.targets || []); }
      } else if (m.type === "memory") {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          const decode = (): Uint8Array | null => {
            if (m.error || !m.data) return null;
            const bin = atob(m.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
          };
          if (p.kind === "peek") {
            p.done(decode());   // silent — a failed peek just shows no preview
          } else {
            const bytes = decode();
            // 0x0 / unmapped pages: lldb-dap replies success-but-empty (no error
            // field, no data). Report it in the Memory pane — the user is looking
            // there, not at the terminal.
            if (!bytes) {
              setMemErr(`can't read memory at ${p.addr}${m.error ? `: ${m.error}` : " — no readable bytes (unmapped?)"}`);
            } else {
              setMemErr("");
              setMem({ addr: m.address || p.addr, bytes });
            }
          }
        }
      } else if (m.type === "output") {
        // Replayed history: render only when we just cleared for a fresh
        // session; a same-session reconnect kept its scrollback → drop dupes.
        if (m.replay && !acceptReplayRef.current) return;
        // Program stdout/stderr render as program output; console/important is
        // debugger chatter → tagged. "telemetry" is DAP-internal (adapter
        // handshake, e.g. debugpy's "ptvsd") and never meant for display.
        const t = termRef.current, c = m.category || "";
        if (c === "telemetry") { /* drop */ }
        else if (c === "stdout") writeTagged(t, "out", m.text, "", "");
        else if (c === "stderr") writeTagged(t, "err", m.text, SGR.err, "");
        else writeTagged(t, "dbg", m.text, SGR.dbg, dbgTag + "  ");
      }
      else if (m.type === "ptyData") termRef.current?.write(m.data);
      else if (m.type === "restartFailed") {
        pendingRestart.current = true;
        send({ cmd: "kill" });
      }
      else if (m.type === "terminated") {
        setPhase("idle");
        setStopLine(0);
        setFrames([]);
        setThreads([]);
        setLocals([]);
        setDisasm(null);
        // return the pane to the program's source; leaving a dead no-source
        // (dyld/libc) frame in viewPath strands the "disassembling…" placeholder.
        setStopPath("");
        setViewPath(srcPathRef.current);
        if (pendingRestart.current) {
          pendingRestart.current = false;
          runRef.current();
          return;
        }
        setStatus({ text: "program exited — Run to start again", cls: "done" });
        termRef.current?.write("\r\n\x1b[2m[hades] session ended — press ▶ Run to start again\x1b[0m\r\n");
      }
    };
    };
    connect();
    return () => { gone = true; clearTimeout(timer); ws?.close(); };
  }, []);

  // Default exception filters on once when capabilities first arrive.
  useEffect(() => {
    const filters = caps.exceptionBreakpointFilters;
    if (!excInit && Array.isArray(filters) && filters.length) {
      const def = new Set<string>(filters.filter((f: any) => f.default).map((f: any) => f.filter));
      setExcSel(def);
      setExcInit(true);
      send({ cmd: "setExceptions", filters: [...def] });
    }
  }, [caps, excInit]);

  const toggleBp = (ln: number) => {
    const path = viewPathRef.current;
    setBps((prev) => {
      const next = new Map(prev);
      const k = bpKey(path, ln);
      if (next.has(k)) { next.delete(k); send({ cmd: "clearBreakpoint", path, line: ln }); }
      else { next.set(k, {}); send({ cmd: "setBreakpoint", path, line: ln }); }
      return next;
    });
  };

  // upsert a breakpoint with condition/hitCondition/logMessage (server
  // treats setBreakpoint on an existing line as a replace).
  const setBpMetaAt = (path: string, ln: number, meta: BpMeta) => {
    setBps((prev) => new Map(prev).set(bpKey(path, ln), meta));
    send({ cmd: "setBreakpoint", path, line: ln, ...meta });
  };
  const setBpMeta = (ln: number, meta: BpMeta) => setBpMetaAt(viewPathRef.current, ln, meta);

  const removeBp = (path: string, ln: number) => {
    setBps((prev) => { const next = new Map(prev); next.delete(bpKey(path, ln)); return next; });
    send({ cmd: "clearBreakpoint", path, line: ln });
  };

  // Enable/disable keeps the bp in the list; the server omits disabled ones
  // from the DAP request (absent = enabled, DAP has no per-bp enable).
  const setBpEnabled = (path: string, ln: number, meta: BpMeta) => {
    const nm: BpMeta = { ...meta };
    if (nm.enabled === false) delete nm.enabled; else nm.enabled = false;
    setBps((prev) => new Map(prev).set(bpKey(path, ln), nm));
    send({ cmd: "setBreakpoint", path, line: ln, ...nm });
  };
  const bpEntries = () => [...bps.entries()].map(([k, m]) => {
    const i = k.indexOf("\n");
    return { path: k.slice(0, i), line: Number(k.slice(i + 1)), meta: m };
  });
  const anyBpEnabled = [...bps.values()].some((m) => m.enabled !== false);
  const toggleAllBps = () => {
    for (const { path, line, meta } of bpEntries()) {
      if ((meta.enabled !== false) === anyBpEnabled) setBpEnabled(path, line, meta);
    }
  };
  const clearAllBps = () => { for (const { path, line } of bpEntries()) removeBp(path, line); };

  // click a stack frame → show its file+line, scope locals and evals to it.
  const selectFrame = (i: number) => {
    if (phaseRef.current !== "stopped") return;
    const f = frames[i];
    if (!f) return;
    setSelFrame(i);
    frame0Ref.current = f.id;
    setStopLine(f.line);
    setStopPath(f.path);
    if (hasSrc(f.path)) openFile(f.path);
    if (!hasSrc(f.path) || disasmOpenRef.current) requestDisasm(f); else setDisasm(null);
    const id = ++evalSeq;
    frameReqRef.current = id;
    pending.set(id, { kind: "frameLocals" });
    send({ cmd: "frameScopes", frameId: f.id, id });
    evalWatches();
  };

  // click a thread → show its stack, retarget stepping/evals to it.
  // The frames reply drives the same frame-0 selection flow selectFrame uses.
  const selectThread = (t: Thread) => {
    if (phaseRef.current !== "stopped" || t.id === curTid) return;
    tidRef.current = t.id;
    setCurTid(t.id);
    const id = ++evalSeq;
    pending.set(id, { kind: "threadStack", done: (m: any) => {
      const fs: Frame[] = m.frames || [];
      setFrames(fs);
      setSelFrame(0);
      const f0 = fs[0];
      if (!f0) { setLocals([]); return; }
      frame0Ref.current = f0.id;
      setStopLine(f0.line);
      setStopPath(f0.path);
      if (hasSrc(f0.path)) openFile(f0.path, f0.line);
      if (!hasSrc(f0.path) || disasmOpenRef.current) requestDisasm(f0); else setDisasm(null);
      const fid = ++evalSeq;
      frameReqRef.current = fid;
      pending.set(fid, { kind: "frameLocals" });
      send({ cmd: "frameScopes", frameId: f0.id, id: fid });
      evalWatches();
    }});
    send({ cmd: "threadStack", tid: t.id, id });
  };

  // Run = parse the drawer's live JSON and launch it. A live session asks for
  // confirmation, then force-kills and relaunches (server tears down first).
  const run = () => {
    let config: any = undefined;
    const text = stripJsonc(cfgTextRef.current).trim();  // config dialect is JSONC (launch.json)
    if (text) {
      try { config = JSON.parse(text); }
      catch (e: any) { setConfigErr(`invalid JSON: ${e.message}`); setShowConfig(true); return; }
    }
    const force = phaseRef.current === "running" || phaseRef.current === "stopped";
    if (force && !confirm("This will kill the existing debug session. Start a new one?")) return;
    setConfigErr("");
    setPhase("running");
    setStatus({ text: force ? "restarting with new target…" : "running…", cls: "running" });
    setStopLine(0);
    send({ cmd: "run", stopAtMain: stopMain, ...(config ? { config } : {}), ...(force ? { force: true } : {}) });
    termRef.current?.focus();
  };
  runRef.current = run;
  // always try the native restart request (lldb-dap handles it but never
  // advertises supportsRestartRequest); a restartFailed reply triggers the
  // kill+rerun fallback (e.g. debugpy).
  const restart = () => {
    if (phase !== "running" && phase !== "stopped") return;
    setPhase("running");
    setStatus({ text: "restarting…", cls: "running" });
    setStopLine(0);
    send({ cmd: "restart" });
  };
  const resume = (cmd: string, granularity?: string) => {
    setPhase("running");
    setStatus({ text: "running…", cls: "running" });
    setStopLine(0);
    send({ cmd, tid: tidRef.current, ...(granularity ? { granularity } : {}) });
  };

  const stopped = phase === "stopped";
  const asm = useMemo(() => (disasm ? buildAsm(disasm) : null), [disasm]);
  // Inline-asm mode: render each source line's instructions under it (view zones
  // in the main SourceView) instead of the side-by-side pane.
  const [inlineAsm, setInlineAsm] = useState(false);
  // Group the current disasm window's instructions by source line for the inline
  // view. Only statement-boundary instructions carry a line; the rest come back
  // as line 0, so carry the last line forward (objdump -S style) — otherwise the
  // add/str that finish a statement silently vanish.
  const asmByLine = useMemo(() => {
    const m = new Map<number, { addr: string; text: string }[]>();
    if (!disasm) return m;
    let cur = 0;
    for (const ins of disasm.lines) {
      if (ins.line > 0) cur = ins.line;
      if (cur > 0) (m.get(cur) ?? m.set(cur, []).get(cur)!).push({ addr: ins.addr, text: ins.text });
    }
    return m;
  }, [disasm]);
  // Which asm line to reveal, bumped to re-trigger. A fresh disasm window reveals
  // its pc; an in-window address click reveals the branch target instead.
  const [asmJump, setAsmJump] = useState({ line: 0, n: 0 });
  useEffect(() => { if (asm) setAsmJump((j) => ({ line: asm.pcLine, n: j.n + 1 })); }, [asm]);
  // Follow a clicked address: reveal it if it's in the current window, else
  // disassemble a fresh window around it (chase a branch/call target).
  const followAddr = (addr: string) => {
    const norm = (a: string) => { try { return BigInt(a).toString(16); } catch { return a; } };
    const t = norm(addr);
    const idx = disasm ? disasm.lines.findIndex((i) => norm(i.addr) === t) : -1;
    if (idx >= 0) { setAsmJump((j) => ({ line: idx + 1, n: j.n + 1 })); return; }
    // Out of window: only chase things that look like code addresses, not the
    // small immediates/stack offsets (#0x8, [sp, #0x40]) that share 0x… syntax.
    try { if (BigInt(addr) < 0x1000n) return; } catch { return; }
    const id = ++evalSeq;
    pending.set(id, { kind: "disasm", pc: addr });
    send({ cmd: "disassemble", memoryReference: addr, id });
  };
  const excFilters: any[] = Array.isArray(caps.exceptionBreakpointFilters) ? caps.exceptionBreakpointFilters : [];
  const srcText = files.get(viewPath) ?? "";
  const viewBps = useMemo(() => {
    const out = new Map<number, BpMeta>();
    bps.forEach((meta, k) => {
      const [p, ln] = [k.slice(0, k.indexOf("\n")), Number(k.slice(k.indexOf("\n") + 1))];
      if (p === viewPath) out.set(ln, meta);
    });
    return out;
  }, [bps, viewPath]);
  const canInstrStep = stopped && !!caps.supportsSteppingGranularity && !!asm;

  return (
    <div className="app">
      <header>
        <span className="logo">HADES</span>
        <span className="toolbar">
          <button className="run" title={phase === "idle" ? "Run — start the program" : "Run — kill the current session and relaunch"} onClick={run}><Ico g={CI.run} /></button>
          <button disabled={!stopped} title={stopped ? "Continue" : "Continue (needs a stopped program)"}
                  onClick={() => resume("continue")}><Ico g={CI.cont} /></button>
          <button disabled={phase !== "running"} title="Pause"
                  onClick={() => send({ cmd: "pause", tid: tidRef.current })}><Ico g={CI.pause} /></button>
        </span>
        <span className="toolbar">
          <button disabled={!stopped} title="Step over" onClick={() => resume("stepOver")}><Ico g={CI.stepOver} /></button>
          <button disabled={!stopped} title="Step in" onClick={() => resume("stepIn")}><Ico g={CI.stepInto} /></button>
          <button disabled={!stopped} title="Step out" onClick={() => resume("stepOut")}><Ico g={CI.stepOut} /></button>
          {asm && <button disabled={!canInstrStep} title="Step one instruction (over calls)"
                          onClick={() => resume("stepOver", "instruction")}><Ico g={CI.stepOver} sub="i" /></button>}
          {asm && <button disabled={!canInstrStep} title="Step one instruction (into calls)"
                          onClick={() => resume("stepIn", "instruction")}><Ico g={CI.stepInto} sub="i" /></button>}
        </span>
        <span className="toolbar">
          <button disabled={phase !== "running" && phase !== "stopped"}
                  title="Restart the program (breakpoints persist)" onClick={restart}><Ico g={CI.restart} /></button>
          <button disabled={phase !== "running" && phase !== "stopped"}
                  title="Stop — terminate the program" onClick={() => send({ cmd: "kill" })}><Ico g={CI.stop} /></button>
          <button disabled={!stopped || !caps.supportsDisassembleRequest}
                  className={asm && !inlineAsm ? "asm-on" : ""}
                  title={stopped ? "Toggle disassembly pane"
                                 : "Disassembly (available while stopped, adapter must support it)"}
                  onClick={() => {
                    if (disasm) { setDisasm(null); setInlineAsm(false); }
                    else {
                      // Selected frame's pc, or the nearest frame that has one.
                      const f = frames[selFrame]?.ipRef ? frames[selFrame] : frames.find((x) => x.ipRef);
                      if (f) requestDisasm(f);
                    }
                  }}><Ico g={CI.chip} /></button>
          <button disabled={!stopped || !caps.supportsDisassembleRequest}
                  className={inlineAsm ? "asm-on" : ""}
                  title="Show generated asm inline, under each source line"
                  onClick={() => {
                    if (inlineAsm) { setInlineAsm(false); setDisasm(null); }
                    else {
                      setInlineAsm(true);
                      const f = frames[selFrame]?.ipRef ? frames[selFrame] : frames.find((x) => x.ipRef);
                      if (f) requestDisasm(f);
                    }
                  }}><Ico g={CI.chip} sub="s" /></button>
        </span>
        <label className="stopmain" title="break at main (python: first user line) on Run">
          <input type="checkbox" checked={stopMain} onChange={(e) => {
            setStopMain(e.target.checked);
            localStorage.setItem("hades.stopAtMain", e.target.checked ? "1" : "0");
          }} /> stop at main
        </label>
        <span className="prog" title={cfg.port ? `tcp: ${cfg.host || "127.0.0.1"}:${cfg.port}` : (adapterCmd ? `adapter: ${adapterCmd}` : "")}>{program}</span>
        <span className={"status " + status.cls}>{status.text}</span>
        {Object.keys(caps).length > 0 && (
          <span className="info-wrap">
            <button className="gear info-btn" title="Session info — adapter & capabilities"
                    onClick={() => setShowInfo((v) => !v)}><Ico g={CI.info} /></button>
            {showInfo && (
              <div className="info-pop" onMouseLeave={() => setShowInfo(false)}>
                <div className="info-line"><span className="info-k">adapter</span> {dbgLabel}{adapterCmd ? ` — ${adapterCmd}` : ""}</div>
                <div className="info-line"><span className="info-k">session</span> {sidRef.current || "—"}</div>
                <details>
                  <summary>capabilities</summary>
                  <div className="caps-list">
                    {Object.keys(caps).filter((k) => caps[k] === true).sort()
                      .map((k) => <span key={k} className="cap">{k.replace(/^supports/, "")}</span>)}
                  </div>
                </details>
              </div>
            )}
          </span>
        )}
        <button className="gear" title="New session — end this one, keep the target config"
                onClick={() => {
                  if (phase !== "idle" && !confirm("End the current debug session and start a new one?")) return;
                  send({ cmd: "newSession" });
                }}><Ico g={CI.add} /></button>
        <button className="gear" title="Debug target config" onClick={() => setShowConfig((v) => !v)}><Ico g={CI.gear} /></button>
      </header>
      <main>
        {showConfig ? (
          <ConfigDrawer
            config={cfg}
            sessionActive={phase === "running" || phase === "stopped"}
            error={configErr}
            history={cfgHist}
            onChange={(text: string) => { cfgTextRef.current = text; }}
            onRun={run}
            onClose={() => setShowConfig(false)}
          />
        ) : (
          <button className="drawer-reopen" title="Show debug target" onClick={() => setShowConfig(true)}><Ico g={CI.chevRight} /></button>
        )}
        <div className="editor-col">
          {tabs.length > 1 && (
            <div className="filetabs">
              {tabs.map((p) => (
                <div key={p} className={"filetab" + (p === viewPath ? " active" : "")}
                     title={p} onClick={() => openFile(p)}>{base(p)}</div>
              ))}
            </div>
          )}
          <div className="source-wrap">
            {(() => {
              const asmPane = asm ? (
                <SourceView text={asm.text} lang="asm" bps={EMPTY_BPS} stopLine={asm.pcLine}
                            onToggle={noop} onSetMeta={noop} caps={caps}
                            jump={asmJump}
                            onLineClick={(ln, word) => {
                              // Hex address (branch/call target or the addr column) → follow it.
                              if (word && /^0x[0-9a-fA-F]+$/.test(word)) { followAddr(word); return; }
                              // Otherwise asm → source: jump to the instruction's source line.
                              const ins = disasm!.lines[ln - 1];
                              if (ins?.line && stopPath) openFile(stopPath, ins.line);
                            }} />
              ) : null;
              // No-debug-info frame (dyld/libc etc.): show the disassembly in place
              // of the source — not a placeholder telling the user to run a command.
              if (!hasSrc(viewPath)) {
                return asmPane ?? (
                  <div className="src-hint">
                    {stopped && caps.supportsDisassembleRequest ? "disassembling…" : "no source available for this frame"}
                  </div>
                );
              }
              return (
                <>
                  <SourceView text={srcText} lang={langFor(viewPath)} bps={viewBps}
                              stopLine={viewPath === stopPath ? stopLine : 0}
                              onToggle={toggleBp} onSetMeta={setBpMeta} onHoverEval={evalHover}
                              caps={caps} jump={jump}
                              asmByLine={inlineAsm && viewPath === stopPath ? asmByLine : undefined}
                              asmPc={disasm?.pc} />
                  {asm && !inlineAsm && asmPane}
                </>
              );
            })()}
          </div>
        </div>
        <AsideDrag onResize={(w) => setAsideW(w)} />
        <div className="aside" style={{ width: asideW }}>
          {threads.length > 0 && (
            <Panel title="Threads">
              {threads.map((t) => {
                const loc = tlocs.get(t.id);
                return (
                  <div key={t.id} className={"frame" + (t.id === curTid ? " top" : "")}
                       title={`thread id ${t.id}`} onClick={() => selectThread(t)}>
                    <span className="tname">{t.name || `thread ${t.id}`}</span>
                    {loc && <span className="tloc">
                      {loc.label}
                      {loc.pc && memLinks && (
                        <span className="addr" title="view memory at pc"
                              onClick={(e) => { e.stopPropagation(); viewMemory(loc.pc); }}> {loc.pc}</span>
                      )}
                    </span>}
                  </div>
                );
              })}
            </Panel>
          )}
          <Panel title="Call Stack">
            {frames.length
              ? frames.map((f, i) => (
                  <div key={i} className={"frame" + (i === selFrame ? " top" : "")}
                       title={f.path || "no source"} onClick={() => selectFrame(i)}>
                    #{i} {f.name}:{f.line}
                  </div>
                ))
              : <span className="hint">—</span>}
          </Panel>
          <Panel title="Breakpoints" action={bps.size > 0 && (
            <span className="bpacts">
              <button className="addbtn" title={anyBpEnabled ? "disable all" : "enable all"}
                      onClick={toggleAllBps}>⊘</button>
              <button className="addbtn" title="remove all" onClick={clearAllBps}>✕</button>
            </span>
          )}>
            <BpList bps={bps} onJump={(p, ln) => openFile(p, ln)} onRemove={removeBp} onToggle={setBpEnabled}
                    onEdit={(path, line, x, y) => setBpEdit({ path, line, x, y })} />
          </Panel>
          <Panel title="Locals">
            <VarList vars={locals} disabled={!stopped} parentRef={scopeRef}
                     onSetVar={caps.supportsSetVariable ? setVar : undefined}
                     onAddr={memLinks ? viewMemory : undefined} />
          </Panel>
          <Panel title="Watch" action={<button className="addbtn" onClick={() => {
            const expr = prompt("watch expression:");
            if (!expr) return;
            setWatches((w) => [...w, { expr, value: null }]);
            if (stopped) setTimeout(() => {
              const id = ++evalSeq;
              pending.set(id, { kind: "watch", expr });
              send({ cmd: "evaluate", expr, context: "watch", id, frameId: frame0Ref.current });
            });
          }}>+</button>}>
            {watches.length
              ? watches.map((w, i) => (
                  <div key={i} className="wrow">
                    <span className="expr">{w.expr}</span>
                    <span className="wval"><Val text={w.value ?? "—"} onAddr={memLinks ? viewMemory : undefined} /></span>
                    <span className="rm" onClick={() => setWatches((x) => x.filter((_, j) => j !== i))}>✕</span>
                  </div>
                ))
              : <span className="hint">no expressions</span>}
          </Panel>
          {/* Registers moved to their own bottom-panel tab (next to Memory) —
              they're tall and noisy beside LOCALS, and pair with the memory view. */}
          {/* Rarely touched per-session — lives at the bottom on purpose. */}
          {excFilters.length > 0 && (
            <Panel title="Exceptions">
              {excFilters.map((f: any) => (
                <label key={f.filter} className="excrow">
                  <input type="checkbox" checked={excSel.has(f.filter)} onChange={(e) => {
                    const next = new Set(excSel);
                    e.target.checked ? next.add(f.filter) : next.delete(f.filter);
                    setExcSel(next);
                    send({ cmd: "setExceptions", filters: [...next] });
                  }} /> {f.label || f.filter}
                </label>
              ))}
            </Panel>
          )}
        </div>
        {bpEdit && (
          <BpPopover
            line={bpEdit.line} x={bpEdit.x} y={bpEdit.y}
            meta={bps.get(bpKey(bpEdit.path, bpEdit.line)) ?? {}}
            exists={bps.has(bpKey(bpEdit.path, bpEdit.line))}
            caps={caps}
            onApply={(meta) => { setBpMetaAt(bpEdit.path, bpEdit.line, meta); setBpEdit(null); }}
            onRemove={() => { removeBp(bpEdit.path, bpEdit.line); setBpEdit(null); }}
            onClose={() => setBpEdit(null)}
          />
        )}
      </main>
      <div className="bottom" style={{ height: bottomH }}>
        <DragBar onResize={(h) => setBottomH(h)} />
        <div className="tabs">
          <div className={"tab" + (tab === "term" ? " active" : "")} onClick={() => setTab("term")}>Terminal</div>
          <div className={"tab" + (tab === "mem" ? " active" : "")} onClick={() => setTab("mem")}>Memory</div>
          {registersRef > 0 && (
            <div className={"tab" + (tab === "regs" ? " active" : "")} onClick={() => setTab("regs")}>Registers</div>
          )}
          <div className={"tab" + (tab === "stack" ? " active" : "")} onClick={() => setTab("stack")}>Stack</div>
          {tab === "term" && (
            <span className="termlegend" title="program output renders plain; debugger output is tagged and dimmed">
              <span className="sw prog" /> program
              <span className="sw dbg" /> {dbgLabel}
            </span>
          )}
        </div>
        {/* Merged terminal (VS Code-style): the debuggee's tty and the debugger's
            own output share one scrollback; the REPL input drives evaluate. */}
        <div className="tabpane termpane" style={{ display: tab === "term" ? "flex" : "none" }}>
          <XTermView termRef={termRef} />
          <DebugConsole append={consoleAppend} frame0Ref={frame0Ref}
                        canComplete={!!caps.supportsCompletionsRequest} />
        </div>
        <div className="tabpane" style={{ display: tab === "mem" ? "flex" : "none" }}>
          <MemView mem={mem} addr={memAddr} setAddr={setMemAddr} err={memErr}
                   enabled={memLinks && stopped} onLoad={viewMemory} classify={classifyRegion}
                   locals={locals} frames={frames} regFrame={regFrame} />
        </div>
        {/* Always mounted (display-toggled): RegistersPanel reports sp/fp/lr up via
            onFrame, which the Memory and Stack views depend on regardless of tab. */}
        {registersRef > 0 && (
          <div className="tabpane regpane" style={{ display: tab === "regs" ? "flex" : "none" }}>
            <RegistersPanel regRef={registersRef} stopSeq={stopSeq} disabled={!stopped}
                            classify={classifyRegion} onFrame={setRegFrame}
                            onSetVar={caps.supportsSetVariable ? setVar : undefined}
                            onAddr={memLinks ? viewMemory : undefined} bare />
          </div>
        )}
        {/* Mounted only when visible: the drawing walks the fp chain with a
            readMemory round-trip per frame on every stop. */}
        {tab === "stack" && (
          <div className="tabpane">
            <StackView enabled={memLinks && stopped} regFrame={regFrame} frames={frames}
                       stopSeq={stopSeq} onAddr={viewMemory} />
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({ title, action, children }: any) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={"panel" + (collapsed ? " collapsed" : "")}>
      <h2>
        <span className="panel-toggle" onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? "expand" : "collapse"}>
          <span className="chev">{collapsed ? "▸" : "▾"}</span>{title}
        </span>
        {action}
      </h2>
      {!collapsed && <div className="body">{children}</div>}
    </div>
  );
}

// Control/frame registers pinned to the top, in this order, with a role label.
// The four that steer execution shouldn't have to be hunted for in x0..x30.
const REG_PIN: string[] = ["pc", "sp", "fp", "lr", "x29", "x30", "cpsr"];
const REG_ROLE: Record<string, string> = {
  pc: "program counter", sp: "stack ptr", fp: "frame · x29", lr: "return · x30",
  x29: "frame ptr", x30: "return addr", cpsr: "flags",
  x0: "arg0 · ret", x1: "arg1", x2: "arg2", x3: "arg3",
  x4: "arg4", x5: "arg5", x6: "arg6", x7: "arg7",
};

type RegRow = { v: Var; changed: boolean };

// Plain-English tooltip per region type — the color legend is meaningless
// without knowing what "const" or "__TEXT" actually is.
const REGION_HELP: Record<RegionType, string> = {
  stack: "stack — local variables & call frames (grows per function call)",
  heap:  "heap — dynamically allocated memory (malloc / new)",
  code:  "code — executable machine instructions (the program itself, __TEXT)",
  const: "const — read-only data: string literals, constants, linker tables",
  data:  "data — global & static variables (__DATA)",
};

// Registers: flat, control regs pinned on top with roles, changed-since-last-step
// in amber. The adapter nests the real registers under group nodes (General
// Purpose, FP, …); we walk scope → groups → leaves and hoist the GP leaves so
// they show without a click. Non-GP groups (vector/FP/…) stay collapsible below.
function RegistersPanel({ regRef, stopSeq, disabled, classify, onFrame, onSetVar, onAddr, bare }: {
  regRef: number; stopSeq: number; disabled: boolean;
  classify: ((a: string) => RegionType | null) | null;
  onFrame?: (f: { sp: string; fp: string; lr: string }) => void;
  onSetVar?: (parentRef: number, name: string, value: string) => Promise<any>;
  onAddr?: (a: string) => void;
  bare?: boolean;   // render without the Panel chrome (for the dedicated tab)
}) {
  const [gp, setGp] = useState<{ rows: RegRow[]; ref: number }>({ rows: [], ref: 0 });
  const [otherGroups, setOtherGroups] = useState<Var[]>([]);
  // Last committed value per register, and a sticky "changed" flag. Both live
  // here so they survive the per-stop refetch (register names are unique in the
  // scope). The flag updates ONLY on a real value transition and persists across
  // identical re-reads — a single step can emit two `stopped` events, and a
  // recompute-every-run design would clear the highlight on the duplicate.
  const prevVals = useRef<Map<string, string>>(new Map());
  const changedFlag = useRef<Map<string, boolean>>(new Map());

  // Re-read on regRef change AND every stop (stopSeq): lldb-dap keeps the
  // scope/group refs stable within a session, so a ref-only key would freeze.
  useEffect(() => {
    if (!regRef) {
      setGp({ rows: [], ref: 0 }); setOtherGroups([]);
      prevVals.current.clear(); changedFlag.current.clear(); return;
    }
    let live = true;
    (async () => {
      const groups = await expandRef(regRef);
      const withLeaves = await Promise.all(groups.map(async (g) =>
        ({ g, leaves: g.ref > 0 ? await expandRef(g.ref) : [g] })));
      if (!live) return;
      // GP = the group holding pc/x0. Flatten it; leave the rest collapsible.
      const gi = withLeaves.findIndex(({ leaves }) =>
        leaves.some((l) => l.name === "pc" || l.name === "x0"));
      const gpEntry = gi >= 0 ? withLeaves[gi] : null;
      const leaves = gpEntry?.leaves ?? [];
      const pinned = REG_PIN.map((n) => leaves.find((l) => l.name === n)).filter(Boolean) as Var[];
      const pinnedNames = new Set(pinned.map((l) => l.name));
      const rest = leaves.filter((l) => !pinnedNames.has(l.name));
      const ordered = [...pinned, ...rest];
      // Highlight exactly the regs the *latest* step moved. A single step can
      // emit a duplicate `stopped` with identical values; recomputing on that
      // would wrongly clear the marks. So: recompute only when at least one reg
      // differs from the last committed snapshot (pc always moves on a real
      // step) — a duplicate is a no-op that preserves the marks; the next real
      // step clears the stale ones and lights the newly-moved.
      const prev = prevVals.current, flag = changedFlag.current;
      const first = prev.size === 0;
      const anyDiff = ordered.some((v) => prev.get(v.name) !== v.value);
      if (first || anyDiff) {
        for (const v of ordered) {
          const p = prev.get(v.name);
          flag.set(v.name, !first && p !== undefined && p !== v.value);
          prev.set(v.name, v.value);
        }
      }
      const rows: RegRow[] = ordered.map((v) => ({ v, changed: flag.get(v.name) ?? false }));
      // Report sp/fp/lr up: sp builds the stack-aware classifier shared with
      // Memory; fp/lr let the memory view label saved-frame / return slots.
      // Values look like "0x16b6cb418" (or with a trailing symbol) — take the hex.
      const hexOf = (n: string) =>
        (ordered.find((v) => v.name === n)?.value.match(/0x[0-9a-fA-F]+/) || [])[0] ?? "";
      onFrame?.({ sp: hexOf("sp"), fp: hexOf("fp") || hexOf("x29"), lr: hexOf("lr") || hexOf("x30") });
      setGp({ rows, ref: gpEntry?.g.ref ?? 0 });
      setOtherGroups(withLeaves.filter((_, i) => i !== gi).map(({ g }) => g));
    })();
    return () => { live = false; };
  }, [regRef, stopSeq]);

  // Region-color each register by what its value points into (classify comes
  // from App; null until a `regions` message arrives — python/go send none).
  const content = gp.rows.length === 0 && otherGroups.length === 0
    ? <span className="hint">—</span>
    : <>
        <div className="regflat">
          {gp.rows.map(({ v, changed }) => {
            const addr = (v.value.match(/0x[0-9a-fA-F]+/) || [])[0] || "";
            const region = classify && addr ? classify(addr) : null;
            return (
              <RegRowView key={v.name} v={v} changed={changed} role={REG_ROLE[v.name]}
                          region={region} disabled={disabled} parentRef={gp.ref}
                          onSetVar={onSetVar} onAddr={onAddr} />
            );
          })}
        </div>
        {/* vector / FP / exception groups: rarely needed, kept collapsible */}
        {otherGroups.length > 0 &&
          <VarList vars={otherGroups} disabled={disabled} parentRef={regRef}
                   onSetVar={onSetVar} onAddr={onAddr} prevVals={prevVals} gen={stopSeq} />}
      </>;
  if (bare) return <div className="regview">{content}</div>;
  return <Panel title="Registers">{content}</Panel>;
}

// One flat register row: name · role · value. Value editable via setVariable,
// addresses clickable, amber when it moved since the last stop.
function RegRowView({ v, changed, role, region, disabled, parentRef, onSetVar, onAddr }: {
  v: Var; changed: boolean; role?: string; region?: RegionType | null;
  disabled: boolean; parentRef: number;
  onSetVar?: SetVarFn; onAddr?: (a: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { setShown(null); }, [v.value]);
  const val = shown ?? v.value;
  const startEdit = () => { if (!disabled && onSetVar) { setDraft(val); setEditing(true); } };
  const commit = () => {
    setEditing(false);
    onSetVar!(parentRef, v.name, draft).then((r: any) => { if (r) setShown(r.value); });
  };
  return (
    <div className={"regrow" + (changed ? " changed" : "")}>
      <span className="rmark">{changed ? "▲" : ""}</span>
      <span className="rname">{v.name}</span>
      <span className="rrole">{role ?? ""}</span>
      {editing ? (
        <input className="varedit" autoFocus value={draft} spellCheck={false}
               onChange={(e) => setDraft(e.target.value)}
               onBlur={() => setEditing(false)}
               onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }} />
      ) : (
        <span className="rval" onDoubleClick={startEdit} title={region ? `${val}\n${REGION_HELP[region]}` : val}>
          {region && <span className={"rdot b-" + region} title={REGION_HELP[region]} />}
          <Val text={val} onAddr={onAddr} cls={region ? "t-" + region : undefined} />
          {/* Non-pointer regs (no region) are plain numbers — show decimal too. */}
          {!region && (() => {
            const hx = (val.match(/^0x[0-9a-fA-F]+$/) || [])[0];
            if (!hx) return null;
            let d: string;
            try { d = BigInt(hx).toString(); } catch { return null; }
            return d === "0" ? null : <span className="rdec" title="decimal">{d}</span>;
          })()}
        </span>
      )}
      {onAddr && v.mref &&
        <span className="memlink" title={`view memory at ${v.mref}`} onClick={() => onAddr(v.mref!)}>⌗</span>}
    </div>
  );
}

// Render a value with 0x… addresses clickable (memory viewer entry point).
// `cls` region-tints the address digits so a pointer reads the same color here
// as in the memory view (e.g. a stack pointer is green in both).
function Val({ text, onAddr, cls }: { text: string; onAddr?: (a: string) => void; cls?: string }) {
  if (!onAddr) return <>{text}</>;
  const parts = text.split(/(0x[0-9a-fA-F]{4,})/g);
  return (
    <>
      {parts.map((p, i) => /^0x[0-9a-fA-F]{4,}$/.test(p)
        ? <span key={i} className={"addr" + (cls ? " " + cls : "")} title="view memory" onClick={(e) => { e.stopPropagation(); onAddr(p); }}>{p}</span>
        : p)}
    </>
  );
}

// All breakpoints across files with their condition/hit/log meta.
// Hover a row → ✎ opens the same condition/hit/logpoint editor as the gutter.
function BpList({ bps, onJump, onRemove, onToggle, onEdit }: {
  bps: Map<string, BpMeta>;
  onJump: (path: string, ln: number) => void;
  onRemove: (path: string, ln: number) => void;
  onToggle: (path: string, ln: number, meta: BpMeta) => void;
  onEdit: (path: string, ln: number, x: number, y: number) => void;
}) {
  const rows = [...bps.entries()].map(([k, m]) => {
    const i = k.indexOf("\n");
    return { path: k.slice(0, i), line: Number(k.slice(i + 1)), meta: m };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  if (!rows.length) return <span className="hint">none — click the gutter, or right-click / ✎ for conditions & logpoints</span>;
  return (
    <>
      {rows.map(({ path, line, meta }) => {
        const kind = meta.logMessage ? "log" : (meta.condition || meta.hitCondition) ? "cond" : "";
        const detail = meta.logMessage
          ? `log: ${meta.logMessage}`
          : [meta.condition, meta.hitCondition && `hits ${meta.hitCondition}`].filter(Boolean).join(" · ");
        return (
          <div key={bpKey(path, line)} className={"bprow" + (meta.enabled === false ? " off" : "")}
               title={path} onClick={() => onJump(path, line)}>
            <span className={"bpdot " + kind} title={meta.enabled === false ? "enable" : "disable"}
                  onClick={(e) => { e.stopPropagation(); onToggle(path, line, meta); }} />
            <span className="bpline">{base(path)}:{line}</span>
            {detail && <span className="bpdetail" title={detail}>{detail}</span>}
            <span className="bpedit" title="edit condition / hit count / logpoint"
                  onClick={(e) => { e.stopPropagation(); onEdit(path, line, e.clientX, e.clientY); }}>✎</span>
            <span className="rm" title="remove"
                  onClick={(e) => { e.stopPropagation(); onRemove(path, line); }}>✕</span>
          </div>
        );
      })}
    </>
  );
}

// Lazily-expanded variable tree. Refs die on resume, so parents pass fresh
// vars on every stop and expansion state resets with them (key on stop).
// parentRef = the container's variablesReference — what setVariable addresses
// a member of (scope ref at the top level, the parent var's ref below).
type SetVarFn = (parentRef: number, name: string, value: string) => Promise<any>;

// prevVals (registers only): name→prior-stop value, owned by RegistersPanel so
// it survives the leaf remount on resume. Its presence enables the highlight.
type PrevVals = React.MutableRefObject<Map<string, string>>;

function VarList({ vars, disabled, parentRef, onSetVar, onAddr, prevVals, gen }: {
  vars: Var[]; disabled: boolean; parentRef: number; onSetVar?: SetVarFn;
  onAddr?: (a: string) => void; prevVals?: PrevVals; gen?: number;
}) {
  if (!vars.length) return <span className="hint">—</span>;
  return (
    <div className="vartree">
      {vars.map((v, i) => <VarNode key={i} v={v} disabled={disabled} parentRef={parentRef} onSetVar={onSetVar} onAddr={onAddr} prevVals={prevVals} gen={gen} />)}
    </div>
  );
}

// gen (registers only): bumps each stop. Open expandable nodes refetch their
// kids on a gen change even when the ref is stable — else nested registers freeze.
function VarNode({ v, disabled, parentRef, onSetVar, onAddr, prevVals, gen }: {
  v: Var; disabled: boolean; parentRef: number; onSetVar?: SetVarFn;
  onAddr?: (a: string) => void; prevVals?: PrevVals; gen?: number;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Var[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Adapter-formatted value after a successful edit; cleared when a stop
  // delivers a fresh value through props.
  const [shown, setShown] = useState<string | null>(null);
  // Changed-since-last-step highlight (registers only). Diff against the value
  // this register held at the prior stop; first appearance is never "changed".
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    setShown(null);
    if (prevVals) {
      const p = prevVals.current.get(v.name);
      setChanged(p !== undefined && p !== v.value);
      prevVals.current.set(v.name, v.value);
    }
  }, [v.value]);
  // Refetch kids when the ref changes (locals: refs die on resume, so cached
  // kids via the old ref may be garbage reads) or on a new stop (registers: the
  // ref is stable across stops, so gen is the only signal the values moved).
  // Drop the cache either way; if open, re-read so the subtree stays current.
  useEffect(() => {
    setKids(null);
    if (v.ref <= 0) { setOpen(false); return; }
    if (open) {
      const id = ++evalSeq;
      pending.set(id, { kind: "expand", done: (vars: Var[]) => setKids(vars) });
      send({ cmd: "expand", ref: v.ref, id });
    }
  }, [v.ref, gen]);
  const expand = () => {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (kids) return;
    const id = ++evalSeq;
    pending.set(id, { kind: "expand", done: (vars: Var[]) => setKids(vars) });
    send({ cmd: "expand", ref: v.ref, id });
  };
  const startEdit = () => {
    if (disabled || !onSetVar) return;
    setDraft(shown ?? v.value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onSetVar!(parentRef, v.name, draft).then((r: any) => {
      if (!r) return;
      setShown(r.value);
      // Container contents changed under us — collapse so the next expand refetches.
      if (v.ref > 0) { setKids(null); setOpen(false); }
    });
  };
  const val = shown ?? v.value;
  return (
    <div>
      <div className="var">
        <span className="tw" onClick={v.ref > 0 ? expand : undefined}>
          {v.ref > 0 ? (open ? "▾" : "▸") : " "}
        </span>
        <span className="name">{v.name}</span>
        {/* Type chip is for locals only; on registers (prevVals set) the adapter's
            "unsigned long" / "<no-type>" is noise. */}
        {v.type && !prevVals && <span className="vtype" title={v.type}>{v.type}</span>}
        {editing ? (
          <input className="varedit" autoFocus value={draft} spellCheck={false}
                 onChange={(e) => setDraft(e.target.value)}
                 onBlur={() => setEditing(false)}
                 onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }} />
        ) : (
          <span className={"val" + (changed ? " changed" : "")} onDoubleClick={startEdit} title={val}>
            <Val text={val} onAddr={onAddr} />
          </span>
        )}
        {onAddr && v.mref && (
          <span className="memlink" title={`view memory at ${v.mref}`}
                onClick={() => onAddr(v.mref!)}>⌗</span>
        )}
      </div>
      {open && (
        <div className="kids">
          {kids
            ? <VarList vars={kids} disabled={disabled} parentRef={v.ref} onSetVar={onSetVar} onAddr={onAddr} prevVals={prevVals} gen={gen} />
            : <span className="hint">…</span>}
        </div>
      )}
    </div>
  );
}

function DragBar({ onResize }: { onResize: (h: number) => void }) {
  return (
    <div className="dragbar" onMouseDown={() => {
      const move = (e: MouseEvent) =>
        onResize(Math.max(80, Math.min(window.innerHeight - 140, window.innerHeight - e.clientY)));
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }} />
  );
}

function AsideDrag({ onResize }: { onResize: (w: number) => void }) {
  return (
    <div className="aside-drag" onMouseDown={() => {
      const move = (e: MouseEvent) =>
        onResize(Math.max(200, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX)));
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }} />
  );
}

function XTermView({ termRef }: { termRef: React.MutableRefObject<Terminal | null> }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9", cursor: "#c9d1d9" },
      // No blink, and no cursor at all unless the terminal itself is focused —
      // REPL input lives in the console box, so a pulsing block here just distracts.
      cursorBlink: false,
      cursorInactiveStyle: "none",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(elRef.current!);
    fit.fit();
    term.onData((data) => send({ cmd: "stdin", data }));
    term.onResize(({ rows, cols }) => send({ cmd: "resize", rows, cols }));
    termRef.current = term;
    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(elRef.current!);
    return () => { window.removeEventListener("resize", onWinResize); ro.disconnect(); term.dispose(); };
  }, []);
  return <div className="term" ref={elRef} />;
}

// REPL input for the merged terminal — output (echo + results) is written into
// the shared xterm scrollback via `append`, not a separate log pane.
function DebugConsole({ append, frame0Ref, canComplete }: {
  append: (t: string, c?: string) => void;
  frame0Ref: React.MutableRefObject<number>;
  canComplete: boolean;
}) {
  const [input, setInput] = useState("");
  const [comps, setComps] = useState<{ label: string; text: string }[] | null>(null);
  const [sel, setSel] = useState(0);
  // Submitted commands, newest-first; histPos walks them (-1 = live input).
  const hist = useRef<string[]>([]);
  const histPos = useRef(-1);
  const submit = () => {
    const expr = input.trim();
    if (!expr) return;
    hist.current = [expr, ...hist.current.filter((h) => h !== expr)].slice(0, 200);
    histPos.current = -1;
    setInput("");
    setComps(null);
    append("› " + expr + "\n", "in");
    const id = ++evalSeq;
    pending.set(id, { kind: "repl", done: (value: string, error: boolean) => append(value + "\n", error ? "err" : "") });
    send({ cmd: "evaluate", expr, context: "repl", id, frameId: frame0Ref.current });
  };
  // Replace the token being completed. DAP targets may carry start/length; the
  // lldb ones usually don't, so fall back to swapping the last word.
  const apply = (t: { text: string }) => {
    setComps(null);
    setInput((cur) => cur.replace(/[A-Za-z_$][\w$]*$/, "") + t.text);
  };
  const complete = () => {
    const id = ++evalSeq;
    pending.set(id, {
      kind: "cmpl",
      done: (targets: any[]) => {
        if (!targets.length) return;
        if (targets.length === 1) apply(targets[0]);
        else { setComps(targets.slice(0, 20)); setSel(0); }
      },
    });
    send({ cmd: "complete", text: input, column: input.length + 1, frameId: frame0Ref.current, id });
    setTimeout(() => pending.delete(id), 2000);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (comps) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % comps.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s + comps.length - 1) % comps.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); apply(comps[sel]); return; }
      if (e.key === "Escape") { setComps(null); return; }
    }
    if (e.key === "Enter") submit();
    else if (e.key === "Tab" && canComplete) { e.preventDefault(); complete(); }
    // Shell-style history: ↑ older, ↓ newer (↓ past newest → back to live input).
    else if (e.key === "ArrowUp") {
      if (!hist.current.length) return;
      e.preventDefault();
      histPos.current = Math.min(histPos.current + 1, hist.current.length - 1);
      setInput(hist.current[histPos.current]);
    } else if (e.key === "ArrowDown") {
      if (histPos.current < 0) return;
      e.preventDefault();
      histPos.current -= 1;
      setInput(histPos.current < 0 ? "" : hist.current[histPos.current]);
    }
  };
  return (
    <div className="console-input">
      {comps && (
        <div className="comps">
          {comps.map((c, i) => (
            <div key={i} className={"comp" + (i === sel ? " sel" : "")}
                 onMouseDown={(e) => { e.preventDefault(); apply(c); }}>{c.label}</div>
          ))}
        </div>
      )}
      <span className="prompt">›</span>
      <input value={input} onChange={(e) => { setInput(e.target.value); setComps(null); histPos.current = -1; }}
             onKeyDown={onKey}
             placeholder={canComplete ? "expression or debugger command… (Tab completes)" : "expression or debugger command…"} />
    </div>
  );
}

// One box in the stack drawing: a call frame spanning `lo`..`hi`, tied to DAP
// frame index `fi`. `fp` is null for a frameless frame — a leaf whose prologue
// clang elided, so it pushed no (fp, lr) pair and owns no chain link.
type FrameBox = {
  fi: number; name: string; lo: bigint; hi: bigint;
  fp: bigint | null; savedFp: bigint; savedLr: bigint;
  sized: boolean;   // false when the span is a guess (frameless, from locals)
};
// A local placed on the stack: its address, and which frame scoped it.
type Slot = Var & { at: bigint; owner: number };
// One link of the fp chain, before we know which frame it belongs to.
type Link = { fp: bigint; savedFp: bigint; savedLr: bigint };

const biOf = (s: string): bigint | null => { try { return s ? BigInt(s) : null; } catch { return null; } };
const le64 = (b: Uint8Array, off: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
const hex = (v: bigint) => "0x" + v.toString(16);

// Stack drawing: high addresses on top, the stack growing down the page just as
// it grows down in memory. Frames come from walking the AArch64 fp chain —
// [fp] = caller's fp, [fp+8] = return address — rather than from the adapter's
// stackTrace, because only the chain gives us the actual byte boundaries. The
// adapter's frame names are laid over it (chain depth i ↔ frame i).
function StackView({ enabled, regFrame, frames, stopSeq, onAddr }: {
  enabled: boolean;
  regFrame: { sp: string; fp: string; lr: string };
  frames: Frame[]; stopSeq: number;
  onAddr: (a: string) => void;
}) {
  const [boxes, setBoxes] = useState<FrameBox[]>([]);
  // Every frame's locals, tagged with the frame they were scoped in. Placement
  // is by address, not by owner: a struct returned by value lives in the
  // *caller's* frame (sret), and the drawing should show it where it is.
  const [vars, setVars] = useState<Slot[]>([]);
  const sp = biOf(regFrame.sp);

  useEffect(() => {
    const fp0 = biOf(regFrame.fp);
    if (!enabled || fp0 === null || fp0 === 0n || !frames.length) { setBoxes([]); setVars([]); return; }
    let live = true;
    (async () => {
      // 1. Walk the chain. 24 levels is plenty for a screenful; a corrupt link
      // (a smashed frame) is cut off by the checks below, never looped on.
      const links: Link[] = [];
      let fp = fp0;
      for (let i = 0; i < 24; i++) {
        const b = await readMemAt(hex(fp), 16);
        if (!live) return;
        if (!b || b.length < 16) break;
        links.push({ fp, savedFp: le64(b, 0), savedLr: le64(b, 8) });
        // Chain ends at 0 (the outermost frame parks it there); a non-increasing
        // fp means we're not looking at a real frame link anymore.
        if (links[i].savedFp === 0n || links[i].savedFp <= fp) break;
        fp = links[i].savedFp;
      }

      // 2. Which DAP frame does each link belong to? Not simply "link k ↔ frame
      // k": a leaf whose prologue clang elided (no calls, few locals) pushes no
      // (fp, lr) pair, so the fp register still holds its *caller's* fp and the
      // leaf owns no link. Identify a link by its saved lr, which is the return
      // address into the caller — exactly the pc DAP reports for that caller's
      // frame. Link with savedLr == frames[j].ipRef therefore belongs to frame
      // j-1. Frames that no link claims are frameless.
      const ipToFrame = new Map<string, number>();
      frames.forEach((f, j) => { const a = biOf(f.ipRef); if (a !== null && j > 0) ipToFrame.set(a.toString(), j); });
      const fiOf = new Map<number, number>();      // link index → dap frame index
      let fallback = 0;
      links.forEach((l, k) => {
        const j = ipToFrame.get(l.savedLr.toString());
        const fi = j !== undefined ? j - 1 : fallback;
        fiOf.set(k, fi);
        fallback = fi + 1;
      });
      const linkOfFrame = new Map<number, Link>();
      fiOf.forEach((fi, k) => linkOfFrame.set(fi, links[k]));

      // 3. Locals for every drawn frame — one scopes+variables round-trip each,
      // issued strictly in sequence. Overlapping them drops a frame's variables
      // (lldb-dap serves one request at a time and answers the later `scopes`
      // against the earlier frame), so the concurrency would buy nothing anyway.
      // Address-less locals live in registers, not on the stack — skip them.
      // Dedupe by address: an sret buffer is named in both frames that see it.
      const depth = Math.min(frames.length, Math.max(links.length, [...fiOf.values()].reduce((a, b) => Math.max(a, b), 0) + 1));
      const slots: Slot[] = [];
      const seen = new Set<string>();
      for (let fi = 0; fi < depth; fi++) {
        const vs = await frameLocalsOf(frames[fi].id);
        if (!live) return;
        for (const v of vs) {
          const a = biOf(v.mref || "");
          if (a === null || seen.has(a.toString())) continue;
          seen.add(a.toString());
          slots.push({ ...v, at: a, owner: fi });
        }
      }

      // 4. Bounds, innermost frame first: each frame starts where the frame it
      // called ended (the innermost starts at sp) and ends past its saved pair.
      // A frameless frame has no saved pair to end at, so its extent is inferred
      // from its highest local — a guess, flagged as one.
      const out: FrameBox[] = [];
      let prevHi = sp ?? fp0;
      for (let fi = 0; fi < depth; fi++) {
        const l = linkOfFrame.get(fi);
        const lo = prevHi;
        let hi: bigint, sized = true;
        if (l) hi = l.fp + 16n;
        else {
          const mine = slots.filter((v) => v.owner === fi);
          hi = mine.length ? mine.reduce((m, v) => (v.at > m ? v.at : m), lo) + 8n : lo;
          sized = false;
        }
        out.push({
          fi, name: frames[fi]?.name ?? "…", lo, hi, sized,
          fp: l?.fp ?? null, savedFp: l?.savedFp ?? 0n, savedLr: l?.savedLr ?? 0n,
        });
        prevHi = hi;
      }
      setBoxes(out);
      setVars(slots);
    })();
    return () => { live = false; };
  }, [enabled, regFrame.fp, regFrame.sp, stopSeq, frames]);

  if (!enabled) return <div className="stackview"><span className="hint">stop the program to draw the stack</span></div>;
  if (!boxes.length) return <div className="stackview"><span className="hint">no frame pointer — nothing to unwind</span></div>;

  const deep = boxes[boxes.length - 1].hi - (sp ?? boxes[0].lo);
  // Locals belong to the frame lldb scoped them in — that's authoritative, and
  // an address alone can't tell you (a by-value return buffer sits in the
  // caller's frame). High→low so rows read in the drawing's direction.
  const localsIn = (b: FrameBox) =>
    vars.filter((v) => v.owner === b.fi).sort((p, q) => (q.at > p.at ? 1 : -1));

  return (
    <div className="stackview">
      <div className="stackhd">
        <span>call stack · {boxes.length} frame{boxes.length > 1 ? "s" : ""} · {deep.toString()} B</span>
        <span className="stackgrow" title="the stack pointer moves toward lower addresses on every call">
          high addr ↑ · grows ↓
        </span>
      </div>
      {/* Outermost (oldest, highest address) first — matches memory top-down. */}
      {[...boxes].reverse().map((b) => {
        const callee = boxes[b.fi - 1];             // the frame this one called
        const caller = boxes[b.fi + 1];             // the frame that called this
        const mine = localsIn(b);
        return (
          <div key={b.fi} className={"sframe" + (b.fi === 0 ? " sframe-cur" : "")}>
            <div className="sf-hd">
              <span className="sf-idx">#{b.fi}</span>
              <span className="sf-name">{b.name}</span>
              {!b.fp && <span className="sf-frameless" title="leaf function — clang elided the prologue, so this frame pushed no (fp, lr) pair and its extent is inferred from its locals">frameless</span>}
              <span className="sf-size">{b.sized ? "" : "~"}{(b.hi - b.lo).toString()} B</span>
              {b.fi === 0 && <span className="sf-badge">executing</span>}
            </div>
            <div className="sf-slots">
              {/* fp+8 and fp: the saved pair every non-leaf prologue pushes. */}
              {b.fp !== null && <>
                <div className="sf-slot" onClick={() => onAddr(hex(b.fp! + 8n))}>
                  <span className="sf-a">{hex(b.fp + 8n)}</span>
                  <span className="sf-k">saved lr</span>
                  <span className="sf-v t-code">→ {caller ? caller.name : hex(b.savedLr)}</span>
                </div>
                <div className="sf-slot" onClick={() => onAddr(hex(b.fp!))}>
                  <span className="sf-a">{hex(b.fp)}</span>
                  <span className="sf-k">saved fp</span>
                  <span className="sf-v t-stack">→ {b.savedFp ? hex(b.savedFp) : "0 (chain end)"}</span>
                </div>
              </>}
              {mine.length > 0
                ? mine.map((v) => (
                    <div key={v.name} className="sf-slot sf-local" onClick={() => onAddr(hex(v.at))}>
                      <span className="sf-a">{hex(v.at)}</span>
                      <span className="sf-k">{v.name}</span>
                      <span className="sf-v">
                        {v.type ? <em>{v.type} </em> : null}= {v.value}
                        {/* A local scoped here but living above this frame is a
                            by-value return buffer the caller allocated for us. */}
                        {v.at >= b.hi &&
                          <span className="sf-sret" title={`${v.name} lives in ${caller?.name ?? "the caller"}'s frame — a struct returned by value is written straight into the caller's buffer (sret)`}>
                            {" "}· sret, in {caller?.name ?? "caller"}'s frame
                          </span>}
                      </span>
                    </div>
                  ))
                : <div className="sf-slot sf-empty">
                    <span className="sf-a">{hex(b.lo)}</span>
                    <span className="sf-k">no locals</span>
                    <span className="sf-v">
                      {(b.hi - b.lo - (b.fp !== null ? 16n : 0n)).toString()} B — saved regs, spills{frames[b.fi] && !hasSrc(frames[b.fi].path) ? ", no debug info" : ""}
                    </span>
                  </div>}
            </div>
            {b.fi === 0 && sp !== null && (
              <div className="sf-sp" onClick={() => onAddr(hex(sp))}>
                <span className="sf-a">{hex(sp)}</span>
                <span className="sf-k">sp</span>
                <span className="sf-v">top of stack — next push lands below</span>
              </div>
            )}
            {callee && <div className="sf-link">↑ {callee.name} returns here</div>}
          </div>
        );
      })}
      <div className="stackfoot">↓ unallocated — the stack grows this way</div>
    </div>
  );
}

// A per-slot annotation under an 8-byte group: what this word *is* — a typed
// local (from DWARF), a saved frame pointer / return address, or a pointer into
// a named region. `follow` (present on typed pointers) opens the struct view.
type Anno = { text: string; cls?: string; follow?: { ref: number; name: string; type: string; target: string } };

// hex/dec/bin dump with ASCII column, 16 bytes per row. Slots are annotated
// with DWARF/frame knowledge and typed pointers can be followed into their struct.
function MemView({ mem, addr, setAddr, err, enabled, onLoad, classify, locals, frames, regFrame }: {
  mem: { addr: string; bytes: Uint8Array } | null;
  addr: string; setAddr: (a: string) => void; err: string;
  enabled: boolean; onLoad: (a: string) => void;
  classify: ((a: string) => RegionType | null) | null;
  locals: Var[]; frames: Frame[];
  regFrame: { sp: string; fp: string; lr: string };
}) {
  const [radix, setRadix] = useState<16 | 10 | 2>(16);
  // Element size in bytes (8/16/32/64-bit). Bytes group into little-endian
  // values of this width. Pointer chase + annotations still key off the 8-byte
  // word (a multiple of every stride), so they keep working at any stride.
  const [stride, setStride] = useState<1 | 2 | 4 | 8>(8);   // default 64-bit words
  // DWARF struct-follow panel: a typed pointer expanded into its members.
  const [follow, setFollow] = useState<{ name: string; type: string; target: string; rows: Var[] } | null>(null);
  // Peeked target previews: pointer-target hex → decoded C-string ("" = fetched,
  // no string). Const/data pointers are auto-peeked so literals show inline.
  const [peeks, setPeeks] = useState<Map<string, string>>(new Map());
  // Digits per element by radix×stride; dec padded to the max value's width.
  const decLen: Record<number, number> = { 1: 3, 2: 5, 4: 10, 8: 20 };
  const elemChars = radix === 16 ? 2 * stride : radix === 2 ? 8 * stride : decLen[stride];
  const elemsPerWord = 8 / stride;
  const page = (dir: number) => {
    if (!mem) return;
    try { onLoad("0x" + (BigInt(mem.addr) + BigInt(dir * 256)).toString(16)); } catch {}
  };
  const doFollow = (f: NonNullable<Anno["follow"]>) =>
    expandRef(f.ref).then((rows) => setFollow({ name: f.name, type: f.type, target: f.target, rows }));
  // A new window invalidates the follow panel (its slot is no longer on screen).
  useEffect(() => { setFollow(null); }, [mem?.addr]);

  // Read-only pointers in the current window whose targets we peek for an inline
  // string preview. const/data hold literals & constants; on macOS C string
  // literals live in __TEXT (classified code), so include code too — but skip
  // return addresses (frame pcs), which are instructions, never strings.
  const peekTargets = useMemo(() => {
    const s = new Set<string>();
    if (!mem) return s;
    const ips = new Set(frames.map((f) => { try { return BigInt(f.ipRef).toString(); } catch { return ""; } }));
    for (let off = 0; off + 8 <= mem.bytes.length; off += 8) {
      let ptr = 0n;
      for (let i = 7; i >= 0; i--) ptr = (ptr << 8n) | BigInt(mem.bytes[off + i]);
      if (ptr < 0x10000n || ptr >= 0x800000000000n) continue;
      const preg = classify ? classify("0x" + ptr.toString(16)) : null;
      if ((preg === "const" || preg === "data" || preg === "code") && !ips.has(ptr.toString()))
        s.add("0x" + ptr.toString(16));
    }
    return s;
  }, [mem, classify, frames]);
  // Fetch the strings for any not-yet-seen targets (bounded per window).
  useEffect(() => {
    let live = true;
    const missing = [...peekTargets].filter((t) => !peeks.has(t)).slice(0, 24);
    if (!missing.length) return;
    Promise.all(missing.map(async (t) => [t, decodeCStr(await readMemAt(t, 48))] as const))
      .then((pairs) => {
        if (!live) return;
        setPeeks((prev) => { const n = new Map(prev); for (const [t, str] of pairs) n.set(t, str); return n; });
      });
    return () => { live = false; };
  }, [peekTargets]);

  // Precompute annotation sources. Addresses are parsed to BigInt once.
  const bi = (s: string): bigint | null => { try { return s ? BigInt(s) : null; } catch { return null; } };
  const localByAddr = new Map<string, Var>();
  for (const v of locals) { const a = bi(v.mref || ""); if (a !== null) localByAddr.set(a.toString(), v); }
  const fpN = bi(regFrame.fp), lrN = bi(regFrame.lr), spN = bi(regFrame.sp);
  const frameIps = frames.map((f) => ({ ip: bi(f.ipRef), name: f.name })).filter((f) => f.ip !== null);
  const clip = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  // What is the 8-byte word at `slotAddr` (value `ptr`)? Most specific first.
  const annotate = (slotAddr: bigint, ptr: bigint, looksPtr: boolean): Anno | null => {
    const preg = looksPtr && classify ? classify("0x" + ptr.toString(16)) : null;
    const local = localByAddr.get(slotAddr.toString());
    if (local) {
      const isPtr = !!local.type && (local.type.includes("*") || (looksPtr && !!preg));
      if (isPtr && looksPtr) {
        const follow = local.ref > 0
          ? { ref: local.ref, name: local.name, type: local.type || "?", target: "0x" + ptr.toString(16) }
          : undefined;
        const str = peeks.get("0x" + ptr.toString(16));
        return { text: `${local.name} ${local.type || ""} → 0x${ptr.toString(16)}${preg ? ` (${preg})` : ""}${str ? `  ${JSON.stringify(str)}` : ""}`,
                 cls: preg ? "t-" + preg : undefined, follow };
      }
      return { text: clip(`${local.name} ${local.type ? local.type + " " : ""}= ${local.value}`) };
    }
    // Frame anatomy: fp points at the saved (fp, lr) pair; sp at the stack top.
    if (fpN !== null && slotAddr === fpN) return { text: "saved fp · x29 → caller frame", cls: "t-stack" };
    if (fpN !== null && slotAddr === fpN + 8n)
      return { text: `saved lr · return addr${preg === "code" ? " (code)" : ""}`, cls: preg ? "t-" + preg : "t-code" };
    if (spN !== null && slotAddr === spN) return { text: "sp · top of stack", cls: "t-stack" };
    if (!looksPtr) return null;
    // A word whose value is a known frame's pc — a return address into that fn.
    const fr = frameIps.find((f) => f.ip === ptr);
    if (fr) return { text: `→ ${fr.name} (code)`, cls: "t-code" };
    if (preg) {
      const str = peeks.get("0x" + ptr.toString(16));
      return { text: `→ 0x${ptr.toString(16)} (${preg})${str ? `  ${JSON.stringify(str)}` : ""}`, cls: "t-" + preg };
    }
    return null;
  };

  const rows: React.ReactNode[] = [];
  const wordW = elemsPerWord * (elemChars + 1) - 1;   // char width of an 8-byte word
  if (mem) {
    let baseAddr = 0n;
    try { baseAddr = BigInt(mem.addr); } catch {}
    for (let off = 0; off < mem.bytes.length; off += 16) {
      const chunk = mem.bytes.slice(off, off + 16);
      // 8-byte aligned groups; a group whose little-endian value lands in the
      // user-space address range is clickable — pointer chasing (list->next)
      // without reversing byte order by hand.
      const groups: React.ReactNode[] = [];
      const annos: (Anno | null)[] = [];
      for (let g = 0; g < chunk.length; g += 8) {
        const sub = chunk.slice(g, g + 8);
        // Render the word as `elemsPerWord` little-endian elements of `stride` bytes.
        const els: string[] = [];
        for (let k = 0; k + stride <= sub.length; k += stride) {
          let v = 0n;
          for (let i = stride - 1; i >= 0; i--) v = (v << 8n) | BigInt(sub[k + i]);
          els.push(v.toString(radix).padStart(elemChars, "0"));
        }
        const text = els.join(" ");
        let ptr = 0n;
        for (let i = sub.length - 1; i >= 0; i--) ptr = (ptr << 8n) | BigInt(sub[i]);
        const looksPtr = sub.length === 8 && ptr >= 0x10000n && ptr < 0x800000000000n;
        if (g > 0) groups.push(<span key={`gap${g}`}>{"  "}</span>);
        // A detected pointer is tinted by the region it targets — so you can see
        // "this 8-byte slot points into the stack / heap / code" at a glance.
        const preg = looksPtr && classify ? classify("0x" + ptr.toString(16)) : null;
        groups.push(looksPtr
          ? <span key={g} className={"memptr" + (preg ? " t-" + preg : "")}
                  title={preg ? `follow 0x${ptr.toString(16)}  →  ${REGION_HELP[preg]}` : `follow 0x${ptr.toString(16)}`}
                  onClick={() => onLoad("0x" + ptr.toString(16))}>{text}</span>
          : <span key={g}>{text}</span>);
        annos.push(sub.length === 8 ? annotate(baseAddr + BigInt(off + g), ptr, looksPtr) : null);
      }
      const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join("");
      rows.push(
        <div key={off} className="memrow">
          <span className="memaddr">0x{(baseAddr + BigInt(off)).toString(16).padStart(12, "0")}</span>
          <span className="membytes">{groups}</span>
          <span className="memascii">{ascii}</span>
        </div>
      );
      // One annotation row per annotated word — arrow padded to sit under its
      // column. Separate rows (not two cells) so long labels never collide.
      annos.forEach((a, wi) => {
        if (!a) return;
        rows.push(
          <div key={`a${off}_${wi}`} className="memannot">
            <span className="memaddr annospacer">0x000000000000</span>
            <span className="membytes">
              <span className={"anno" + (a.cls ? " " + a.cls : "") + (a.follow ? " annofollow" : "")}
                    style={{ paddingLeft: `${wi * (wordW + 2)}ch` }}
                    title={a.follow ? `follow ${a.follow.name} → ${a.follow.target}  (typed as ${a.follow.type})` : a.text}
                    onClick={a.follow ? () => doFollow(a.follow!) : undefined}>↑ {a.text}</span>
            </span>
          </div>
        );
      });
    }
  }
  return (
    <div className="memview">
      <div className="memctl">
        <input value={addr} placeholder="0x… address" spellCheck={false}
               onChange={(e) => setAddr(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && enabled && addr && onLoad(addr)} />
        <button disabled={!enabled || !addr} onClick={() => onLoad(addr)}>Go</button>
        <button disabled={!mem} onClick={() => page(-1)}>◀</button>
        <button disabled={!mem} onClick={() => page(1)}>▶</button>
        {([16, 10, 2] as const).map((r) => (
          <button key={r} className={radix === r ? "radix-on" : ""} onClick={() => setRadix(r)}>
            {r === 16 ? "hex" : r === 10 ? "dec" : "bin"}
          </button>
        ))}
        <span className="memctl-sep" />
        {([8, 16, 32, 64] as const).map((bits) => {
          const s = (bits / 8) as 1 | 2 | 4 | 8;
          return (
            <button key={bits} className={stride === s ? "radix-on" : ""} title={`${bits}-bit elements`}
                    onClick={() => setStride(s)}>{bits}</button>
          );
        })}
        {!enabled && <span className="hint">stop the program (and adapter must support readMemory)</span>}
      </div>
      {mem && (() => {
        // The window's own region is shown by lighting up its legend entry — no
        // banner sentence. Hover a swatch for the plain-English explanation.
        const reg = classify ? classify(mem.addr) : null;
        return (
          <div className="membanner">
            <span className="memlegend">
              {(["stack", "heap", "code", "const", "data"] as RegionType[]).map((t) => (
                <span key={t} className={"memleg" + (t === reg ? " memleg-on" : "")} title={REGION_HELP[t]}>
                  <span className={"rdot b-" + t} />{t}
                </span>
              ))}
            </span>
          </div>
        );
      })()}
      <div className="memdump">
        {err
          ? <span className="mem-err">{err}</span>
          : rows.length ? rows
          : <span className="hint">click ⌗ next to a variable, a 0x… address in Locals/Watch, or enter one above</span>}
      </div>
      {follow && (
        <div className="followpanel">
          <div className="follow-hd">
            follow <b>{follow.name}</b> → {follow.target} · typed as <b>{follow.type}</b> (DWARF)
            <span className="follow-x" onClick={() => setFollow(null)}>✕</span>
          </div>
          {follow.rows.length
            ? follow.rows.map((v, i) => (
                <div key={i} className="follow-row">
                  <span className="follow-name">{v.name}</span>
                  <span className="follow-type">{v.type || ""}</span>
                  <span className="follow-val"><Val text={v.value} onAddr={onLoad} /></span>
                </div>
              ))
            : <div className="hint">no members</div>}
        </div>
      )}
    </div>
  );
}
