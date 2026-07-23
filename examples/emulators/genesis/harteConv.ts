// Convert a Harte 680x0 opcode test file (X.json.gz) into a flat whitespace-
// separated integer stream that Milo can parse without std/json (which clones
// subtrees and blows memory on these 6 MB files).
//
// Per case, two records — initial then final:
//   d0..d7(8) a0..a6(7) usp ssp sr pc pf0 pf1 ramN (addr val)*ramN
//   d0..d7(8) a0..a6(7) usp ssp sr pc            ramN (addr val)*ramN
// (final has no prefetch fields). All decimal, space/newline separated.
//   bun run examples/emulators/genesis/harteConv.ts roms/.../NOP.json.gz /tmp/NOP.flat
import { gunzipSync } from "bun";
import { readFileSync, writeFileSync } from "fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: harteConv <in.json.gz> <out.flat>");
  process.exit(1);
}

const raw = readFileSync(inPath);
const json = inPath.endsWith(".gz") ? gunzipSync(raw) : raw;
const cases = JSON.parse(new TextDecoder().decode(json)) as any[];

const D = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];
const A = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];

const out: number[] = [];
function emitState(s: any, withPrefetch: boolean) {
  for (const k of D) out.push(s[k] >>> 0);
  for (const k of A) out.push(s[k] >>> 0);
  out.push(s.usp >>> 0, s.ssp >>> 0, s.sr & 0xffff, s.pc >>> 0);
  if (withPrefetch) {
    const pf = s.prefetch ?? [0, 0];
    out.push(pf[0] & 0xffff, pf[1] & 0xffff);
  }
  const ram = (s.ram ?? []) as [number, number][];
  out.push(ram.length);
  for (const [addr, val] of ram) out.push(addr >>> 0, val & 0xff);
}

// header: number of cases
out.push(cases.length);
for (const tc of cases) {
  emitState(tc.initial, true);
  emitState(tc.final, false);
}

writeFileSync(outPath, out.join(" "));
console.error(`wrote ${cases.length} cases -> ${outPath} (${out.length} ints)`);
