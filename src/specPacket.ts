// Clean-room packet (`milo spec --packet <outdir> <entry>`): the interface a test author may
// see (requirements, declarations, signatures, contracts) and nothing about how the code works.
// Works on the token stream, not the AST: the AST keeps no end positions, and the packet must
// reproduce declarations verbatim.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { moduleDir } from "./requirements";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { fsSource, layout } from "./specLock";

// `todo` is the one call the checker treats as ending a non-void fn, and it aborts when run.
const STUB = `{\n    todo("clean-room stub")\n}`;
// Marks a line that held only a comment, so it can be dropped without shifting token positions.
const GONE = "\u0000";
const DECL_KW = new Set(["import", "struct", "enum", "fn", "impl", "trait", "type", "interface", "let", "var", "extern", "unsafe"]);
const CONTRACT_KW = new Set(["requires", "ensures", "decreases", "invariant"]);

const PACKET_MD = `# Clean-room packet
Requirements are in requirements.json. The .milo files are interface stubs: signatures and contracts only.
Write tests as \`test*\` fns in \`*_test.milo\` files, each marked \`@req(ID)\`, importing modules at the same paths.
Test against the requirement text and the contracts, never against a guess of the implementation.
Do not read anything outside this directory.
Stub bodies panic, so the tests cannot be run here; type-check them with \`milo check\`.
`;

interface Chunk { s: number; e: number; head: number; pub: boolean; kw: string }
interface Fn { name: string; s: number; body: number; keep: boolean }

/** The stub source for one file: pub fns and methods keep header and contracts, bodies become a panic. */
export function stubSource(text: string, file: string): string {
  const toks = new Lexer(text).tokenize();
  new Parser(toks, text, file).parse(); // a file that does not parse has no packet

  // Cut comments from line ends so every token keeps its (line, col) in `src`.
  const lines = text.split("\n");
  for (const t of toks) for (const c of [...(t.leadingTrivia ?? []), ...(t.trailingTrivia ?? [])]) {
    if (c.kind !== "comment") continue;
    const l = lines[c.line - 1]!;
    const cr = l.endsWith("\r") ? "\r" : "";
    const body = cr ? l.slice(0, -1) : l;
    if (!body.endsWith(c.text)) continue;
    const kept = body.slice(0, body.length - c.text.length);
    lines[c.line - 1] = kept.trim() === "" ? GONE : kept + cr;
  }
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const src = lines.join("\n");
  const at = (i: number) => starts[toks[i]!.line - 1]! + toks[i]!.col - 1;
  const slice = (a: number, b: number) =>
    src.slice(at(a), at(b)).split("\n").map(l => l.replace(/\s+$/, "")).filter(l => l !== GONE && l !== "").join("\n");

  const n = toks.length - 1; // index of Eof
  const kind = (i: number) => toks[Math.min(i, n)]!.kind as string;
  const val = (i: number) => toks[Math.min(i, n)]!.value;
  const depth: number[] = [];
  const match = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i <= n; i++) {
    depth.push(stack.length);
    const k = kind(i);
    if (k === "(" || k === "[" || k === "{") stack.push(i);
    else if (k === ")" || k === "]" || k === "}") { const o = stack.pop(); if (o !== undefined) match.set(o, i); }
  }
  const firstOnLine = (i: number) => i === 0 || toks[i - 1]!.line !== toks[i]!.line;
  const isInner = (i: number) => kind(i) === "@" && kind(i + 1) === "!" && toks[i + 1]!.line === toks[i]!.line && toks[i + 1]!.col === toks[i]!.col + 1;
  /** Index after the run of attributes starting at i. */
  const skipAttrs = (i: number) => {
    while (kind(i) === "@") {
      i += isInner(i) ? 3 : 2;
      if (kind(i) === "(") i = match.get(i)! + 1;
    }
    return i;
  };
  const isPubKw = (i: number) => kind(i) === "IDENT" && val(i) === "pub";
  const startsDecl = (k: number) => {
    if (depth[k] !== 0 || !firstOnLine(k)) return false;
    if (kind(k) === "@") return !CONTRACT_KW.has(val(skipAttrs(k)));
    if (kind(k) === "IDENT") {
      if (val(k) === "pub") return DECL_KW.has(kind(k + 1)) || kind(k + 1) === "IDENT";
      if (val(k) === "derive") return kind(k + 1) === "IDENT" && kind(k + 2) === "{";
      return val(k) === "thread_local" || (val(k) === "from" && kind(k + 1) === "STRING");
    }
    return DECL_KW.has(kind(k)) || (val(k) === "from" && kind(k + 1) === "STRING");
  };

  // Split the file into declarations: each starts at a depth-0 token that begins a line.
  const chunks: Chunk[] = [];
  for (let k = 0; k < n;) {
    if (!startsDecl(k)) { k++; continue; }
    if (isInner(k)) { const j = skipAttrs(k); chunks.push({ s: k, e: j, head: k, pub: false, kw: "directive" }); k = j; continue; }
    let head = skipAttrs(k);
    const pub = isPubKw(head);
    if (pub) head++;
    let j = head + 1;
    while (j < n && !startsDecl(j)) j++;
    chunks.push({ s: k, e: j, head, pub, kw: kind(head) === "IDENT" ? val(head) : kind(head) });
    k = j;
  }

  /** Index of the `{` that opens the body of the fn whose `fn` keyword is at fnIdx. */
  const bodyOf = (fnIdx: number) => {
    let b = fnIdx + 1;
    while (b < n && !(kind(b) === "{" && depth[b] === depth[fnIdx])) b++;
    return b;
  };
  /** The fn's header and contracts as written (re-indented to `indent`), then the stub body. */
  const stubFn = (s: number, bodyIdx: number, indent = "") => {
    const strip = " ".repeat(toks[s]!.col - 1);
    const header = slice(s, bodyIdx).split("\n").map((l, i) => (i > 0 && l.startsWith(strip) ? l.slice(strip.length) : l));
    const [open, ...rest] = STUB.split("\n");
    const all = firstOnLine(bodyIdx) ? [...header, open!, ...rest] : [...header.slice(0, -1), header[header.length - 1] + " " + open, ...rest];
    return all.map(l => indent + l).join("\n");
  };
  const identsIn = (a: number, b: number, into: Set<string>) => { for (let i = a; i < b; i++) if (kind(i) === "IDENT") into.add(val(i)); };

  const pubTypes = new Set<string>();
  for (const c of chunks) if ((c.kw === "struct" || c.kw === "enum") && c.pub) pubTypes.add(val(c.head + 1));

  // Everything a kept contract or declaration mentions; private fns in it must stay to type-check.
  const need = new Set<string>();
  const fns: Fn[] = [];
  const impls: { c: Chunk; open: number; methods: Fn[]; keepAll: boolean }[] = [];
  const verbatim: Chunk[] = [];
  // A private global's initializer is implementation: it stays only if something kept names it.
  const privateGlobals: { c: Chunk; name: string; keep: boolean }[] = [];
  for (const c of chunks) {
    if (c.kw === "fn") {
      const body = bodyOf(c.head);
      if (val(c.head + 1) === "main" || kind(body) !== "{") continue;
      fns.push({ name: val(c.head + 1), s: c.s, body, keep: c.pub });
      if (c.pub) identsIn(c.s, body, need);
    } else if (c.kw === "impl" || (c.kw === "unsafe" && kind(c.head + 1) === "impl")) {
      let open = c.head;
      while (kind(open) !== "{") open++;
      let forIdx = -1;
      for (let i = c.head; i < open; i++) if (kind(i) === "for") forIdx = i;
      const typeName = val(forIdx >= 0 ? forIdx + 1 : c.head + (kind(c.head) === "unsafe" ? 2 : 1));
      // Inherent methods of a private type are private; a trait impl is interface.
      const keepAll = forIdx >= 0 || pubTypes.has(typeName);
      const methods: Fn[] = [];
      for (let k = open + 1; k < match.get(open)!;) {
        const fnIdx = skipAttrs(k);
        const body = bodyOf(fnIdx);
        methods.push({ name: val(fnIdx + 1), s: k, body, keep: keepAll });
        if (keepAll) identsIn(k, body, need);
        k = match.get(body)! + 1;
      }
      impls.push({ c, open, methods, keepAll });
    } else if (c.kw === "derive") {
      continue; // a derive template is code, not interface
    } else if (!c.pub && (c.kw === "let" || c.kw === "var" || c.kw === "thread_local")) {
      privateGlobals.push({ c, name: val(c.head + (c.kw === "thread_local" ? 2 : 1)), keep: false });
    } else {
      verbatim.push(c);
      if (c.kw === "trait" || c.kw === "interface") {
        // A default body is stubbed, so what it calls is not interface.
        let open = c.head;
        while (kind(open) !== "{") open++;
        for (let k = c.s; k < c.e; k++) {
          if (kind(k) === "{" && depth[k] === depth[open]! + 1) { k = match.get(k)!; continue; }
          if (kind(k) === "IDENT") need.add(val(k));
        }
      } else identsIn(c.s, c.e, need);
    }
  }
  const candidates = [...fns, ...impls.flatMap(i => i.keepAll ? [] : i.methods)];
  for (let changed = true; changed;) {
    changed = false;
    for (const f of candidates) {
      if (f.keep || !need.has(f.name)) continue;
      f.keep = true; changed = true;
      identsIn(f.s, f.body, need);
    }
    for (const g of privateGlobals) {
      if (g.keep || !need.has(g.name)) continue;
      g.keep = true; changed = true;
      identsIn(g.c.s, g.c.e, need);
    }
  }

  /** A trait's text with each default method body replaced: a default is code, not interface. */
  const stubDefaults = (c: Chunk) => {
    let open = c.head;
    while (kind(open) !== "{") open++;
    const close = match.get(open)!;
    let text = "", pos = c.s;
    for (let k = open + 1; k < close; k++) {
      if (kind(k) !== "{" || depth[k] !== depth[open]! + 1) continue;
      const indent = " ".repeat(toks[k]!.col > 1 ? 4 : 0);
      text += slice(pos, k).trimEnd() + " " + STUB.split("\n").join("\n" + indent) + "\n";
      pos = match.get(k)! + 1;
      text += " ".repeat(toks[pos]!.col - 1);
      k = pos - 1;
    }
    return text + slice(pos, c.e);
  };

  const out: { at: number; text: string }[] = [];
  for (const c of verbatim) out.push({ at: c.s, text: c.kw === "trait" || c.kw === "interface" ? stubDefaults(c) : slice(c.s, c.e) });
  for (const g of privateGlobals) if (g.keep) out.push({ at: g.c.s, text: slice(g.c.s, g.c.e) });
  for (const f of fns) if (f.keep) out.push({ at: f.s, text: stubFn(f.s, f.body) });
  for (const im of impls) {
    const ms = im.methods.filter(m => m.keep);
    if (!ms.length) continue;
    const body = ms.map(m => stubFn(m.s, m.body, "    "));
    out.push({ at: im.c.s, text: `${slice(im.c.s, im.open)} {\n${body.join("\n\n")}\n}` });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(o => o.text).join("\n\n") + "\n";
}

export interface PacketResult { outdir: string; files: string[] }

export function writePacket(entry: string, outdir: string): PacketResult {
  if (existsSync(outdir) && readdirSync(outdir).length > 0) throw new Error(`${outdir} exists and is not empty; refusing to overwrite`);
  const { projectDir, requirementsRel } = layout(entry);
  const src = fsSource(projectDir);
  const files: Record<string, string> = {};
  // A single-file module (std/json.milo) keeps its project in a sibling directory (std/json/), so the
  // module file itself lies outside it: root the packet at the parent and put the module beside the directory.
  const moduleStyle = moduleDir(entry) !== null;
  const prefix = moduleStyle ? basename(projectDir) + "/" : "";
  const stub = (rel: string, text: string) => {
    try { return stubSource(text, rel); } catch (e) { throw new Error(`${rel}: cannot build a stub: ${(e as Error).message}`); }
  };
  for (const rel of src.milo()) {
    if (!rel.endsWith("_test.milo")) files[prefix + rel] = stub(rel, src.read(rel)!);
  }
  if (moduleStyle && !entry.endsWith("_test.milo")) files[basename(entry)] = stub(entry, readFileSync(entry, "utf-8"));
  if (requirementsRel) {
    const raw = src.read(requirementsRel);
    if (raw) {
      const keep = ["id", "text", "parent", "kind", "derived"];
      const reqs = (JSON.parse(raw).requirements ?? []).map((r: any) => Object.fromEntries(keep.filter(k => r[k] !== undefined).map(k => [k, r[k]])));
      files[prefix + requirementsRel] = JSON.stringify({ requirements: reqs }, null, 2) + "\n";
    }
  }
  files["PACKET.md"] = PACKET_MD;
  mkdirSync(outdir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(outdir, rel)), { recursive: true });
    writeFileSync(join(outdir, rel), body);
  }
  return { outdir, files: Object.keys(files) };
}
