// `milo api <query>` — signature search over the std library for humans and
// LLMs. Grep-backed (no compile): scans std/**/*.milo, extracts every function
// and method signature with its leading doc-comment, and ranks by a lexical
// score over the name, parameters, and doc text. Prints one signature per line,
// module-tagged, so the output is greppable and token-cheap.
//
// Upgrade path: back this with the parsed AST (exact generics / re-exports /
// visibility) once it earns its keep; the CLI surface stays identical.

import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname, relative } from "path";

const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Entry {
  module: string;    // "std/string"
  signature: string; // "fn strPadStart(s: &string, targetLen: i64, padStr: &string): string"
  doc: string;       // first line of the leading doc-comment, "" if none
  name: string;      // "strPadStart" or "String.split"
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
function leadingDoc(lines: string[], idx: number): string {
  let i = idx - 1;
  const buf: string[] = [];
  while (i >= 0) {
    const t = lines[i].trim();
    if (t.startsWith("//")) { buf.unshift(t.replace(/^\/\/\s?/, "")); i--; }
    else break;
  }
  return buf.length ? buf[0] : "";
}

function parseModule(file: string): Entry[] {
  const module = "std/" + relative(resolve(STDLIB_DIR, "std"), file).replace(/\.milo$/, "").replace(/\\/g, "/");
  const src = readFileSync(file, "utf-8");
  const lines = src.split("\n");
  const entries: Entry[] = [];
  // Track the enclosing `impl Type` so methods print as Type.method.
  const implStack: { type: string; depth: number }[] = [];
  let depth = 0;
  // `extern` declares C bindings (no body) — implementation detail, not API.
  let externMode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "extern") { externMode = true; continue; }
    const implMatch = trimmed.match(/^impl\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (implMatch) implStack.push({ type: implMatch[1], depth });
    // Brace bookkeeping (approximate; good enough to scope impl blocks).
    for (const c of line) { if (c === "{") depth++; else if (c === "}") { depth--; if (implStack.length && depth < implStack[implStack.length - 1].depth) implStack.pop(); } }

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
      entries.push({ module, signature: shown, doc: leadingDoc(lines, i), name });
      i = end;
    } else if (trimmed.length > 0 && !trimmed.startsWith("//")) {
      externMode = false;
    }
  }
  return entries;
}

function loadAll(): Entry[] {
  const stdDir = resolve(STDLIB_DIR, "std");
  if (!existsSync(stdDir)) return [];
  const files: string[] = [];
  walkMilo(stdDir, files);
  const all: Entry[] = [];
  for (const f of files) all.push(...parseModule(f));
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
    process.stdout.write(`${mod}  ${e.signature}\n`);
  }
}

export function runApiSearch(args: string[]): number {
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
    printEntries(inMod);
    return 0;
  }

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
  printEntries(ranked);
  return 0;
}
