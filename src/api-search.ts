// `milo api <query>` — signature search over the std library for humans and
// LLMs. Grep-backed (no compile): scans std/**/*.milo, extracts supported public
// functions and methods with their leading doc-comment, and ranks by a lexical
// score over the name, parameters, and doc text. Prints one signature per line,
// module-tagged, so the output is greppable and token-cheap.
//
// Upgrade path: back this with the parsed AST (exact generics / re-exports /
// visibility) once it earns its keep; the CLI surface stays identical.

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import { STDLIB_DIR, readStd, bundledStdPaths } from "./stdlibBundle";
import { must } from "./must";
import { writeStdout } from "./stdout";

interface Entry {
  kind: "function" | "type";
  module: string;    // "std/string"
  signature: string; // "fn strPadStart(s: &string, targetLen: i64, padStr: &string): string"
  doc: string;       // first line of the leading doc-comment, "" if none
  docFull: string;   // the whole leading doc-comment (all lines), "" if none
  name: string;      // "strPadStart" or "String.split"
  fields?: Field[];  // struct fields, for kind === "type"
  variants?: Variant[];  // enum variants, for kind === "type"
}

export interface Field { name: string; type: string; doc?: string }
export interface Variant { name: string; payload?: string; value?: string; doc?: string }

// One parameter of a function signature, split out so a consumer does not have to
// re-implement the top-level comma scan (`HashMap<string, i64>` and `(&T) => U` both
// carry commas that are not separators).
export interface Param { name: string; type: string }

const HOST_STD_SUFFIX = process.platform === "win32" ? "windows" : process.platform;

function platformStem(path: string): { base: string; platform: string } | null {
  const m = path.replace(/\\/g, "/").match(/^(.*)\.(darwin|linux|windows)\.milo$/);
  return m ? { base: m[1], platform: m[2] } : null;
}

function walkMilo(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) walkMilo(p, out);
    else if (ent.name.endsWith(".milo") && !ent.name.endsWith("_test.milo")) out.push(p);
  }
}

// A signature may span lines until its parentheses balance; a trailing return
// type runs to the opening brace or end of line. Returns the normalized
// one-line signature and the index of the last consumed line.
function readSignature(lines: string[], start: number): { sig: string; end: number } {
  let sig = lines[start].trim();
  let depth = 0;
  const balanced = (s: string) => {
    for (const c of s) { if (c === "(") depth++; else if (c === ")") depth--; }
    return depth <= 0;
  };
  let end = start;
  while (!balanced(sig) && end + 1 < lines.length) {
    end++;
    sig += " " + lines[end].trim();
  }
  const brace = sig.indexOf("{");
  if (brace >= 0) sig = sig.slice(0, brace);
  return { sig: sig.replace(/\s+/g, " ").trim(), end };
}

function fnName(sig: string): string {
  const m = sig.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : "";
}

// Collect the contiguous `//` doc-comment lines immediately above `idx`.
// A section-divider comment (── … ──) is a boundary, not doc — stop there.
function leadingDoc(lines: string[], idx: number): { first: string; full: string; internal: boolean } {
  let i = idx - 1;
  const buf: string[] = [];
  // Attributes sit BETWEEN the doc comment and the declaration (`@unsafe`, `@pure`,
  // `@wrapping` on their own lines), so walking straight up stops at the first one and
  // reports a documented function as undocumented.
  while (i >= 0 && lines[i].trim().startsWith("@")) i--;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t.startsWith("//") && !t.includes("──")) { buf.unshift(t.replace(/^\/\/\s?/, "")); i--; }
    else break;
  }
  const internal = buf.some(line => line.trim() === "@internal");
  const visible = buf.filter(line => line.trim() !== "@internal");
  return { first: visible.length ? visible[0] : "", full: visible.join("\n"), internal };
}

// Field list of a struct declaration starting at `idx`, read to the closing brace.
// Grep-backed like the rest of this module: good enough to answer "does this struct
// have that field", which is the question tooling asks.
function readFields(lines: string[], idx: number): Field[] {
  const out: Field[] = [];
  // `pub struct Hex {}` closes on its own line; scanning on would read the next struct
  // literal's `name: value` lines as this one's fields.
  if (/\{\s*\}/.test(lines[idx]!)) return out;
  let doc: string[] = [];
  for (let i = idx; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (i > idx && raw === "}") break;
    if (raw.startsWith("//")) { doc.push(raw.replace(/^\/\/\s?/, "")); continue; }
    // A trailing `// note` is not part of the type (`data: string, // decompressed`); it
    // documents the field when no comment block sits above it.
    const trailing = /\s\/\/\s?(.*)$/.exec(raw);
    const t = trailing ? raw.slice(0, trailing.index).trim() : raw;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?$/.exec(t);
    const note = doc.length ? doc.join("\n") : trailing?.[1]?.trim();
    if (m) out.push({ name: m[1]!, type: m[2]!.trim(), ...(note ? { doc: note } : {}) });
    doc = [];
  }
  return out;
}

// Variant list of an enum declaration starting at `idx`: `Name`, `Name(T, U)` or
// `Name = 8` (an enum with an explicit repr), each with the `//` comment block directly
// above it. Read to the first line that is only `}`; a line that is not a variant (a
// payload continued onto the next line) is skipped rather than guessed at.
function readVariants(lines: string[], idx: number): Variant[] {
  const out: Variant[] = [];
  let doc: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "}") break;
    if (t.startsWith("//")) { doc.push(t.replace(/^\/\/\s?/, "")); continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*(?:=\s*(-?[0-9A-Za-z_]+))?\s*,?\s*(?:\/\/.*)?$/.exec(t);
    if (m) {
      out.push({
        name: m[1]!, ...(m[2] !== undefined ? { payload: m[2].trim() } : {}),
        ...(m[3] !== undefined ? { value: m[3] } : {}), ...(doc.length ? { doc: doc.join("\n") } : {}),
      });
    }
    doc = [];
  }
  return out;
}

// Split a parameter list on TOP-LEVEL commas only.
export function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ("<([".includes(c)) depth++;
    else if (">)]".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out.map(p => p.trim()).filter(Boolean);
}

// Structured view of a signature: `fn f(a: i64, b: &string): bool` → params + return.
// A signature with no `: T` tail returns void, which is what the checker infers.
export function signatureParts(signature: string): { params: Param[]; returns: string } {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < 0) return { params: [], returns: "void" };
  const params = splitParams(signature.slice(open + 1, close)).map(p => {
    const colon = p.indexOf(":");
    // `self` may be written bare in a trait method.
    if (colon < 0) return { name: p.trim(), type: "" };
    return { name: p.slice(0, colon).trim(), type: p.slice(colon + 1).trim() };
  });
  const tail = signature.slice(close + 1).replace(/^\s*:\s*/, "").trim();
  return { params, returns: tail || "void" };
}

// `root` names an arbitrary project directory: the module is then its path relative
// to that root, and the source comes off disk. Without it this is the std path, where
// modules are "std/"-prefixed and readStd also serves the bundle embedded in a shipped
// binary (no std/ on disk to walk).
function parseModule(file: string, root?: string): Entry[] {
  const module = root !== undefined
    ? relative(root, file).replace(/\.milo$/, "").replace(/\\/g, "/")
    : "std/" + relative(resolve(STDLIB_DIR, "std"), file).replace(/\.milo$/, "").replace(/\\/g, "/");
  const src = root !== undefined ? readFileSync(file, "utf-8") : readStd(file);
  if (src === null) return [];
  const lines = src.split("\n");
  const entries: Entry[] = [];
  // Methods have no separate visibility modifier: methods on a public nominal
  // type are importable, while methods on a file-private type are not.
  const publicTypes = new Set<string>();
  for (const line of lines) {
    const m = line.trim().match(/^pub\s+(?:struct|enum|interface|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) publicTypes.add(m[1]);
  }
  // Track the enclosing `impl Type` so methods print as Type.method.
  const implStack: { type: string; depth: number }[] = [];
  let depth = 0;
  // `extern` declares C bindings (no body) — implementation detail, not API.
  let externMode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "extern") { externMode = true; continue; }
    const typeMatch = trimmed.match(/^pub\s+(struct|enum|interface|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (typeMatch) {
      const ld = leadingDoc(lines, i);
      if (!ld.internal) {
        const brace = trimmed.indexOf("{");
        const signature = (brace >= 0 ? trimmed.slice(0, brace) : trimmed).trim();
        const fields = typeMatch[1] === "struct" ? readFields(lines, i) : undefined;
        const variants = typeMatch[1] === "enum" && brace >= 0 ? readVariants(lines, i) : undefined;
        entries.push({
          kind: "type", module, signature, doc: ld.first, docFull: ld.full, name: typeMatch[2],
          ...(fields?.length ? { fields } : {}), ...(variants?.length ? { variants } : {}),
        });
      }
    }
    const implMatch = trimmed.match(/^impl\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (implMatch) implStack.push({ type: implMatch[1], depth });
    // Brace bookkeeping (approximate; good enough to scope impl blocks).
    // `depth` is recorded before the impl's own `{`, so the block closes when depth
    // returns to it — `<` would never fire and would leak the impl over later free fns.
    for (const c of line) { if (c === "{") depth++; else if (c === "}") { depth--; if (implStack.length && depth <= implStack[implStack.length - 1].depth) implStack.pop(); } }

    if (/^(pub\s+)?fn\s/.test(trimmed)) {
      const { sig, end } = readSignature(lines, i);
      const wasExtern = externMode;
      externMode = false; // an extern block declares one fn, then ends
      const bare = fnName(sig);
      if (!bare || bare.startsWith("_") || wasExtern) { i = end; continue; }
      const inImpl = implStack.length ? implStack[implStack.length - 1].type : "";
      const name = inImpl ? `${inImpl}.${bare}` : bare;
      // Make the receiver explicit: `fn bool(self: &Self, …)` → `Json.bool(self: &Json, …)`.
      const shown = inImpl
        ? sig.replace(/\bSelf\b/g, inImpl).replace(/^fn\s+/, `fn ${inImpl}.`)
        : sig;
      const ld = leadingDoc(lines, i);
      const supported = inImpl ? publicTypes.has(inImpl) : /^pub\s+fn\s/.test(sig);
      if (supported && !ld.internal) {
        entries.push({ kind: "function", module, signature: shown, doc: ld.first, docFull: ld.full, name });
      }
      i = end;
    } else if (trimmed.length > 0 && !trimmed.startsWith("//")) {
      externMode = false;
    }
  }
  return entries;
}

// Generated reference markdown, one document per module. Keyed by a filename
// stem ("runtime", "pty.darwin") so callers can write docs/std/<stem>.md. This
// is the source of truth for the rendered docs page — see scripts/gen-std-docs.
export function stdDocsByModule(): Map<string, string> {
  const byMod = new Map<string, Entry[]>();
  for (const e of loadAll(true)) {
    if (e.kind === "function") (byMod.get(e.module) ?? byMod.set(e.module, []).get(e.module)!).push(e);
  }
  const out = new Map<string, string>();
  for (const [module, entries] of byMod) {
    const stem = module.replace(/^std\//, "");
    out.set(stem, renderMarkdown(entries));
  }
  return out;
}

// Same rendering as the std reference, over any directory (or a single .milo file).
// Keyed by module path relative to `root`, so callers can write <out>/<module>.md.
function docsByModuleForPath(target: string): Map<string, string> {
  const isFile = statSync(target).isFile();
  const root = isFile ? dirname(resolve(target)) : resolve(target);
  const files: string[] = [];
  if (isFile) files.push(resolve(target));
  else walkMilo(root, files);

  const byMod = new Map<string, Entry[]>();
  for (const f of files) {
    for (const e of parseModule(f, root)) {
      if (e.kind === "function") (byMod.get(e.module) ?? byMod.set(e.module, []).get(e.module)!).push(e);
    }
  }
  const out = new Map<string, string>();
  for (const [module, entries] of byMod) out.set(module, renderMarkdown(entries));
  return out;
}

function loadAll(allPlatforms = false): Entry[] {
  const stdDir = resolve(STDLIB_DIR, "std");
  // Disk when present; otherwise enumerate the embedded bundle (shipped binary).
  const files: string[] = existsSync(stdDir) ? [] : bundledStdPaths();
  if (existsSync(stdDir)) walkMilo(stdDir, files);
  const all: Entry[] = [];
  for (const f of files) {
    const split = platformStem(f);
    if (!allPlatforms && split && split.platform !== HOST_STD_SUFFIX) continue;
    const entries = parseModule(f);
    if (!allPlatforms && split) {
      for (const entry of entries) entry.module = entry.module.replace(/\.(darwin|linux|windows)$/, "");
    }
    all.push(...entries);
  }
  return all;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Lexical relevance of one entry to the query tokens: strong weight on the
// function name, lighter weight on the doc text — so "local time" surfaces
// dateTimeFormatTime via its doc even though the name lacks "local".
function score(entry: Entry, qTokens: string[], qRaw: string): number {
  const nameLc = entry.name.toLowerCase();
  const docTokens = new Set(tokenize(entry.doc));
  const sigLc = entry.signature.toLowerCase();
  let s = 0;
  if (nameLc.includes(qRaw)) s += 10;              // whole query in the name
  for (const t of qTokens) {
    if (nameLc.includes(t)) s += 5;
    if (docTokens.has(t)) s += 2;
    else if (entry.doc.toLowerCase().includes(t)) s += 1;
    if (sigLc.includes(t)) s += 1;
  }
  return s;
}

function printEntries(entries: Entry[]): void {
  const pad = Math.min(24, entries.reduce((m, e) => Math.max(m, e.module.length), 0));
  for (const e of entries) {
    const mod = e.module.padEnd(pad);
    writeStdout(`${mod}  ${e.signature}\n`);
  }
}

// Render entries as reference markdown, grouped by module: one `##` per module,
// each API as a `###` signature code line followed by its full doc-comment. This
// makes the doc-comments in std the single source of truth for the .md docs.
function renderMarkdown(entries: Entry[]): string {
  const byModule = new Map<string, Entry[]>();
  for (const e of entries) (byModule.get(e.module) ?? byModule.set(e.module, []).get(e.module)!).push(e);
  const out: string[] = [];
  for (const module of [...byModule.keys()].sort()) {
    out.push(`## ${module}\n`);
    const es = must(byModule, module, "by module").sort((a, b) => a.name.localeCompare(b.name));
    for (const e of es) {
      out.push(`### \`${e.name}\`\n`);
      out.push("```milo\n" + e.signature + "\n```\n");
      out.push(e.docFull ? e.docFull + "\n" : "_Undocumented._\n");
    }
  }
  return out.join("\n");
}

// `milo doc <path> [-o <dir>]` — reference markdown for a file or directory.
// Without -o it prints to stdout, so `milo doc foo.milo | less` works and the
// common case needs no output directory.
export function runMiloDoc(args: string[]): number {
  const oIdx = args.findIndex(a => a === "-o" || a === "--out");
  const outDir = oIdx >= 0 ? args[oIdx + 1] : undefined;
  // Guard on oIdx >= 0: with no -o, oIdx is -1 and `i !== oIdx + 1` would drop argv[0] —
  // the target itself.
  const positional = args.filter((a, i) => (oIdx < 0 || (i !== oIdx && i !== oIdx + 1)) && !a.startsWith("-"));
  const target = positional[0];
  if (!target) {
    process.stderr.write("usage: milo doc <file.milo|dir> [-o <outdir>]\n");
    return 1;
  }
  if (!existsSync(target)) {
    process.stderr.write(`milo doc: no such file or directory: ${target}\n`);
    return 1;
  }
  if (oIdx >= 0 && !outDir) {
    process.stderr.write("milo doc: -o needs a directory\n");
    return 1;
  }

  const docs = docsByModuleForPath(target);
  if (docs.size === 0) {
    process.stderr.write(`milo doc: no .milo sources found under ${target}\n`);
    return 1;
  }
  if (!outDir) {
    writeStdout([...docs.keys()].sort().map(k => must(docs, k, "docs")).join("\n"));
    return 0;
  }
  for (const [module, md] of docs) {
    const path = join(outDir, `${module}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, md);
  }
  process.stderr.write(`milo doc: wrote ${docs.size} file(s) to ${outDir}/\n`);
  return 0;
}

// Machine-readable projection of the same entries `milo api` prints. This is a PUBLIC
// surface: editors, package tooling, doc generators and agents consume it instead of
// importing the compiler's TypeScript, which only code inside this repo can do. Bump
// `schema` on a breaking change; tests/apiJson.test.ts pins the shape.
export const API_JSON_SCHEMA = 1;

function apiJson(entries: Entry[]): string {
  const out = {
    schema: API_JSON_SCHEMA,
    entries: [...entries]
      .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name))
      .map(e => {
        const { params, returns } = e.kind === "function"
          ? signatureParts(e.signature)
          : { params: [], returns: "" };
        return {
          kind: e.kind,
          module: e.module,
          name: e.name,
          signature: e.signature,
          // Split out so a consumer never re-implements the top-level comma scan.
          ...(e.kind === "function" ? { params, returns } : {}),
          ...(e.fields ? { fields: e.fields } : {}),
          ...(e.variants ? { variants: e.variants } : {}),
          doc: e.doc,
          docFull: e.docFull,
        };
      }),
  };
  return JSON.stringify(out, null, 2) + "\n";
}

export function runApiSearch(args: string[]): number {
  const markdown = args.includes("--markdown");
  const json = args.includes("--json");
  const moduleFlag = args.find(a => a.startsWith("--module="))?.slice("--module=".length)
    ?? (args.includes("--module") ? args[args.indexOf("--module") + 1] : undefined);
  const positional = args.filter(a => a !== "--module" && !a.startsWith("--") && a !== moduleFlag);
  const query = positional.join(" ").trim();

  const all = loadAll();
  if (all.length === 0) {
    console.error(`milo api: no std library found under ${resolve(STDLIB_DIR, "std")} (set MILO_ROOT?)`);
    return 1;
  }

  if (moduleFlag) {
    const want = moduleFlag.replace(/^std\//, "");
    const inMod = all.filter(e => e.module === `std/${want}` || e.module === moduleFlag);
    if (inMod.length === 0) { console.error(`milo api: no module '${moduleFlag}'`); return 1; }
    inMod.sort((a, b) => a.name.localeCompare(b.name));
    if (json) { writeStdout(apiJson(inMod)); return 0; }
    if (markdown) { writeStdout(renderMarkdown(inMod)); return 0; }
    printEntries(inMod);
    return 0;
  }

  // `--markdown` / `--json` with no module or query → the whole std surface. That is the
  // form a doc generator or an out-of-repo tool wants; the query form is for humans.
  if (json && !query) { writeStdout(apiJson(loadAll(true))); return 0; }
  if (markdown && !query) { writeStdout(renderMarkdown(all)); return 0; }

  if (!query) {
    console.error("usage: milo api <search terms>   |   milo api --module std/<name>");
    return 1;
  }

  const qTokens = tokenize(query);
  const qRaw = query.toLowerCase();
  const ranked = all
    .map(e => ({ e, s: score(e, qTokens, qRaw) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, 30)
    .map(x => x.e);

  if (ranked.length === 0) {
    console.error(`milo api: no matches for '${query}'`);
    return 1;
  }
  if (json) { writeStdout(apiJson(ranked)); return 0; }
  printEntries(ranked);
  return 0;
}
