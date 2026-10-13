// Regenerates the simple case mapping tables at the bottom of std/unicode.milo from the Unicode Character Database.
//
// Run:  bun run scripts/gen-case-map.ts                    # fetch UnicodeData.txt
//       bun run scripts/gen-case-map.ts UnicodeData.txt    # or read a saved copy
//
// The source is UnicodeData.txt, fields 12 (Simple_Uppercase_Mapping) and 13
// (Simple_Lowercase_Mapping): one code point to one code point. The full mappings in
// SpecialCasing.txt (German ß to "SS", the context-dependent final sigma) are left
// out on purpose: they change a string's length in characters and depend on context
// and language, which a table lookup per code point cannot honour. Rows are sorted by
// code point so std/unicode can binary-search them without allocating.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const START = "// generated:casemap (scripts/gen-case-map.ts; do not edit by hand)";
const END = "// /generated:casemap";
const SOURCE = "https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt";

if (import.meta.main) {
  const arg = process.argv[2];
  const text = arg ? readFileSync(arg, "utf-8") : await (await fetch(SOURCE)).text();
  const lower: [number, number][] = [];
  const upper: [number, number][] = [];
  for (const line of text.split("\n")) {
    const f = line.split(";");
    if (f.length < 15) continue;
    const cp = parseInt(f[0]!, 16);
    if (f[12]) upper.push([cp, parseInt(f[12], 16)]);
    if (f[13]) lower.push([cp, parseInt(f[13], 16)]);
  }
  if (lower.length < 1000 || upper.length < 1000) throw new Error(`suspiciously small table: ${lower.length} lower, ${upper.length} upper`);
  const wrap = (items: number[]) => {
    const lines: string[] = [];
    let line = "   ";
    for (const it of items) {
      const s = String(it);
      if (line.length + s.length + 2 > 96) { lines.push(line); line = "   "; }
      line += ` ${s},`;
    }
    lines.push(line);
    return lines.join("\n");
  };
  const table = (name: string, rows: [number, number][]) => [
    `let ${name}_COUNT: i64 = ${rows.length}`,
    `let ${name}_FROM: [i32; ${rows.length}] = [`, wrap(rows.map(r => r[0])), `]`,
    `let ${name}_TO: [i32; ${rows.length}] = [`, wrap(rows.map(r => r[1])), `]`,
  ];
  const region = [START, ...table("LOWER", lower), ...table("UPPER", upper), END].join("\n");
  const path = join(import.meta.dir, "..", "std", "unicode.milo");
  const src = readFileSync(path, "utf-8");
  const a = src.indexOf(START), b = src.indexOf(END);
  const out = a >= 0 && b > a
    ? src.slice(0, a) + region + src.slice(b + END.length)
    : src.trimEnd() + "\n\n" + region + "\n";
  writeFileSync(path, out);
  console.log(`wrote ${lower.length} lowercase and ${upper.length} uppercase mappings to std/unicode.milo`);
}
