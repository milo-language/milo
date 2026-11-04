// `milo interp` driver: run a checked program in the reference interpreter and mirror what a
// compiled binary would do with its stdout, stderr and exit code.
import { readFileSync, writeSync } from "fs";
import { dirname, resolve } from "path";
import type { Program } from "./ast";
import type { CheckResult } from "./checker";
import type { Interp } from "./interp";
import { runChecked, type RunOptions } from "./interp-co";
import { nodeHostFs } from "./interp-hostfs";
import { InterpStuck, InterpUnsupported } from "./interp-values";

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off);
}

// hostFs: let the program read the real filesystem (read-only). Off, it sees an in-memory filesystem
// seeded, read-only and on demand, with the directory the program lives in.
export interface RunInterpOptions extends RunOptions { hostFs?: boolean }

export function runInterp(program: Program, checked: CheckResult, reportLive: boolean, opts: RunInterpOptions = {}): number {
  let it: Interp | undefined;
  try {
    const home = dirname(resolve(opts.entryFile ?? "."));
    const sys = {
      hostFs: nodeHostFs,
      hostRoots: opts.hostFs ? ["/"] : [home],
      cwd: opts.hostFs ? process.cwd() : home,
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      stdin: () => { try { return new Uint8Array(readFileSync(0)); } catch { return new Uint8Array(0); } },
    };
    const run = runChecked(program, checked, { ...opts, sys });
    it = run.it;
    const r = run.result;
    writeAll(1, r.stdout);
    if (r.stderr) writeAll(2, new TextEncoder().encode(r.stderr));
    if (reportLive) console.error(`interp: live blocks ${r.live === null ? "unknown" : r.live}`);
    return r.code;
  } catch (e) {
    it = (e as { interp?: Interp }).interp ?? it;
    if (it) writeAll(1, Uint8Array.from(it.out));
    if (e instanceof InterpUnsupported) { console.error(e.message + (e.where ? `\n  in ${e.where}` : "")); return 3; }
    if (e instanceof InterpStuck) { console.error(e.message + (e.where ? `\n  in ${e.where}` : "")); return 4; }
    throw e;
  }
}
