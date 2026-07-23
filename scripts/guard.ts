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
// CLI:      bun scripts/guard.ts [--mem-mb N] [--virtual-mem-mb N] [--timeout-s N] -- cmd args...
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

// RSS alone is not enough: once macOS starts compressing a runaway's pages,
// its RSS stops growing while its real footprint balloons (observed: ~80GB
// phys_footprint with RSS under cap — jetsam killed it, not us, after the
// system hit the "out of application memory" dialog). Two extra layers:
//  1. phys_footprint (includes compressed pages) per tree, polled at 1Hz via
//     footprint(1), enforced against the same per-tree limit.
//  2. system memory-pressure level (kern.memorystatus_vm_pressure_level:
//     1=normal 2=warning 4=critical). Critical kills every guarded tree;
//     sustained warning kills the largest tree per tick until pressure clears.
//     Fail-closed by design: pressure caused by *other* apps still kills
//     guarded children — they are untrusted, Chrome is not.
const PRESSURE_KILL_LEVEL = Number(process.env.MILO_GUARD_PRESSURE_KILL_LEVEL || 0) || 2;
const PRESSURE_SUSTAIN_TICKS = Number(process.env.MILO_GUARD_PRESSURE_SUSTAIN_TICKS || 0) || 10;
const FOOTPRINT_EVERY_TICKS = 10;

export type GuardKill =
  | "memory"
  | "footprint"
  | "global-memory"
  | "pressure"
  | "timeout"
  | "watchdog-blind";
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
let warnTicks = 0;
let tickNo = 0;
let footprintInFlight = false;
// pgid → phys_footprint KB, refreshed at 1Hz; between refreshes the last
// sample is enforced so a tree can't hide behind the sampling gap.
const footprintByPgid = new Map<number, number>();

function exec(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(res =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, out) => res(err ? null : String(out)))
  );
}

// darwin only; missing sysctl (linux) reads as normal — linux enforces ulimits.
async function pressureLevel(): Promise<number> {
  const out = await exec("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  return out === null ? 1 : Number(out.trim()) || 1;
}

// One footprint(1) call for every pid in the map; parses per-pid
// phys_footprint (KB/MB/GB) and sums per group key. Dead pids just drop out
// of the output. Returns null when footprint(1) is unavailable (linux —
// where ulimits are enforced anyway).
export async function footprintSums(pidsByGroup: Map<number, number[]>): Promise<Map<number, number> | null> {
  const args: string[] = [];
  for (const pids of pidsByGroup.values()) for (const p of pids) args.push("-p", String(p));
  if (args.length === 0) return new Map();
  const out = await exec("footprint", args);
  if (out === null) return null;
  const pidToGroup = new Map<number, number>();
  for (const [g, pids] of pidsByGroup) for (const p of pids) pidToGroup.set(p, g);
  const sums = new Map<number, number>();
  let curPid = -1;
  for (const line of out.split("\n")) {
    const head = line.match(/\[(\d+)\]/);
    if (head) curPid = Number(head[1]);
    const fp = line.match(/^\s*phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (fp && curPid >= 0) {
      const kb = parseFloat(fp[1]!) * (fp[2] === "GB" ? 1024 * 1024 : fp[2] === "MB" ? 1024 : 1);
      const g = pidToGroup.get(curPid);
      if (g !== undefined) sums.set(g, (sums.get(g) ?? 0) + kb);
    }
  }
  return sums;
}

async function sampleFootprints(pidsByPgid: Map<number, number[]>) {
  footprintInFlight = true;
  try {
    const sums = await footprintSums(pidsByPgid);
    if (sums === null) return; // no footprint(1) → rss layer still guards
    footprintByPgid.clear();
    for (const [pgid, kb] of sums) footprintByPgid.set(pgid, kb);
  } finally {
    footprintInFlight = false;
  }
}

async function poll() {
  pollScheduled = false;
  if (live.size === 0) return;
  tickNo++;
  const [out, level] = await Promise.all([exec("ps", ["-axo", "pgid=,pid=,rss="]), pressureLevel()]);
  if (out === null) {
    if (++psFailures >= 5) for (const e of live.values()) e.kill("watchdog-blind");
  } else {
    psFailures = 0;
    const rssByPgid = new Map<number, number>();
    const pidsByPgid = new Map<number, number[]>();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 3) continue;
      const pgid = Number(parts[0]);
      rssByPgid.set(pgid, (rssByPgid.get(pgid) ?? 0) + (Number(parts[2]) || 0));
      if (live.has(pgid)) {
        if (!pidsByPgid.has(pgid)) pidsByPgid.set(pgid, []);
        pidsByPgid.get(pgid)!.push(Number(parts[1]));
      }
    }
    if (tickNo % FOOTPRINT_EVERY_TICKS === 0 && !footprintInFlight) void sampleFootprints(pidsByPgid);

    const now = Date.now();
    let totalKb = 0;
    const sized: { e: Entry; kb: number }[] = [];
    for (const e of live.values()) {
      // footprint ≥ rss; take the max so compressed pages count against the cap
      const kb = Math.max(rssByPgid.get(e.pgid) ?? 0, footprintByPgid.get(e.pgid) ?? 0);
      totalKb += kb;
      sized.push({ e, kb });
      if ((rssByPgid.get(e.pgid) ?? 0) > e.limitKb) e.kill("memory");
      else if (kb > e.limitKb) e.kill("footprint");
      else if (now > e.deadline) e.kill("timeout");
    }
    sized.sort((a, b) => b.kb - a.kb);
    // Global breach: killing one tree per tick loses the race against N
    // concurrent allocators — kill largest trees until projected under cap.
    if (totalKb > GLOBAL_MEM_KB) {
      let excess = totalKb - GLOBAL_MEM_KB;
      for (const { e, kb } of sized) {
        if (excess <= 0) break;
        e.kill("global-memory");
        excess -= kb;
      }
    }
    // System pressure failsafe: critical kills everything guarded; sustained
    // warning sheds the largest tree per tick until the system recovers.
    if (level >= 4) for (const e of live.values()) e.kill("pressure");
    else if (level >= PRESSURE_KILL_LEVEL) {
      if (++warnTicks >= PRESSURE_SUSTAIN_TICKS && sized.length > 0) sized[0]!.e.kill("pressure");
    } else warnTicks = 0;
  }
  schedulePoll();
}

export interface GuardOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  memMb?: number;
  /** RLIMIT_AS/DATA allowance; may exceed RSS cap for runtimes that reserve sparse address space. */
  virtualMemMb?: number;
  /** CLI mode: stream child output to this process instead of capturing. */
  inheritStdio?: boolean;
}

// Windows has none of the machinery the POSIX guard is built on — no fork/pgid,
// no ps, no footprint(1), no rlimits — and the threat it exists for does not
// apply either: the guard protects a macOS dev machine that swaps to death
// because the kernel enforces no rlimits, whereas the only Windows consumer is a
// disposable CI runner. Keep the one guarantee that ports (wall clock) and kill
// the whole tree with taskkill. There is deliberately NO memory layer here, so
// nothing untrusted (milo-self) may be run under it on Windows.
function windowsRun(cmd: string, args: string[], opts: GuardOpts, timeoutMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", opts.inheritStdio ? "inherit" : "pipe", opts.inheritStdio ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let captured = 0;
    let guardKill: GuardKill | undefined;
    const append = (which: "out" | "err", d: Buffer) => {
      captured += d.length;
      if (captured > MAX_CAPTURE_BYTES) return;
      if (which === "out") stdout += d.toString();
      else stderr += d.toString();
    };
    child.stdout?.on("data", d => append("out", d));
    child.stderr?.on("data", d => append("err", d));

    const timer = setTimeout(() => {
      guardKill = "timeout";
      // /T takes the child's descendants with it; child.kill() would orphan them.
      if (child.pid !== undefined) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    }, timeoutMs);
    (timer as any).unref?.();

    const finish = (code: number, signal: string | null) => {
      clearTimeout(timer);
      if (guardKill === "timeout") stderr += `\n[guard] killed: exceeded ${timeoutMs} ms`;
      resolve({ stdout, stderr, code, signal, guardKill });
    };
    child.on("error", () => finish(127, null));
    child.on("close", (code, signal) => finish(code ?? 1, signal));
  });
}

export function guardedRun(cmd: string, args: string[], opts: GuardOpts = {}): Promise<RunResult> {
  if (process.platform === "win32") return windowsRun(cmd, args, opts, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const memMb = opts.memMb ?? DEFAULT_MEM_MB;
  const virtualMemMb = opts.virtualMemMb ?? memMb;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limitKb = memMb * 1024;
  const virtualLimitKb = virtualMemMb * 1024;
  const cpuSec = Math.max(30, Math.ceil((timeoutMs / 1000) * 2));
  // In-pgid shell watchdog: the node-side poll dies if this bun process dies
  // (children are detached and would keep running unguarded), and its timers
  // starve if the event loop stalls under memory pressure. This subshell lives
  // inside the child's own process group, so it survives parent death and
  // kills the group itself on RSS breach or tick-cap (wall clock) breach.
  // It exits when the group leader (the exec'd command) does.
  const maxTicks = Math.ceil(timeoutMs / 250) + 40;
  // Pressure check mirrors the node watchdog: this layer must also fire when a
  // compressed runaway hides from RSS (level 4 = critical → kill own group
  // immediately; level >= 2 sustained 2s → kill). Missing sysctl (linux) reads 1.
  const ulimits = `ulimit -t ${cpuSec} 2>/dev/null; ulimit -v ${virtualLimitKb} 2>/dev/null; ulimit -d ${virtualLimitKb} 2>/dev/null
pgid=$$
(
  t=0
  warn=0
  while kill -0 "$pgid" 2>/dev/null; do
    rss=$(ps -axo pgid=,rss= 2>/dev/null | awk -v g="$pgid" '$1==g {s+=$2} END {print s+0}')
    lvl=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)
    case "$lvl" in (*[!0-9]*|"") lvl=1;; esac
    if [ "$lvl" -ge 2 ]; then warn=$((warn+1)); else warn=0; fi
    if [ "\${rss:-0}" -gt ${limitKb} ] || [ "$t" -ge ${maxTicks} ] || [ "$lvl" -ge 4 ] || [ "$warn" -ge 8 ]; then
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
      else if (guardKill === "footprint")
        stderr += `\n[guard] SIGKILL: process tree exceeded ${memMb} MB phys_footprint (RSS + compressed)`;
      else if (guardKill === "pressure")
        stderr += `\n[guard] SIGKILL: system memory pressure — guarded tree shed fail-closed`;
      else if (guardKill === "global-memory")
        stderr += `\n[guard] SIGKILL: combined guarded processes exceeded ${Math.floor(GLOBAL_MEM_KB / 1024)} MB RSS (largest tree killed)`;
      else if (guardKill === "timeout") stderr += `\n[guard] SIGKILL: exceeded ${timeoutMs} ms`;
      else if (guardKill === "watchdog-blind")
        stderr += `\n[guard] SIGKILL: ps unresponsive, watchdog blind — killed fail-closed`;
      else if (signal === "SIGKILL")
        // unattributed SIGKILL: the in-pgid shell watchdog (RSS/tick/pressure
        // breach) or jetsam got there before the node poll did
        stderr += `\n[guard] SIGKILL (unattributed — in-pgid watchdog or external OOM kill)`;
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
  onBreach: (rssMb: number, reason?: "memory" | "pressure") => void
): () => void {
  // No ps(1) on Windows: the walk below would spawn a failing process every
  // 100ms forever. Same reasoning as windowsRun — no memory layer there.
  if (process.platform === "win32") return () => {};
  const limitKb = memMb * 1024;
  let stopped = false;
  let notified = false;
  let ticks = 0;
  let treeFootprintKb = 0;
  let fpInFlight = false;
  let warnTicksLocal = 0;
  const tick = () => {
    if (stopped) return;
    execFile("ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 16 * 1024 * 1024 }, async (err, out) => {
      if (stopped) return;
      ticks++;
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
        // 1Hz phys_footprint over the same tree — compressed pages leave RSS
        if (ticks % FOOTPRINT_EVERY_TICKS === 0 && !fpInFlight) {
          fpInFlight = true;
          void footprintSums(new Map([[rootPid, [...tree]]])).then(sums => {
            if (sums !== null) treeFootprintKb = sums.get(rootPid) ?? 0;
            fpInFlight = false;
          });
        }
        const totalKb = Math.max(
          tree.reduce((s, p) => s + (rss.get(p) ?? 0), 0),
          treeFootprintKb
        );
        const level = await pressureLevel();
        if (level >= 2) warnTicksLocal++;
        else warnTicksLocal = 0;
        const pressureKill = level >= 4 || warnTicksLocal >= PRESSURE_SUSTAIN_TICKS;
        if (totalKb > limitKb || pressureKill) {
          // keep killing every tick until stop() — catches fork races
          for (const p of tree) {
            try {
              process.kill(p, "SIGKILL");
            } catch {}
          }
          if (!notified) {
            notified = true;
            onBreach(Math.round(totalKb / 1024), totalKb > limitKb ? "memory" : "pressure");
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
  let virtualMemMb: number | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === "--mem-mb") memMb = Number(argv[++i]);
    else if (argv[i] === "--virtual-mem-mb") virtualMemMb = Number(argv[++i]);
    else if (argv[i] === "--timeout-s") timeoutMs = Number(argv[++i]) * 1000;
    else if (argv[i] === "--") {
      i++;
      break;
    } else break;
  }
  const [cmd, ...rest] = argv.slice(i);
  if (!cmd) {
    console.error("usage: bun scripts/guard.ts [--mem-mb N] [--virtual-mem-mb N] [--timeout-s N] -- cmd args...");
    process.exit(2);
  }
  const r = await guardedRun(cmd, rest, { memMb, virtualMemMb, timeoutMs, inheritStdio: true });
  if (r.guardKill) console.error(r.stderr.trim());
  process.exit(r.signal ? 137 : r.code);
}
