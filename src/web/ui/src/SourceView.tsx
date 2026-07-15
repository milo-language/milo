// Monaco-based read-only source pane: glyph-margin clicks toggle breakpoints,
// the current stop line is highlighted and revealed. Everything is bundled
// locally (editor.api + Monarch grammars, worker served from /editor.worker.js)
// so the UI works with no network access.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { language as cppLang, conf as cppConf } from "monaco-editor/esm/vs/basic-languages/cpp/cpp.js";
import { language as pyLang, conf as pyConf } from "monaco-editor/esm/vs/basic-languages/python/python.js";

(self as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    new Worker(label === "json" ? "/json.worker.js" : "/editor.worker.js", { type: "module" }),
};

monaco.languages.register({ id: "cpp" });
monaco.languages.setMonarchTokensProvider("cpp", cppLang as any);
monaco.languages.setLanguageConfiguration("cpp", cppConf as any);
monaco.languages.register({ id: "python" });
monaco.languages.setMonarchTokensProvider("python", pyLang as any);
monaco.languages.setLanguageConfiguration("python", pyConf as any);

// Milo (.milo) — hand-written Monarch grammar derived from milo's lexer/tokens
// (github.com/… src/lexer.ts, src/tokens.ts). Only line comments exist in the
// language (no block comment); f-strings are `$"...{expr}..."`; numbers allow
// `_` separators plus 0x/0b bases. Token names are the standard ones vs-dark
// already colors (keyword/type/string/number/comment/operator).
monaco.languages.register({ id: "milo", extensions: [".milo"] });
monaco.languages.setLanguageConfiguration("milo", {
  comments: { lineComment: "//" },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});
monaco.languages.setMonarchTokensProvider("milo", {
  defaultToken: "",
  keywords: [
    "fn", "extern", "let", "var", "return", "if", "else", "while", "true", "false",
    "struct", "enum", "match", "mut", "import", "from", "break", "continue", "as",
    "trait", "impl", "for", "in", "unsafe", "move", "null", "is", "type", "parallel",
    "interface", "requires", "ensures", "invariant",
  ],
  typeKeywords: [
    "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "string", "void",
  ],
  operators: [
    "->", "=>", "::", "==", "!=", "<=", ">=", "&&", "||", "??", "...", "..",
    "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
    "+", "-", "*", "/", "%", "&", "|", "^", "~", "!", "=", "<", ">", "?", "@",
  ],
  symbols: /[=><!~?:&|+\-*\/^%@.]+/,
  escapes: /\\(?:[ntr0\\"']|x[0-9A-Fa-f]{2})/,
  tokenizer: {
    root: [
      // Capitalized identifiers read as type names (structs, enums, generics).
      [/[A-Z]\w*/, "type"],
      [/[a-zA-Z_]\w*/, {
        cases: {
          "@keywords": "keyword",
          "@typeKeywords": "type",
          "@default": "identifier",
        },
      }],
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[bB][01_]+/, "number.binary"],
      [/\d[\d_]*\.\d[\d_]*/, "number.float"],
      [/\d[\d_]*/, "number"],
      [/\/\/.*$/, "comment"],
      [/\$"/, { token: "string.quote", next: "@fstring" }],
      [/"/, { token: "string.quote", next: "@string" }],
      [/'(?:[^'\\]|\\.)'/, "string"],
      [/'/, "string.invalid"],
      [/[{}()\[\]]/, "@brackets"],
      [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],
      [/[,;]/, "delimiter"],
      [/\s+/, "white"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    fstring: [
      // Interpolation braces switch into an expression sub-state; nested object
      // braces inside an interpolation are rare enough to ignore for highlighting.
      [/\{/, { token: "delimiter.bracket", next: "@finterp" }],
      [/[^\\"{]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    finterp: [
      [/\}/, { token: "delimiter.bracket", next: "@pop" }],
      { include: "root" },
    ],
  },
} as any);

// Tiny Monarch grammar for the disassembly pane: every line the app
// generates is `0xADDR  mnemonic ops ; comment`, so the tokenizer keys off the
// leading address to find the mnemonic. Registers cover aarch64 + x86-64.
monaco.languages.register({ id: "asm" });
monaco.languages.setMonarchTokensProvider("asm", {
  tokenizer: {
    root: [
      [/^0x[0-9a-fA-F]+/, { token: "number.hex", switchTo: "@mnemonic" }],
      { include: "@operands" },
    ],
    mnemonic: [
      [/^0x[0-9a-fA-F]+/, "number.hex"],
      [/<[^>]*>:?/, "annotation"],
      [/[a-z][a-z0-9._]*/, { token: "keyword", switchTo: "@rest" }],
      [/\s+/, "white"],
      { include: "@operands" },
    ],
    rest: [
      [/^0x[0-9a-fA-F]+/, { token: "number.hex", switchTo: "@mnemonic" }],
      { include: "@operands" },
    ],
    operands: [
      [/;.*/, "comment"],
      [/<[^>]*>/, "annotation"],
      [/\b(x([0-9]|1[0-9]|2[0-8])|w\d+|sp|pc|lr|fp|xzr|wzr|[vqdshb]\d+)\b/, "variable.predefined"],
      [/\b(r[a-d]x|r[sd]i|r[sb]p|r\d+[dwb]?|e[a-d]x|e[sd]i|e[sb]p|[a-d][lhx]|[sd]il?|[sb]pl?)\b/, "variable.predefined"],
      [/#?-?0x[0-9a-fA-F]+\b/, "number.hex"],
      [/[#=]-?\d+/, "number"],
      [/[,\[\]!{}]/, "delimiter"],
      [/[a-zA-Z_$][\w.$]*/, "identifier"],
      [/\s+/, "white"],
    ],
  },
} as any);

// One-line descriptions for the disassembly hover. Keyed by bare mnemonic
// (size/cond suffixes are stripped before lookup); covers the aarch64 + x86-64
// instructions this UI actually surfaces. Unknown mnemonics just get no hover.
const ASM_DESC: Record<string, string> = {
  // ── data movement ──
  mov: "move register/immediate", movz: "move immediate, zero rest",
  movk: "move immediate, keep rest", movn: "move NOT immediate",
  fmov: "move between/into FP registers", ldr: "load register from memory",
  ldur: "load register (unscaled offset)", ldp: "load pair of registers",
  ldrb: "load byte (zero-extend)", ldrh: "load halfword (zero-extend)",
  ldrsw: "load word, sign-extend", str: "store register to memory",
  stur: "store register (unscaled offset)", stp: "store pair of registers",
  strb: "store byte", strh: "store halfword", lea: "load effective address",
  push: "push onto stack", pop: "pop off stack",
  // ── integer arithmetic / logic ──
  add: "add", adds: "add, set flags", adc: "add with carry", sub: "subtract",
  subs: "subtract, set flags", mul: "multiply", madd: "multiply-add",
  msub: "multiply-subtract", sdiv: "signed divide", udiv: "unsigned divide",
  neg: "negate", and: "bitwise AND", orr: "bitwise OR", eor: "bitwise XOR",
  xor: "bitwise XOR", or: "bitwise OR", not: "bitwise NOT", mvn: "bitwise NOT",
  lsl: "logical shift left", lsr: "logical shift right", asr: "arithmetic shift right",
  ror: "rotate right", shl: "shift left", shr: "shift right", sar: "arithmetic shift right",
  sxtw: "sign-extend word→doubleword", uxtw: "zero-extend word→doubleword",
  inc: "increment", dec: "decrement",
  // ── compare / condition ──
  cmp: "compare (subtract, set flags)", cmn: "compare negative", tst: "test (AND, set flags)",
  test: "test (AND, set flags)", ccmp: "conditional compare", csel: "conditional select",
  cset: "set 1/0 on condition", csinc: "conditional select+increment",
  // ── control flow ──
  b: "branch (unconditional)", bl: "branch with link (call)", br: "branch to register",
  blr: "branch to register with link (call)", ret: "return from subroutine",
  cbz: "compare and branch if zero", cbnz: "compare and branch if non-zero",
  tbz: "test bit and branch if zero", tbnz: "test bit and branch if non-zero",
  adr: "address of label (PC-relative)", adrp: "address of 4KB page (PC-relative)",
  call: "call subroutine", jmp: "jump", je: "jump if equal", jne: "jump if not equal",
  jz: "jump if zero", jnz: "jump if non-zero", jg: "jump if greater", jl: "jump if less",
  jge: "jump if ≥", jle: "jump if ≤", leave: "tear down stack frame",
  // ── floating point ──
  fadd: "FP add", fsub: "FP subtract", fmul: "FP multiply", fdiv: "FP divide",
  fmadd: "FP fused multiply-add", fmsub: "FP fused multiply-subtract", fneg: "FP negate",
  fsqrt: "FP square root", fabs: "FP absolute value", fcmp: "FP compare",
  fcvt: "FP convert precision", fcvtzs: "FP→signed int (truncate)",
  scvtf: "signed int→FP", ucvtf: "unsigned int→FP",
  movsd: "move scalar double", addsd: "add scalar double", subsd: "subtract scalar double",
  mulsd: "multiply scalar double", divsd: "divide scalar double",
  ucomisd: "compare scalar double, set flags", cvtsi2sd: "int→scalar double",
  // ── misc ──
  nop: "no operation", svc: "supervisor call (syscall)", udf: "permanently undefined (trap)",
  brk: "breakpoint trap", hlt: "halt", dmb: "data memory barrier", isb: "instruction sync barrier",
};

// Strip aarch64/x86 suffixes (fadd → fadd, ldrb kept, add.w → add) to hit the map.
function asmDesc(mnem: string): string | null {
  const m = mnem.toLowerCase();
  return ASM_DESC[m] ?? ASM_DESC[m.replace(/\.[a-z0-9]+$/, "")] ?? null;
}

monaco.languages.registerHoverProvider("asm", {
  provideHover: (model, pos) => {
    const w = model.getWordAtPosition(pos);
    if (!w) return null;
    const rng = new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn);
    const d = asmDesc(w.word);
    if (d) return { range: rng, contents: [{ value: `**${w.word}** — ${d}` }] };
    // A code-sized address (not a #imm/offset): advertise the click-to-follow.
    if (/^0x[0-9a-fA-F]{4,}$/.test(w.word)) {
      const pre = model.getLineContent(pos.lineNumber)[w.startColumn - 2];
      if (pre !== "#") return { range: rng, contents: [{ value: `\`${w.word}\` — click to follow` }] };
    }
    return null;
  },
});

// Enriched hover payload from the session: the value, plus one level of members
// for aggregates/pointers.
type HoverInfo = { value: string; children?: { name: string; value: string; type?: string }[] };

const mdCell = (s: string) => (s ?? "").replace(/\|/g, "\\|");
// Build the hover markdown: a `name  value` header, then a member table when the
// value expands (struct fields, array elements, a pointer's target).
function fmtHover(name: string, info: HoverInfo): string {
  const head = `**${name}** &nbsp; \`${info.value}\``;
  const kids = info.children ?? [];
  if (!kids.length) return head;
  const rows = kids.slice(0, 12).map((c) => {
    // A nested aggregate reports its type as the "value" (Shape → Shape); show
    // {…} instead of the redundant type name.
    const v = !c.value || c.value === c.type ? "{…}" : mdCell(c.value);
    return `| \`${c.name}\`${c.type ? " `" + c.type + "`" : ""} | ${v} |`;
  });
  const more = kids.length > 12 ? `\n\n_… ${kids.length - 12} more_` : "";
  return `${head}\n\n| | |\n|:--|:--|\n${rows.join("\n")}${more}`;
}

// The whole lvalue expression the cursor sits in: a base identifier plus its
// full chain of `[..]` / `.field` / `->field` accesses. Hover anywhere inside
// `shapes[i].name` or `list->next->val` and the entire thing is evaluated; the
// `1` in `shapes[1]` resolves to the element, not the literal; a bare number
// (no base identifier) yields nothing — no more useless `1 = 1`.
function exprAt(line: string, col: number): { expr: string; s: number; e: number } | null {
  const c = col - 1;                                   // Monaco columns are 1-based
  const re = /[A-Za-z_]\w*(?:\s*(?:\[[^\]]*\]|\.[A-Za-z_]\w*|->[A-Za-z_]\w*))*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const start = m.index, end = start + m[0].length;
    if (c < start || c > end) continue;
    const expr = m[0].replace(/\s+/g, "");
    return expr ? { expr, s: start, e: end } : null;
  }
  return null;
}

// Hover provider is registered once per language at module scope; the mounted
// SourceView routes it to the live session via this holder.
let hoverEval: ((expr: string) => Promise<HoverInfo | null>) | null = null;
for (const lang of ["cpp", "python", "milo"]) {
  monaco.languages.registerHoverProvider(lang, {
    provideHover: async (model, pos) => {
      if (!hoverEval) return null;
      const ex = exprAt(model.getLineContent(pos.lineNumber), pos.column);
      if (!ex) return null;
      const info = await hoverEval(ex.expr);
      if (info == null) return null;
      return {
        range: new monaco.Range(pos.lineNumber, ex.s + 1, pos.lineNumber, ex.e + 1),
        contents: [{ value: fmtHover(ex.expr, info) }],
      };
    },
  });
}

export function langFor(path: string): string {
  if (/\.py$/.test(path)) return "python";
  if (/\.milo$/.test(path)) return "milo";
  if (/\.(c|h|cc|cpp|hpp|cxx|hxx|m|mm)$/.test(path)) return "cpp";
  return "plaintext";
}

// per-breakpoint condition / hit count / logpoint message.
export type BpMeta = { condition?: string; hitCondition?: string; logMessage?: string; enabled?: boolean };

function glyphClass(m: BpMeta): string {
  if (m.enabled === false) return "bp-glyph-off";
  if (m.logMessage) return "bp-glyph-log";
  if (m.condition || m.hitCondition) return "bp-glyph-cond";
  return "bp-glyph";
}

// Normalize an address string for comparison — lldb pads pc wider than the
// per-instruction addr strings, so compare as BigInt.
function normAddr(a: string): string { try { return BigInt(a).toString(16); } catch { return a; } }

export default function SourceView({ text, lang, bps, stopLine, onToggle, onSetMeta, onHoverEval, caps, jump, onLineClick, asmByLine, asmPc }: {
  text: string; lang: string; bps: Map<number, BpMeta>; stopLine: number;
  onToggle: (ln: number) => void; onSetMeta: (ln: number, meta: BpMeta) => void;
  onHoverEval?: (expr: string) => Promise<HoverInfo | null>;
  caps: Record<string, any>;
  jump: { line: number; n: number };
  onLineClick?: (ln: number, word?: string) => void;   // content click: line + word under cursor (asm nav / addr follow)
  // Inline disassembly: source line → the instructions it compiled to. When set,
  // each line's asm is rendered in a Monaco view zone beneath it. asmPc bolds the
  // instruction at the current pc.
  asmByLine?: Map<number, { addr: string; text: string }[]>;
  asmPc?: string;
}) {
  // Only the source view that actually evaluates hovers owns the shared holder —
  // the asm/disasm views pass no onHoverEval and must NOT null it (doing so
  // silently killed variable hovers once a disasm view had mounted).
  useEffect(() => {
    if (!onHoverEval) return;
    hoverEval = onHoverEval;
    return () => { hoverEval = null; };
  }, [onHoverEval]);
  const elRef = useRef<HTMLDivElement | null>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const lineClickRef = useRef(onLineClick);
  lineClickRef.current = onLineClick;
  // Popover for the gutter right-click; null = closed.
  const [pop, setPop] = useState<{ line: number; x: number; y: number } | null>(null);
  const popRef = useRef(setPop);
  popRef.current = setPop;

  useEffect(() => {
    const ed = monaco.editor.create(elRef.current!, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      readOnly: true,
      domReadOnly: true,
      glyphMargin: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      folding: false,
      occurrencesHighlight: "off",
      renderLineHighlight: "none",
      contextmenu: false,
      automaticLayout: true,
    });
    const isGutter = (t: monaco.editor.MouseTargetType) =>
      t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
    ed.onMouseDown((e) => {
      if (e.event.rightButton) return; // right-click is the condition popover
      if (!e.target.position) return;
      if (isGutter(e.target.type)) toggleRef.current(e.target.position.lineNumber);
      else if (lineClickRef.current) {
        const w = ed.getModel()?.getWordAtPosition(e.target.position);
        lineClickRef.current(e.target.position.lineNumber, w?.word);
      }
    });
    // Right-click a gutter line → condition/logpoint popover. Fires even with
    // contextmenu:false (that option only suppresses Monaco's own menu).
    ed.onContextMenu((e) => {
      if (!isGutter(e.target.type) || !e.target.position) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      popRef.current({ line: e.target.position.lineNumber, x: e.event.posx, y: e.event.posy });
    });
    edRef.current = ed;
    decoRef.current = ed.createDecorationsCollection();
    return () => ed.dispose();
  }, []);

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    const model = ed.getModel()!;
    if (model.getValue() !== text) model.setValue(text);
    monaco.editor.setModelLanguage(model, lang);
  }, [text, lang]);

  useEffect(() => {
    if (jump.n > 0 && jump.line > 0) edRef.current?.revealLineInCenter(jump.line);
  }, [jump]);

  // Inline asm view zones: one zone under each source line that produced code.
  const zoneIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    ed.changeViewZones((acc) => {
      for (const id of zoneIdsRef.current) acc.removeZone(id);
      zoneIdsRef.current = [];
      if (!asmByLine || asmByLine.size === 0) return;
      const pcN = asmPc ? normAddr(asmPc) : "";
      for (const [line, insns] of asmByLine) {
        const dom = document.createElement("div");
        dom.className = "asm-zone";
        for (const ins of insns) {
          const row = document.createElement("div");
          row.className = "asm-zone-row" + (pcN && normAddr(ins.addr) === pcN ? " pc" : "");
          row.textContent = `${ins.addr}  ${ins.text}`;
          dom.appendChild(row);
        }
        zoneIdsRef.current.push(acc.addZone({ afterLineNumber: line, heightInLines: insns.length, domNode: dom }));
      }
    });
  }, [asmByLine, asmPc, text]);

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    bps.forEach((meta, ln) => decos.push({
      range: new monaco.Range(ln, 1, ln, 1),
      // stop line + breakpoint share one glyph cell; overlay a cutout arrow on
      // the dot instead of a second glyph that the opaque circle would hide.
      options: { glyphMarginClassName: glyphClass(meta) + (ln === stopLine ? " bp-at-stop" : ""), stickiness: 1 },
    }));
    if (stopLine > 0) {
      decos.push({
        range: new monaco.Range(stopLine, 1, stopLine, 1),
        options: { isWholeLine: true, className: "stop-line",
                   glyphMarginClassName: bps.has(stopLine) ? undefined : "stop-glyph" },
      });
      ed.revealLineInCenterIfOutsideViewport(stopLine);
    }
    decoRef.current?.set(decos);
  }, [bps, stopLine, text]);

  return (
    <div className="source-wrap">
      <div className="source" ref={elRef} />
      {pop && (
        <BpPopover
          line={pop.line} x={pop.x} y={pop.y}
          meta={bps.get(pop.line) ?? {}}
          exists={bps.has(pop.line)}
          caps={caps}
          onApply={(meta) => { onSetMeta(pop.line, meta); setPop(null); }}
          onRemove={() => { if (bps.has(pop.line)) onToggle(pop.line); setPop(null); }}
          onClose={() => setPop(null)}
        />
      )}
    </div>
  );
}

// Capabilities land with the first initialize response, so before the first
// run they're unknown ({}) — show every field then rather than none.
export function BpPopover({ line, x, y, meta, exists, caps, onApply, onRemove, onClose }: {
  line: number; x: number; y: number; meta: BpMeta; exists: boolean;
  caps: Record<string, any>;
  onApply: (m: BpMeta) => void; onRemove: () => void; onClose: () => void;
}) {
  const [cond, setCond] = useState(meta.condition ?? "");
  const [hit, setHit] = useState(meta.hitCondition ?? "");
  const [log, setLog] = useState(meta.logMessage ?? "");
  const capsKnown = Object.keys(caps).length > 0;
  const sup = (k: string) => !capsKnown || !!caps[k];
  const apply = () => {
    const m: BpMeta = {};
    if (cond.trim()) m.condition = cond.trim();
    if (hit.trim()) m.hitCondition = hit.trim();
    if (log.trim()) m.logMessage = log.trim();
    onApply(m);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
    else if (e.key === "Escape") onClose();
  };
  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y, window.innerHeight - 220);
  return (
    <>
      <div className="bp-pop-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="bp-pop" style={{ left, top }} onKeyDown={onKey}>
        <h3>breakpoint · line {line}</h3>
        {sup("supportsConditionalBreakpoints") && (
          <label>condition
            <input autoFocus value={cond} onChange={(e) => setCond(e.target.value)}
                   placeholder="e.g. i == 42" spellCheck={false} />
          </label>
        )}
        {sup("supportsHitConditionalBreakpoints") && (
          <label>hit count
            <input value={hit} onChange={(e) => setHit(e.target.value)}
                   placeholder="e.g. 5" spellCheck={false} />
          </label>
        )}
        {sup("supportsLogPoints") && (
          <label>log message <span className="bp-pop-note">(logs instead of stopping)</span>
            <input value={log} onChange={(e) => setLog(e.target.value)}
                   placeholder="e.g. x is {x}" spellCheck={false} />
          </label>
        )}
        <div className="bp-pop-btns">
          <button onClick={apply}>{exists ? "Update" : "Add"}</button>
          {exists && <button className="bp-pop-rm" onClick={onRemove}>Remove</button>}
        </div>
      </div>
    </>
  );
}
