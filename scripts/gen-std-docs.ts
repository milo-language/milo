// Renders the API reference on every docs-site stdlib page from `milo api --json`.
//
// Each docs/site/stdlib/<module>.md carries `<!-- generated:api -->` ... `<!-- /generated:api -->`.
// Between the markers is every public type, method and function of std/<module>: heading,
// signature, doc comment. Above them is hand-written prose (intro, import line, quick start,
// worked examples) that this script never touches. The std doc comments are the single
// source: `milo api`, LSP hover and the site all read the same text, so a fact about an API
// belongs in its doc comment, not on the page.
//
// The payload is read through the CLI, never by importing src/*.ts (docs/json-api.md): the
// day the compiler is Rust or self-hosted, this keeps working.
//
//   bun run scripts/gen-std-docs.ts            # rewrite the regions in place
//   bun run scripts/gen-std-docs.ts --check    # exit 1 if a region is stale (the CI gate)
//   bun run scripts/gen-std-docs.ts json fs     # only these pages
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
export const SITE_STDLIB = join(ROOT, "docs", "site", "stdlib");

export interface ApiEntry {
  kind: "function" | "type";
  module: string;
  name: string;
  signature: string;
  doc: string;
  docFull: string;
  fields?: { name: string; type: string; doc?: string }[];
  variants?: { name: string; payload?: string; value?: string; doc?: string }[];
}

export function apiEntries(): ApiEntry[] {
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "api", "--json"], {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out).entries;
}

// `std/pty.darwin` and `std/process.windows` are arms behind one import path; the resolver
// picks by target OS, so a reader writes `std/pty` and that is the page.
export const pageOf = (module: string) => module.replace(/^std\//, "").split(".")[0]!;
const armOf = (module: string) => module.split(".")[1] ?? "";

// Doc comments are prose written for `milo api` and hover, not for Vue. A bare `Handle<T>`
// outside backticks is an unclosed HTML tag to VitePress and fails the build, and `{{` is
// template interpolation, so both are escaped everywhere except inside code spans.
function escapeProse(text: string): string {
  return text.split(/(`[^`\n]*`)/).map((part, i) =>
    i % 2 === 1 ? part : part.replace(/</g, "&lt;").replace(/\{\{/g, "&#123;&#123;"),
  ).join("");
}

interface Merged {
  name: string; kind: ApiEntry["kind"]; sigs: Map<string, string[]>; arms: string[]; doc: string;
  fields?: ApiEntry["fields"]; variants?: ApiEntry["variants"];
}

// One heading per name. Platform arms usually agree; where a signature differs the fence
// shows each spelling with the arms that use it, and a name only some arms export says so.
function merge(entries: ApiEntry[]): { merged: Merged[]; allArms: string[] } {
  const allArms = [...new Set(entries.map(e => armOf(e.module)))].sort();
  const byName = new Map<string, Merged>();
  for (const e of entries) {
    const m: Merged = byName.get(e.name) ?? { name: e.name, kind: e.kind, sigs: new Map(), arms: [], doc: "", fields: e.fields, variants: e.variants };
    const arm = armOf(e.module);
    m.sigs.set(e.signature, [...(m.sigs.get(e.signature) ?? []), arm]);
    m.arms.push(arm);
    if (!m.doc && e.docFull) m.doc = e.docFull;
    byName.set(e.name, m);
  }
  return { merged: [...byName.values()], allArms };
}

function renderEntry(m: Merged, level: string, allArms: string[]): string {
  const lines = [`${level} \`${m.name}\``, "", "```milo"];
  if (m.sigs.size === 1) lines.push(...m.sigs.keys());
  else for (const [sig, arms] of m.sigs) lines.push(`${sig} // ${arms.join(", ")}`);
  lines.push("```", "");
  if (allArms.length > 1 && m.arms.length < allArms.length) {
    lines.push(`Only on ${m.arms.sort().join(", ")}.`, "");
  }
  if (m.doc) lines.push(escapeProse(m.doc), "");
  // A leading underscore is std's spelling for "internal": listing `_preg` as a field
  // would invite a reader to touch it.
  const fields = (m.fields ?? []).filter(f => !f.name.startsWith("_"));
  if (fields.some(f => f.doc)) {
    lines.push("Fields:", "");
    for (const f of fields) lines.push(`- \`${f.name}: ${f.type}\`${f.doc ? ": " + escapeProse(f.doc.replace(/\s*\n\s*/g, " ")) : ""}`);
    lines.push("");
  } else if (fields.length) {
    lines.push(`Fields: ${fields.map(f => `\`${f.name}: ${f.type}\``).join(", ")}.`, "");
  }
  if (m.variants?.length) {
    lines.push("Variants:", "");
    for (const v of m.variants) {
      const head = `\`${v.name}${v.payload !== undefined ? `(${v.payload})` : ""}${v.value !== undefined ? ` = ${v.value}` : ""}\``;
      lines.push(`- ${head}${v.doc ? ": " + escapeProse(v.doc.replace(/\s*\n\s*/g, " ")) : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderModule(page: string, entries: ApiEntry[]): string {
  const { merged, allArms } = merge(entries);
  const byName = (a: Merged, b: Merged) => a.name.localeCompare(b.name);
  const types = merged.filter(m => m.kind === "type").sort(byName);
  const typeNames = new Set(types.map(t => t.name));
  const ownerOf = (m: Merged) => m.name.includes(".") ? m.name.split(".")[0]! : null;
  const out = ["## API reference", ""];
  if (allArms.length > 1) {
    out.push(`\`std/${page}\` has one implementation per target (${allArms.map(a => a || "default").join(", ")}); the resolver picks the one for the target you build for.`, "");
  }
  // A type heading, then its methods one level down, so the page outline lists the types.
  for (const t of types) {
    out.push(renderEntry(t, "###", allArms));
    for (const m of merged.filter(m => m.kind === "function" && ownerOf(m) === t.name).sort(byName)) {
      out.push(renderEntry(m, "####", allArms));
    }
  }
  const free = merged.filter(m => m.kind === "function" && !typeNames.has(ownerOf(m) ?? "")).sort(byName);
  if (free.length && types.length) out.push("### Functions", "");
  for (const f of free) out.push(renderEntry(f, types.length ? "####" : "###", allArms));
  return out.join("\n").trimEnd();
}

function splice(body: string, region: string, content: string, file: string, note: string): string {
  const open = `<!-- generated:${region} -->`;
  const close = `<!-- /generated:${region} -->`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    // A page that lost its markers would otherwise be skipped, and the gate would report
    // a clean bill of health for a page nothing regenerates.
    throw new Error(`${file}: missing '${open}' / '${close}' markers`);
  }
  return body.slice(0, start) + open + "\n" + note + "\n\n" + content + "\n\n" + body.slice(end);
}

interface BuiltinMember { name: string; signature: string; note?: string }

export function builtinMembers(): Record<string, BuiltinMember[]> {
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "lang", "--json"], {
    encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out).builtinMembers;
}

// The string page documents methods the checker dispatches by hand (no import, no std
// source), so their signatures come from `milo lang --json`, not from `milo api`.
export function renderBuiltins(receiver: string, members: BuiltinMember[]): string {
  const cell = (t: string) => escapeProse(t).replace(/\|/g, "\\|");
  const rows = members.map(m => `| \`${m.name}${m.signature}\` | ${m.note ? cell(m.note) : ""} |`);
  return [`| \`${receiver}\` method | Notes |`, "|---|---|", ...rows].join("\n");
}

// Pages that carry a second region fed from `lang --json` rather than `api --json`.
const BUILTIN_REGIONS: { page: string; receiver: string }[] = [{ page: "string", receiver: "string" }];

// `only` limits the run to some pages (the CLI's positional args), for iterating on one page.
export function generate(
  entries = apiEntries(), only?: Set<string>, builtins = builtinMembers(),
): { file: string; expected: string; actual: string }[] {
  const byPage = new Map<string, ApiEntry[]>();
  for (const e of entries) byPage.set(pageOf(e.module), [...(byPage.get(pageOf(e.module)) ?? []), e]);
  const results = [];
  for (const f of readdirSync(SITE_STDLIB).sort()) {
    if (!f.endsWith(".md") || f === "index.md") continue;
    const page = f.replace(/\.md$/, "");
    if (only?.size && !only.has(page)) continue;
    const file = `docs/site/stdlib/${f}`;
    const mine = byPage.get(page);
    if (!mine) throw new Error(`${file}: no std module named std/${page} in 'milo api --json'`);
    const actual = readFileSync(join(ROOT, file), "utf-8");
    let expected = splice(actual, "api", renderModule(page, mine), file,
      `<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/${page}*.milo. -->`);
    for (const b of BUILTIN_REGIONS.filter(b => b.page === page)) {
      const members = builtins[b.receiver];
      if (!members?.length) throw new Error(`${file}: 'milo lang --json' has no builtinMembers.${b.receiver}`);
      expected = splice(expected, "builtins", renderBuiltins(b.receiver, members), file,
        `<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo lang --json' (builtinMembers.${b.receiver}). -->`);
    }
    results.push({ file, expected, actual });
  }
  return results;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const results = generate(apiEntries(), new Set(process.argv.slice(2).filter(a => !a.startsWith("-"))));
  const stale = results.filter(r => r.expected !== r.actual);
  if (check) {
    if (stale.length) {
      console.error(`stale generated API regions: ${stale.map(r => r.file).join(", ")}`);
      console.error("run: bun run scripts/gen-std-docs.ts");
      process.exit(1);
    }
    console.log(`generated API regions up to date (${results.length} pages checked)`);
  } else {
    for (const r of stale) writeFileSync(join(ROOT, r.file), r.expected);
    console.log(stale.length ? `rewrote ${stale.length} of ${results.length} pages` : `already up to date (${results.length} pages)`);
  }
}
