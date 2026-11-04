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
import { explore, type ExploreOptions } from "./interp-explore";

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off);
}

// hostFs: let the program read the real filesystem (read-only). Off, it sees an in-memory filesystem
// seeded, read-only and on demand, with the directory the program lives in.
export interface RunInterpOptions extends RunOptions { hostFs?: boolean; explore?: Omit<ExploreOptions, "entryFile" | "sys"> }

// The `milo interp` flags: --explore [--max-schedules N] [--random N] [--seed S] [--allow-nondeterministic-output], --schedule a,b,c
export function interpOptions(args: string[], source: string, contractChecks: boolean | null | undefined): RunInterpOptions {
  const val = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const num = (flag: string, dflt: number): number => {
    const v = val(flag);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) { console.error(`error: ${flag} needs a non-negative integer`); process.exit(1); }
    return n;
  };
  const explore = args.includes("--explore");
  const sched = val("--schedule");
  const schedule = sched === undefined ? undefined : sched.split(",").filter(x => x !== "").map(x => Number(x));
  if (schedule && schedule.some(n => !Number.isInteger(n) || n < 0)) { console.error("error: --schedule needs comma-separated non-negative integers"); process.exit(1); }
  return {
    // exploring and replaying check contracts like a debug build, so a finding reproduces with the command it prints
    contractChecks: contractChecks ?? (args.includes("--debug") || explore || !!schedule),
    entryFile: source,
    hostFs: args.includes("--host-fs"),
    schedule,
    explore: explore ? {
      maxSchedules: num("--max-schedules", 1000),
      random: val("--random") === undefined ? undefined : num("--random", 0),
      seed: num("--seed", 1),
      allowNondeterministicOutput: args.includes("--allow-nondeterministic-output"),
    } : undefined,
  };
}

// S-PANIC-ABORT
export function runInterp(program: Program, checked: CheckResult, reportLive: boolean, opts: RunInterpOptions = {}): number {
  let it: Interp | undefined;
  try {
    const home = dirname(resolve(opts.entryFile ?? "."));
    const sys = {
      hostFs: nodeHostFs,
      hostRoots: opts.hostFs ? ["/"] : [home],
      cwd: opts.hostFs ? process.cwd() : home,
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      // read once: every explored schedule is a fresh run that sees the same stdin
      stdin: (() => { let cache: Uint8Array | undefined; return () => cache ??= (() => { try { return new Uint8Array(readFileSync(0)); } catch { return new Uint8Array(0); } })(); })(),
    };
    if (opts.explore) {
      const rep = explore(program, checked, { ...opts.explore, entryFile: opts.entryFile ?? "", sys }, opts.entryFile ?? "prog.milo");
      console.log(rep.text);
      return rep.failures > 0 ? 5 : 0;
    }
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
