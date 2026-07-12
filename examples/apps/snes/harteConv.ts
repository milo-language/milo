// Convert a Harte 65816 opcode test file (roms/harte-65816/v1/<hex>.<e|n>.json)
// into a flat whitespace-separated integer stream Milo can read without std/json
// (which clones the whole 3.8 MB source per accessor call and blows memory).
//
// Per case, two records — initial then final, identical field order:
//   a x y s d pc p dbr pbr e ramN (addr val)*ramN
// All decimal, space/newline separated. Header = case count.
//   bun run examples/apps/snes/harteConv.ts roms/harte-65816/v1/ea.e.json /tmp/ea.flat
import { readFileSync, writeFileSync } from "fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: harteConv <in.json> <out.flat>");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(inPath, "utf8")) as any[];

const out: number[] = [];
function emitState(s: any) {
  out.push(
    s.a >>> 0, s.x >>> 0, s.y >>> 0, s.s >>> 0, s.d >>> 0,
    s.pc >>> 0, s.p & 0xff, s.dbr & 0xff, s.pbr & 0xff, s.e & 1,
  );
  const ram = (s.ram ?? []) as [number, number][];
  out.push(ram.length);
  for (const [addr, val] of ram) out.push(addr >>> 0, val & 0xff);
}

out.push(cases.length);
for (const tc of cases) {
  emitState(tc.initial);
  emitState(tc.final);
}

writeFileSync(outPath, out.join(" "));
console.error(`wrote ${cases.length} cases -> ${outPath} (${out.length} ints)`);
