// Guarded child execution: hard memory + wall-clock + CPU caps for every
// process the test harnesses spawn.
//
// Why this exists: milo-self has known memory-corruption bugs, and a runaway
// allocation swaps macOS to death long before any wall-clock timeout fires.
// macOS enforces neither RLIMIT_DATA nor RLIMIT_AS (verified: a 3GB malloc
// succeeds under `ulimit -d`/`-v` of 1GB), so no kernel-side cap is possible.
// Instead a single watchdog polls `ps` for the RSS of each guarded process
// group and SIGKILLs the whole group on breach. The ulimits are still set
// because Linux does enforce them, and RLIMIT_CPU works everywhere as a
// backstop against spin loops.
//
// Library:  import { guardedRun } from "../scripts/guard"
// CLI:      bun scripts/guard.ts [--mem-mb N] [--timeout-s N] -- cmd args...
//           (required for any manual milo-self invocation — never run it bare)
import { spawn, execFile } from "child_process";
import { totalmem } from "os";

const TOTAL_MB = Math.floor(totalmem() / (1024 * 1024));
// Per-tree cap defaults to 4GB but never more than a quarter of RAM, so the
// watchdog fires well before the memory compressor / swap thrash begins
// (compression would hide RSS growth and blind the watchdog).
export const DEFAULT_MEM_MB =
  Number(process.env.MILO_GUARD_MEM_MB || 0) || Math.min(4096, Math.floor(TOTAL_MB / 4));
export const DEFAULT_TIMEOUT_MS = Number(process.env.MILO_GUARD_TIMEOUT_MS || 0) || 60_000;
// Backstop across ALL concurrently guarded trees (e.g. parallel compile pools):
// past half of RAM, the largest tree is killed even if no single tree breached.
const GLOBAL_MEM_KB = (Number(process.env.MILO_GUARD_TOTAL_MB || 0) || Math.floor(TOTAL_MB / 2)) * 1024;
const POLL_MS = 100;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export type GuardKill = "memory" | "global-memory" | "timeout";
export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal: string | null;
  guardKill?: GuardKill;
};

type Entry = { pgid: number; limitKb: number; deadline: number; kill: (reason: GuardKill) => void };

// One registry + one ps(1) call per tick for all live children, so N
// concurrent guarded spawns cost one poll, not N.
const live = new Map<number, Entry>();
let pollScheduled = false;

function schedulePoll() {
  if (pollScheduled || live.size === 0) return;
  pollScheduled = true;
  const t = setTimeout(poll, POLL_MS);
  (t as any).unref?.();
}

function poll() {
  pollScheduled = false;
  if (live.size === 0) return;
  execFile("ps", ["-axo", "pgid=,rss="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (!err) {
      const rssByPgid = new Map<number, number>();
      for (const line of String(out).split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        const pgid = Number(parts[0]);
        rssByPgid.set(pgid, (rssByPgid.get(pgid) ?? 0) + (Number(parts[1]) || 0));
      }
      const now = Date.now();
      let totalKb = 0;
      let largest: Entry | null = null;
      let largestKb = -1;
      for (const e of live.values()) {
        const kb = rssByPgid.get(e.pgid) ?? 0;
        totalKb += kb;
        if (kb > largestKb) {
          largestKb = kb;
          largest = e;
        }
        if (kb > e.limitKb) e.kill("memory");
        else if (now > e.deadline) e.kill("timeout");
      }
      if (totalKb > GLOBAL_MEM_KB && largest) largest.kill("global-memory");
    }
    schedulePoll();
  });
}

export interface GuardOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  memMb?: number;
  /** CLI mode: stream child output to this process instead of capturing. */
  inheritStdio?: boolean;
}

export function guardedRun(cmd: string, args: string[], opts: GuardOpts = {}): Promise<RunResult> {
  const memMb = opts.memMb ?? DEFAULT_MEM_MB;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limitKb = memMb * 1024;
  const cpuSec = Math.max(30, Math.ceil((timeoutMs / 1000) * 2));
  const ulimits = `ulimit -t ${cpuSec} 2>/dev/null; ulimit -v ${limitKb} 2>/dev/null; ulimit -d ${limitKb} 2>/dev/null; exec "$@"`;

  return new Promise(resolve => {
    // detached => own process group (pgid == pid), so one kill(-pgid) takes
    // down the entire tree, including grandchildren that reparented to init.
    const child = spawn("/bin/sh", ["-c", ulimits, "sh", cmd, ...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", opts.inheritStdio ? "inherit" : "pipe", opts.inheritStdio ? "inherit" : "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let captured = 0;
    let guardKill: GuardKill | undefined;

    const append = (which: "out" | "err", d: Buffer) => {
      captured += d.length;
      if (captured > MAX_CAPTURE_BYTES) return; // truncate; wall timeout bounds the spew
      if (which === "out") stdout += d.toString();
      else stderr += d.toString();
    };
    child.stdout?.on("data", d => append("out", d));
    child.stderr?.on("data", d => append("err", d));

    const pid = child.pid;
    if (pid !== undefined) {
      live.set(pid, {
        pgid: pid,
        limitKb,
        deadline: Date.now() + timeoutMs,
        // kill repeats every poll until close unregisters, in case the first
        // SIGKILL races a fork
        kill: reason => {
          guardKill ??= reason;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        },
      });
      schedulePoll();
    }

    const finish = (code: number, signal: string | null) => {
      if (pid !== undefined) live.delete(pid);
      if (guardKill === "memory") stderr += `\n[guard] SIGKILL: process tree exceeded ${memMb} MB RSS`;
      else if (guardKill === "global-memory")
        stderr += `\n[guard] SIGKILL: combined guarded processes exceeded ${Math.floor(GLOBAL_MEM_KB / 1024)} MB RSS (largest tree killed)`;
      else if (guardKill === "timeout") stderr += `\n[guard] SIGKILL: exceeded ${timeoutMs} ms`;
      resolve({ stdout, stderr, code, signal, guardKill });
    };

    child.on("error", () => finish(127, null));
    child.on("close", (code, signal) => finish(code ?? 1, signal));
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let memMb = DEFAULT_MEM_MB;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === "--mem-mb") memMb = Number(argv[++i]);
    else if (argv[i] === "--timeout-s") timeoutMs = Number(argv[++i]) * 1000;
    else if (argv[i] === "--") {
      i++;
      break;
    } else break;
  }
  const [cmd, ...rest] = argv.slice(i);
  if (!cmd) {
    console.error("usage: bun scripts/guard.ts [--mem-mb N] [--timeout-s N] -- cmd args...");
    process.exit(2);
  }
  const r = await guardedRun(cmd, rest, { memMb, timeoutMs, inheritStdio: true });
  if (r.guardKill) console.error(r.stderr.trim());
  process.exit(r.signal ? 137 : r.code);
}
