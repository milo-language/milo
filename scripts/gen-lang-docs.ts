// Renders the published language reference from `milo lang --json`.
//
// The docs site used to RESTATE the compiler's vocabulary: an attribute table retyped from
// src/attributes.ts (it had already shipped missing five, three of them safety-critical),
// and a warning section that covered 10 of the 26 warnings the compiler emits — the other
// 16 existed only in `--help` output, so a user had no way to learn they were there.
// A hand table plus a test that the table is complete is still two copies; this is one.
//
// The payload is read through the CLI, never by importing src/*.ts, for the reason in
// docs/json-api.md: the day the compiler is Rust or self-hosted, this script keeps working.
//
// Each managed page carries `<!-- generated:<region> -->` … `<!-- /generated:<region> -->`
// markers. Everything between them is ours; everything outside is hand-written prose that
// a generator has no business touching.
//
//   bun run scripts/gen-lang-docs.ts            # rewrite the regions in place
//   bun run scripts/gen-lang-docs.ts --check    # exit 1 if a region is stale (the CI gate)
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

interface Warning { name: string; offByDefault: boolean; doc?: string; fix?: string; example?: string }
interface Attribute { name: string; targets: string[]; takesArgs: boolean; doc: string }

function payload(): { warnings: Warning[]; attributes: Attribute[]; keywords: string[]; softKeywords: string[]; keywordDocs: Record<string, string> } {
  const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "lang", "--json"], {
    encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function renderWarnings(warnings: Warning[]): string {
  const lines: string[] = [];
  lines.push("| Warning | Default |");
  lines.push("|---|---|");
  for (const w of warnings) {
    const anchor = w.doc ? `[\`${w.name}\`](#${w.name})` : `\`${w.name}\``;
    lines.push(`| ${anchor} | ${w.offByDefault ? "allow" : "warn"} |`);
  }
  // Documented first, so the reference reads as a reference and the undocumented tail is
  // visibly a gap rather than an absence.
  const documented = warnings.filter(w => w.doc && w.fix && w.example);
  for (const w of documented) {
    lines.push("");
    lines.push(`### ${w.name}`);
    lines.push("");
    lines.push(w.offByDefault
      ? `_Off by default — enable with \`--deny=${w.name}\` or \`--expect=${w.name}\`._`
      : "_On by default._");
    lines.push("");
    lines.push(w.doc!.trim());
    lines.push("");
    lines.push("```milo");
    lines.push(w.example!.trimEnd());
    lines.push("```");
    lines.push("");
    lines.push(`**Fix:** ${w.fix!.trim()}`);
  }
  const undocumented = warnings.filter(w => !(w.doc && w.fix && w.example));
  if (undocumented.length) {
    lines.push("");
    lines.push(`_${undocumented.length} warning${undocumented.length === 1 ? " has" : "s have"} no reference entry yet: ` +
      undocumented.map(w => `\`${w.name}\``).join(", ") + "._");
  }
  return lines.join("\n");
}

function renderAttributes(attributes: Attribute[]): string {
  const lines: string[] = [];
  for (const a of attributes) {
    const spelling = a.takesArgs ? `@${a.name}(…)` : `@${a.name}`;
    lines.push(`### \`${spelling}\``);
    lines.push("");
    lines.push(`_Goes on: ${a.targets.map(t => `\`${t}\``).join(", ")}._`);
    lines.push("");
    lines.push(a.doc.trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderKeywords(p: { keywords: string[]; softKeywords: string[]; keywordDocs: Record<string, string> }): string {
  const soft = new Set(p.softKeywords);
  const all = [...p.keywords, ...p.softKeywords].sort();
  const lines: string[] = [];
  for (const k of all) {
    lines.push(`### \`${k}\``);
    lines.push("");
    if (soft.has(k)) lines.push("_Soft keyword: reserved only where the grammar expects it._", "");
    // `milo skip`, not `milo`: a hover doc shows the FORM of a construct, with `…` where a
    // body goes, so it is deliberately not a compilable program. The doc-test harness in
    // tests/docs.test.ts would otherwise reject the whole page.
    lines.push(p.keywordDocs[k]!.trim().replace(/^```milo$/m, "```milo skip"));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

const REGIONS: { file: string; region: string; render: (p: ReturnType<typeof payload>) => string }[] = [
  { file: "docs/site/language/warnings-and-errors.md", region: "warnings", render: p => renderWarnings(p.warnings) },
  { file: "docs/site/features/annotations.md", region: "attributes", render: p => renderAttributes(p.attributes) },
  { file: "docs/site/language/keywords.md", region: "keywords", render: p => renderKeywords(p) },
];

function splice(body: string, region: string, content: string, file: string): string {
  const open = `<!-- generated:${region} -->`;
  const close = `<!-- /generated:${region} -->`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    // A page that lost its markers would otherwise be silently skipped, and the gate would
    // report a clean bill of health for a page nothing regenerates.
    throw new Error(`${file}: missing '${open}' / '${close}' markers`);
  }
  const note = `<!-- Do not edit between these markers: generated by scripts/gen-lang-docs.ts from 'milo lang --json'. Edit the compiler's own vocabulary: src/warnings.ts, src/attributes.ts, src/keyword-docs.ts. -->`;
  return body.slice(0, start) + open + "\n" + note + "\n\n" + content + "\n\n" + body.slice(end);
}

export function generate(): { file: string; expected: string; actual: string }[] {
  const p = payload();
  return REGIONS.map(r => {
    const path = join(ROOT, r.file);
    const actual = readFileSync(path, "utf-8");
    return { file: r.file, expected: splice(actual, r.region, r.render(p), r.file), actual };
  });
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale = generate().filter(r => r.expected !== r.actual);
  if (check) {
    if (stale.length) {
      console.error(`stale generated regions: ${stale.map(r => r.file).join(", ")}`);
      console.error("run: bun run scripts/gen-lang-docs.ts");
      process.exit(1);
    }
    console.log(`generated regions up to date (${REGIONS.length} checked)`);
  } else {
    for (const r of stale) writeFileSync(join(ROOT, r.file), r.expected);
    console.log(stale.length ? `rewrote: ${stale.map(r => r.file).join(", ")}` : "already up to date");
  }
}
