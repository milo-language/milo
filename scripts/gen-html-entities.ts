// Regenerates the named character reference table at the bottom of std/html.milo from the WHATWG HTML entity list.
//
// Run:  bun run scripts/gen-html-entities.ts                  # fetch the WHATWG table
//       bun run scripts/gen-html-entities.ts entities.json    # or read a saved copy
//
// The source is https://html.spec.whatwg.org/entities.json, the table the HTML
// standard itself links. Only the semicolon-terminated names are emitted (2125):
// the ~100 legacy forms without `;` (`&amp`, `&copy`) are an HTML parser recovery
// rule, and Html.unescape requires the `;` for numeric references too. Names are
// sorted bytewise so std/html can binary-search them without allocating; a name
// that expands to two code points (93 of them, `&NotEqualTilde;`) keeps the second
// in ENTITY_CP2, which is 0 otherwise.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const START = "// generated:entities (scripts/gen-html-entities.ts; do not edit by hand)";
const END = "// /generated:entities";

if (import.meta.main) {
  const arg = process.argv[2];
  const text = arg
    ? readFileSync(arg, "utf-8")
    : await (await fetch("https://html.spec.whatwg.org/entities.json")).text();
  const table = JSON.parse(text) as Record<string, { codepoints: number[] }>;
  const rows = Object.entries(table)
    .filter(([k]) => k.startsWith("&") && k.endsWith(";"))
    .map(([k, v]) => ({ name: k.slice(1, -1), cps: v.codepoints }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const r of rows) {
    if (!/^[A-Za-z0-9]+$/.test(r.name) || r.cps.length < 1 || r.cps.length > 2) {
      throw new Error(`unexpected entity row ${JSON.stringify(r)}`);
    }
  }
  const n = rows.length;
  const wrap = (items: string[]) => {
    const lines: string[] = [];
    let line = "   ";
    for (const it of items) {
      if (line.length + it.length + 2 > 96) { lines.push(line); line = "   "; }
      line += ` ${it},`;
    }
    lines.push(line);
    return lines.join("\n");
  };
  const region = [
    START,
    `let ENTITY_COUNT: i64 = ${n}`,
    `let ENTITY_NAMES: [string; ${n}] = [`,
    wrap(rows.map(r => `"${r.name}"`)),
    `]`,
    `let ENTITY_CP1: [i32; ${n}] = [`,
    wrap(rows.map(r => String(r.cps[0]))),
    `]`,
    `let ENTITY_CP2: [i32; ${n}] = [`,
    wrap(rows.map(r => String(r.cps[1] ?? 0))),
    `]`,
    END,
  ].join("\n");
  const path = join(import.meta.dir, "..", "std", "html.milo");
  const src = readFileSync(path, "utf-8");
  const a = src.indexOf(START), b = src.indexOf(END);
  const out = a >= 0 && b > a
    ? src.slice(0, a) + region + src.slice(b + END.length)
    : src.trimEnd() + "\n\n" + region + "\n";
  writeFileSync(path, out);
  console.log(`wrote ${n} entities to std/html.milo`);
}
