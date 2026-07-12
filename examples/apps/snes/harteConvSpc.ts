// Convert a Harte SPC700 opcode test file (roms/harte-spc700/v1/<hex>.json) into
// a flat whitespace-separated integer stream Milo can read without std/json.
// Per case, two records (initial, final): a x y sp pc psw ramN (addr val)*ramN.
// Header = case count.
//   bun run examples/apps/snes/harteConvSpc.ts roms/harte-spc700/v1/00.json /tmp/00.flat
import { readFileSync, writeFileSync } from "fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: harteConvSpc <in.json> <out.flat>");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(inPath, "utf8")) as any[];
const out: number[] = [];
function emitState(s: any) {
  out.push(s.a & 0xff, s.x & 0xff, s.y & 0xff, s.sp & 0xff, s.pc >>> 0, s.psw & 0xff);
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
