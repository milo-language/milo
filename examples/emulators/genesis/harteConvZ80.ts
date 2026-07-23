// Convert a SingleStepTests z80 opcode file (v1/XX.json) into a flat whitespace-
// separated integer stream the Milo harness parses without std/json.
// Per case, two records (initial then final):
//   a b c d e f h l i r pc sp ix iy af_ bc_ de_ hl_ iff1 iff2 im wz ramN (addr val)*ramN
//   bun run examples/emulators/genesis/harteConvZ80.ts roms/z80tests/v1/00.json /tmp/z.flat
import { readFileSync, writeFileSync } from "fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: harteConvZ80 <in.json> <out.flat>");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(inPath, "utf8")) as any[];
const out: number[] = [];

function emit(s: any) {
  out.push(
    s.a & 0xff, s.b & 0xff, s.c & 0xff, s.d & 0xff, s.e & 0xff, s.f & 0xff,
    s.h & 0xff, s.l & 0xff, s.i & 0xff, s.r & 0xff,
    s.pc & 0xffff, s.sp & 0xffff, s.ix & 0xffff, s.iy & 0xffff,
    s.af_ & 0xffff, s.bc_ & 0xffff, s.de_ & 0xffff, s.hl_ & 0xffff,
    s.iff1 & 1, s.iff2 & 1, s.im & 3, s.wz & 0xffff,
  );
  const ram = (s.ram ?? []) as [number, number][];
  out.push(ram.length);
  for (const [addr, val] of ram) out.push(addr & 0xffff, val & 0xff);
}

out.push(cases.length);
for (const tc of cases) {
  emit(tc.initial);
  emit(tc.final);
}
writeFileSync(outPath, out.join(" "));
console.error(`wrote ${cases.length} cases -> ${outPath}`);
