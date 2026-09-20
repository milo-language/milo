// Checks the signature listings on the docs-site stdlib pages against the real std API.
//
// Run:  bun run scripts/check-api-docs.ts            # report every mismatch
//       bun run scripts/check-api-docs.ts --check    # exit 1 if any page off the ratchet fails
//
// docs/std/*.md is generated from doc-comments and cannot drift. docs/site/stdlib/*.md is
// hand-written prose with hand-typed signatures, and it had drifted badly: the argparse
// page documented a free-function API (`addString(parser, ...)`) where the real one is
// methods on `ArgParser`; the process page documented `Process.spawn(command)` against a
// real `Child.spawn(program, args, mergeStderr)`; the json page documented
// `struct Json { raw, start, end }` against a real six-field parse tree. Those pages are
// the front door for a new user, and nothing compared a line of them to the compiler.
//
// Only SIGNATURE LISTINGS are checked — a fence whose lines are all bodyless `fn`
// declarations, and `struct` listings. Example programs in the same page are prose and
// tests/docs.test.ts owns whether they compile.
import { readFileSync, readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "docs", "site", "stdlib");

// Read the compiler through its published JSON surface, not by importing its TypeScript.
// This tool answers "does the documentation match the language", which is a question any
// package's docs should be able to ask — and an importer can only ever be a file inside
// this repo, written in this repo's host language. `milo api --json` and
// `milo lang --json` are the seam: the day the compiler is rewritten in Rust or in Milo,
// this keeps working unchanged.
// Memoized: check() runs checkOne once per page, and spawning the compiler per page made
// the gate 50x slower than the work it does.
const cache = new Map<string, any>();
function milo(args: string[]): any {
  const key = args.join(" ");
  const hit = cache.get(key);
  if (hit) return hit;
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,   // the full std dump is ~800 KB
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  cache.set(key, parsed);
  return parsed;
}

// Pages whose listings do not match the API yet, measured 2026-08-15. A RATCHET: a page
// may only be REMOVED. Rewriting a page's signatures is prose work — the headings, the
// ordering and the explanations are editorial — so this records the debt instead of
// pretending it is not there, and stops it growing.
// Empty, and it should stay that way: every listing on every page matched once the
// wrong ones were corrected, so there is no debt to record. A page that fails belongs
// fixed, not listed.
export const NOT_YET_MATCHING = new Set<string>([]);

interface Entry { name: string; signature: string }

function apiByModule(): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  const add = (mod: string, e: Entry) => out.set(mod, [...(out.get(mod) ?? []), e]);
  for (const e of milo(["api", "--json"]).entries) {
    if (e.kind !== "function") continue;
    // Platform arms (regex.darwin, cryptosys.linux) are one importable module behind one
    // name; the site documents `std/regex`, so the arms fold together here.
    const base = e.module.replace(/^std\//, "").split(".")[0]!;
    add(base, { name: e.name, signature: e.signature });
  }
  // The string page documents methods the CHECKER dispatches, not functions in
  // std/string.milo — without this the whole page reads as "no such function" and the
  // one real bug in it (indexOf returns Option<i64>, the page said i64) stays buried.
  const lang = milo(["lang", "--json"]);
  for (const [receiver, members] of Object.entries(lang.builtinMembers) as [string, any[]][]) {
    for (const m of members) {
      const sig = m.signature.startsWith("(")
        ? `fn ${m.name}(self: &${receiver}, ${m.signature.slice(1)}`
        : `fn ${m.name}(self: &${receiver})${m.signature}`;
      add(receiver, { name: m.name, signature: sig.replace(", )", ")") });
    }
  }
  return out;
}

// Struct field lists come from the same payload: `milo api --json` carries a type
// entry's fields, so this tool never reads std/*.milo. The json page published
// `struct Json { raw, start, end }` against a real six-field parse tree — a listing is as
// much a claim as a signature is, and it was the one nothing looked at.
function structsByModule(): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const e of milo(["api", "--json"]).entries) {
    if (e.kind !== "type" || !e.fields) continue;
    const mod = e.module.replace(/^std\//, "").split(".")[0]!;
    const structs = out.get(mod) ?? new Map<string, string[]>();
    structs.set(e.name, e.fields.map((f: any) => f.name));
    out.set(mod, structs);
  }
  return out;
}

// Compare SHAPES, not spelling. Parameter names, `pub`, the `Type.` qualifier and an
// omitted `: void` are all things the two texts legitimately write differently; what a
// reader is misled by is a wrong arity, a wrong type, or a function that does not exist.
function normalize(sig: string): string {
  let s = sig
    .replace(/\s+\/\/.*$/, "")                                    // trailing explanatory comment
    .replace(/^pub\s+/, "")
    .replace(/\bfn\s+[A-Za-z_][A-Za-z0-9_]*\./, "fn ")            // drop the Type. qualifier
    .replace(/:\s*void\b/g, ": Unit")                             // `Result<void>` is not a type
    .replace(/&mut\s+/g, "").replace(/&/g, "")                    // borrow spelling is prose here
    .replace(/\b([A-Za-z0-9_<>]+)\?/g, "Option<$1>");             // `string?` is `Option<string>`
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open < 0 || close < 0) return s.replace(/\s+/g, "");
  const params = splitParams(s.slice(open + 1, close)).map(p => {
    const colon = p.indexOf(":");
    // `self` may be written bare on the site and typed by the generator.
    if (/^\s*self\b/.test(p)) return "self";
    return colon < 0 ? p.trim() : p.slice(colon + 1).trim();
  });
  const ret = s.slice(close + 1).replace(/^\s*:\s*/, "").trim();
  return `fn(${params.join(",")}):${ret || "Unit"}`.replace(/\s+/g, "");
}

// Split on top-level commas only — `HashMap<string, i64>` and `(&Request) => Response`
// both carry commas that are not parameter separators. (The compiler does this too, in
// its JSON payload; the doc side is raw markdown, so it still needs the scan here.)
function splitParams(text: string): string[] {
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
  return out.filter(p => p.trim());
}

const baseName = (n: string) => n.split(".").pop()!;

interface Problem { module: string; line: number; detail: string }

export function check(): Problem[] {
  comparedCount = 0;
  const problems: Problem[] = [];
  for (const file of readdirSync(SITE).sort()) {
    if (!file.endsWith(".md") || file === "index.md") continue;
    const mod = file.replace(/\.md$/, "");
    problems.push(...checkOne(mod, readFileSync(join(SITE, file), "utf-8")));
  }
  return problems;
}

// Exported so a test can feed it a page it wrote: a scan that silently matched nothing
// would report every page clean, which is the failure mode this whole file exists for.
export function checkOne(mod: string, pageText: string): Problem[] {
  const api = apiByModule();
  const allStructs = structsByModule();
  const problems: Problem[] = [];

  // A page may cover more than the module it is named after: std/net's page documents
  // the fetch client too, because std/fetch has no page of its own. Declare that with
  // `<!-- api: std/net, std/fetch -->` rather than letting the extra names read as
  // "documents an API that does not exist".
  const declared = /<!--\s*api:\s*([^>]+?)\s*-->/.exec(pageText)?.[1]
    ?.split(",").map(m => m.trim().replace(/^std\//, "")) ?? [mod];
  const entries = declared.flatMap(m => api.get(m) ?? []);
  if (!entries.length) {
    return [{ module: mod, line: 1, detail: `no std module named '${mod}' — the page documents nothing` }];
  }
  const structs = new Map<string, string[]>();
  for (const m of declared) for (const [k, v] of allStructs.get(m) ?? []) structs.set(k, v);

  const byBase = new Map<string, Entry[]>();
  const byName = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = baseName(e.name);
    byBase.set(k, [...(byBase.get(k) ?? []), e]);
    byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  }

  const lines = pageText.split("\n");
  let fence: { start: number; lines: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!fence && /^```milo\s*$/.test(line)) { fence = { start: i + 1, lines: [] }; continue; }
    if (fence && line.startsWith("```")) { checkFence(mod, fence, byBase, byName, structs, problems); fence = null; continue; }
    if (fence) fence.lines.push(line);
  }
  return problems;
}

// How many documented declarations this run actually compared against the compiler.
// The gate's whole output is "problems found", and zero problems is indistinguishable
// between "the docs are correct" and "the fence detector stopped matching and nothing was
// read". NOT_YET_MATCHING used to double as a canary — a broken parser made every
// ratcheted page look fixed — but that list is empty now, so the count is the only signal
// left that this gate is still doing anything.
export let comparedCount = 0;
// Floor, not an exact count, so adding or removing a page does not need a code edit.
// Set well under today's number and well over zero: the failure this catches is the
// fence detector matching nothing at all, not a page-sized drift. Shared with
// tests/apiDocsSite.test.ts so the bun gate and the CLI gate cannot disagree.
export const COMPARED_FLOOR = 200;

function checkFence(mod: string, fence: { start: number; lines: string[] }, byBase: Map<string, Entry[]>, byName: Map<string, Entry[]>, structs: Map<string, string[]>, problems: Problem[]): void {
  checkStructListing(mod, fence, structs, problems);
  const body = fence.lines.filter(l => l.trim() && !l.trim().startsWith("//"));
  if (!body.length) return;
  // A listing declares; a program defines. One `{` and this is example code.
  const isListing = body.every(l => /^(pub )?fn [A-Za-z_]/.test(l.trim()) && !l.includes("{"));
  if (!isListing) return;

  for (const raw of body) {
    const decl = raw.trim();
    const name = /^(?:pub )?fn ([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(decl)?.[1];
    if (!name) continue;
    // A page that writes `fn Url.parse` means that receiver's method; only an unqualified
    // name may match on the base, or `Channel.new` gets compared against every `.new` in
    // the module and passes on the first coincidence.
    const candidates = name.includes(".")
      ? byName.get(name) ?? byBase.get(baseName(name))
      : byBase.get(baseName(name));
    comparedCount++;
    if (!candidates) {
      problems.push({ module: mod, line: fence.start + fence.lines.indexOf(raw) + 1, detail: `documents \`${decl}\` — std/${mod} has no such function` });
      continue;
    }
    if (!candidates.some(c => normalize(c.signature) === normalize(decl))) {
      problems.push({
        module: mod,
        line: fence.start + fence.lines.indexOf(raw) + 1,
        detail: `documents \`${decl}\`\n      real: ${candidates.map(c => c.signature).join("\n            ")}`,
      });
    }
  }
}

function checkStructListing(mod: string, fence: { start: number; lines: string[] }, structs: Map<string, string[]>, problems: Problem[]): void {
  const text = fence.lines.join("\n");
  const m = /^(?:pub )?struct ([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?\s*\{([\s\S]*?)\}/m.exec(text);
  if (!m) return;
  const name = m[1]!;
  const real = structs.get(name);
  // A page may illustrate a struct the user writes ("struct Config { ... }" in an
  // example); only a name std actually defines is a claim about std.
  if (!real) return;
  const documented = m[2]!.split("\n")
    .map(l => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(l)?.[1])
    .filter((f): f is string => !!f);
  if (!documented.length) return;
  const missing = documented.filter(f => !real.includes(f));
  if (missing.length) {
    problems.push({
      module: mod,
      line: fence.start + 1,
      detail: `documents \`struct ${name}\` with field(s) it does not have: ${missing.join(", ")}\n      real: ${real.join(", ")}`,
    });
  }
}

if (import.meta.main) {
  const problems = check();
  const failing = new Set(problems.map(p => p.module));
  for (const p of problems) {
    if (process.argv.includes("--check") && NOT_YET_MATCHING.has(p.module)) continue;
    console.log(`docs/site/stdlib/${p.module}.md:${p.line}: ${p.detail}`);
  }
  const offRatchet = [...failing].filter(m => !NOT_YET_MATCHING.has(m));
  const fixed = [...NOT_YET_MATCHING].filter(m => !failing.has(m) && existsSync(join(SITE, `${m}.md`)));
  console.log(`\n${comparedCount} documented signatures compared; ${problems.length} mismatched across ${failing.size} pages (${NOT_YET_MATCHING.size} on the ratchet)`);
  if (process.argv.includes("--check")) {
    if (comparedCount < COMPARED_FLOOR) {
      console.error(`doc gate compared only ${comparedCount} signatures (floor ${COMPARED_FLOOR}) — the fence detector is probably not matching any more; a green run here would mean nothing`);
      process.exit(1);
    }
    if (offRatchet.length) { console.error(`pages failing that are not on the ratchet: ${offRatchet.join(", ")}`); process.exit(1); }
    if (fixed.length) { console.error(`these pages now match — remove them from NOT_YET_MATCHING: ${fixed.join(", ")}`); process.exit(1); }
    console.log("no page off the ratchet documents an API that does not exist");
  }
}
