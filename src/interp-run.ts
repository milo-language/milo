// `milo interp` driver: run a lowered module in the reference interpreter and mirror what a
// compiled binary would do with its stdout, stderr and exit code.
import { writeSync } from "fs";
import type { Program } from "./ast";
import type { CheckResult } from "./checker";
import { Interp } from "./interp";
import { InterpStuck, InterpUnsupported } from "./interp-values";

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off);
}

export function runInterp(program: Program, checked: CheckResult, reportLive: boolean): number {
  const it = new Interp(program, checked);
  try {
    const r = it.run();
    writeAll(1, r.stdout);
    if (r.stderr) writeAll(2, new TextEncoder().encode(r.stderr));
    if (reportLive) console.error(`interp: live blocks ${r.live === null ? "unknown" : r.live}`);
    return r.code;
  } catch (e) {
    writeAll(1, Uint8Array.from(it.out));
    if (e instanceof InterpUnsupported) { console.error(e.message); return 3; }
    if (e instanceof InterpStuck) { console.error(e.message); return 4; }
    throw e;
  }
}
