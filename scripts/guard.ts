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

export type GuardKill = "memory" | "global-memory" | "timeout" | "watchdog-blind";
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

// If ps itself starts failing the watchdog is blind — usually a sign the
// system is already under severe pressure. Fail closed: kill everything.
let psFailures = 0;

function poll() {
  pollScheduled = false;
  if (live.size === 0) return;
  execFile("ps", ["-axo", "pgid=,rss="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) {
      if (++psFailures >= 5) for (const e of live.values()) e.kill("watchdog-blind");
    } else {
      psFailures = 0;
      const rssByPgid = new Map<number, number>();
      for (const line of String(out).split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        const pgid = Number(parts[0]);
        rssByPgid.set(pgid, (rssByPgid.get(pgid) ?? 0) + (Number(parts[1]) || 0));
      }
      const now = Date.now();
      let totalKb = 0;
      const sized: { e: Entry; kb: number }[] = [];
      for (const e of live.values()) {
        const kb = rssByPgid.get(e.pgid) ?? 0;
        totalKb += kb;
        sized.push({ e, kb });
        if (kb > e.limitKb) e.kill("memory");
        else if (now > e.deadline) e.kill("timeout");
      }
      // Global breach: killing one tree per tick loses the race against N
      // concurrent allocators — kill largest trees until projected under cap.
      if (totalKb > GLOBAL_MEM_KB) {
        sized.sort((a, b) => b.kb - a.kb);
        let excess = totalKb - GLOBAL_MEM_KB;
        for (const { e, kb } of sized) {
          if (excess <= 0) break;
          e.kill("global-memory");
          excess -= kb;
        }
      }
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
  // In-pgid shell watchdog: the node-side poll dies if this bun process dies
  // (children are detached and would keep running unguarded), and its timers
  // starve if the event loop stalls under memory pressure. This subshell lives
  // inside the child's own process group, so it survives parent death and
  // kills the group itself on RSS breach or tick-cap (wall clock) breach.
  // It exits when the group leader (the exec'd command) does.
  const maxTicks = Math.ceil(timeoutMs / 250) + 40;
  const ulimits = `ulimit -t ${cpuSec} 2>/dev/null; ulimit -v ${limitKb} 2>/dev/null; ulimit -d ${limitKb} 2>/dev/null
pgid=$$
(
  t=0
  while kill -0 "$pgid" 2>/dev/null; do
    rss=$(ps -axo pgid=,rss= 2>/dev/null | awk -v g="$pgid" '$1==g {s+=$2} END {print s+0}')
    if [ "\${rss:-0}" -gt ${limitKb} ] || [ "$t" -ge ${maxTicks} ]; then
      kill -9 -"$pgid" 2>/dev/null
      exit 0
    fi
    t=$((t+1))
    sleep 0.25
  done
) >/dev/null 2>&1 &
exec "$@"`;

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
      else if (guardKill === "watchdog-blind")
        stderr += `\n[guard] SIGKILL: ps unresponsive, watchdog blind — killed fail-closed`;
      resolve({ stdout, stderr, code, signal, guardKill });
    };

    child.on("error", () => finish(127, null));
    child.on("close", (code, signal) => finish(code ?? 1, signal));
  });
}

// RSS watchdog for a NON-detached child (same pgid, inherited stdio/tty —
// e.g. `milo run`, which must stay interactive so it can't be moved into its
// own process group). Polls the pid subtree via ppid links and SIGKILLs every
// pid in it on breach. Descendants that reparent to init escape this walk;
// that's acceptable for the default `milo run` guard — the hard pgid-based
// guarantee for untrusted milo-self stays with guardedRun.
export function monitorPidTree(
  rootPid: number,
  memMb: number,
  onBreach: (rssMb: number) => void
): () => void {
  const limitKb = memMb * 1024;
  let stopped = false;
  let notified = false;
  const tick = () => {
    if (stopped) return;
    execFile("ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (stopped) return;
      if (!err) {
        const kids = new Map<number, number[]>();
        const rss = new Map<number, number>();
        for (const line of String(out).split("\n")) {
          const p = line.trim().split(/\s+/);
          if (p.length !== 3) continue;
          const pid = Number(p[0]);
          const ppid = Number(p[1]);
          rss.set(pid, Number(p[2]) || 0);
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid)!.push(pid);
        }
        const tree: number[] = [];
        const queue = [rootPid];
        while (queue.length) {
          const p = queue.pop()!;
          tree.push(p);
          for (const c of kids.get(p) ?? []) queue.push(c);
        }
        const totalKb = tree.reduce((s, p) => s + (rss.get(p) ?? 0), 0);
        if (totalKb > limitKb) {
          // keep killing every tick until stop() — catches fork races
          for (const p of tree) {
            try {
              process.kill(p, "SIGKILL");
            } catch {}
          }
          if (!notified) {
            notified = true;
            onBreach(Math.round(totalKb / 1024));
          }
        }
      }
      const t = setTimeout(tick, POLL_MS);
      (t as any).unref?.();
    });
  };
  tick();
  return () => {
    stopped = true;
  };
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
