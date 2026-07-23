// Diff the Milo 6502 trace against Nintendulator's golden nestest.log.
// Compares the semantic columns (PC, A, X, Y, P, SP, CYC); ignores disasm text
// and the PPU column (PPU timing not modeled yet).
//   bun run examples/emulators/nes/nestestDiff.ts
import { spawnSync } from "bun";
import { readFileSync } from "fs";

const LOG = "roms/nes-test-roms/other/nestest.log";

type Row = { pc: string; a: string; x: string; y: string; p: string; sp: string; cyc: string };

function parseGolden(line: string): Row | null {
  const pc = line.slice(0, 4);
  const m = line.match(/A:(\S\S) X:(\S\S) Y:(\S\S) P:(\S\S) SP:(\S\S).*CYC:(\d+)/);
  if (!m) return null;
  return { pc, a: m[1], x: m[2], y: m[3], p: m[4], sp: m[5], cyc: m[6] };
}

function parseMine(line: string): Row | null {
  // "C000 A:00 X:00 Y:00 P:24 SP:FD CYC:7"
  const m = line.match(/^(\S{4}) A:(\S\S) X:(\S\S) Y:(\S\S) P:(\S\S) SP:(\S\S) CYC:(\d+)/);
  if (!m) return null;
  return { pc: m[1], a: m[2], x: m[3], y: m[4], p: m[5], sp: m[6], cyc: m[7] };
}

const golden = readFileSync(LOG, "utf-8").split("\n").map(parseGolden).filter(Boolean) as Row[];

const proc = spawnSync(["bun", "run", "src/main.ts", "run", "examples/emulators/nes/runNestest.milo"]);
const mine = new TextDecoder().decode(proc.stdout).split("\n").map(parseMine).filter(Boolean) as Row[];

const n = Math.min(golden.length, mine.length);
let matched = 0;
for (let i = 0; i < n; i++) {
  const g = golden[i], o = mine[i];
  const same = g.pc === o.pc && g.a === o.a && g.x === o.x && g.y === o.y && g.p === o.p && g.sp === o.sp && g.cyc === o.cyc;
  if (!same) {
    console.log(`DIVERGE at instruction ${i + 1} (of ${golden.length} golden):`);
    console.log(`  golden: PC:${g.pc} A:${g.a} X:${g.x} Y:${g.y} P:${g.p} SP:${g.sp} CYC:${g.cyc}`);
    console.log(`  mine:   PC:${o.pc} A:${o.a} X:${o.x} Y:${o.y} P:${o.p} SP:${o.sp} CYC:${o.cyc}`);
    if (i > 0) {
      const pg = golden[i - 1];
      console.log(`  prev ok: PC:${pg.pc} (matched ${matched} instructions)`);
    }
    process.exit(1);
  }
  matched++;
}
console.log(`ALL ${matched} compared instructions match (golden has ${golden.length}, mine emitted ${mine.length}).`);
