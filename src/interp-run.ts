// `milo interp` driver: run a checked program in the reference interpreter and mirror what a
// compiled binary would do with its stdout, stderr and exit code.
import { writeSync } from "fs";
import type { Program } from "./ast";
import type { CheckResult } from "./checker";
import type { Interp } from "./interp";
import { runChecked, type RunOptions } from "./interp-co";
import { InterpStuck, InterpUnsupported } from "./interp-values";

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off);
}

export function runInterp(program: Program, checked: CheckResult, reportLive: boolean, opts: RunOptions = {}): number {
  let it: Interp | undefined;
  try {
    const run = runChecked(program, checked, opts);
    it = run.it;
    const r = run.result;
    writeAll(1, r.stdout);
    if (r.stderr) writeAll(2, new TextEncoder().encode(r.stderr));
    if (reportLive) console.error(`interp: live blocks ${r.live === null ? "unknown" : r.live}`);
    return r.code;
  } catch (e) {
    it = (e as { interp?: Interp }).interp ?? it;
    if (it) writeAll(1, Uint8Array.from(it.out));
    if (e instanceof InterpUnsupported) { console.error(e.message); return 3; }
    if (e instanceof InterpStuck) { console.error(e.message); return 4; }
    throw e;
  }
}
