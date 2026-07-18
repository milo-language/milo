// Serializes `bun test` runs on this machine. Two full-suite runs at once thrash the
// box (the guard is fail-closed on memory pressure and SIGKILLs the largest tree),
// which surfaces as bogus timeout/empty-stdout "failures" that are really contention.
// bun runs this preload ONCE per test process before any test file loads, so a second
// `bun test` blocks here until the first releases — they run one at a time, not slower.
//
// Mechanism: an atomic O_EXCL lockfile holding the owner pid. A dead owner's lock is
// stolen (crash-safe). Fail-open: after MAX_WAIT we proceed anyway so a wedged lock can
// never permanently block testing.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { afterAll } from "bun:test";

const LOCK = join(import.meta.dir, "..", ".test-suite.lock");
const POLL_MS = 500;
const MAX_WAIT_MS = 45 * 60 * 1000; // safety valve — longer than the full suite
const STALE_MS = 60 * 60 * 1000;    // an owner older than this with a live-looking pid is force-stolen

function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }   // signal 0 = existence probe
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = alive but not ours; ESRCH = dead
}

function tryAcquire(): boolean {
  try {
    const fd = openSync(LOCK, "wx"); // wx = O_CREAT|O_EXCL — fails if the file exists
    writeSync(fd, `${process.pid} ${Date.now()}`);
    closeSync(fd);
    return true;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    // Held. Steal only if the owner is gone or the lock is implausibly old.
    try {
      const [pidStr, tsStr] = readFileSync(LOCK, "utf-8").trim().split(" ");
      const pid = Number(pidStr), age = Date.now() - Number(tsStr);
      if (!ownerAlive(pid) || age > STALE_MS) { unlinkSync(LOCK); return tryAcquire(); }
    } catch { /* owner released between our open and read — just retry */ }
    return false;
  }
}

function release() { try { unlinkSync(LOCK); } catch { /* already gone */ } }

const start = Date.now();
let waited = false;
while (!tryAcquire()) {
  if (Date.now() - start > MAX_WAIT_MS) {
    console.error(`[test-lock] waited ${Math.round((Date.now() - start) / 1000)}s — proceeding without the lock`);
    break;
  }
  if (!waited) { console.error(`[test-lock] another test run holds ${LOCK} — waiting…`); waited = true; }
  Bun.sleepSync(POLL_MS);
}
if (waited) console.error(`[test-lock] acquired after ${Math.round((Date.now() - start) / 1000)}s`);

// Release paths. afterAll is the reliable one in bun's runner (the bare process
// "exit" listener does not fire from a preload); the process hooks are backups, and
// stale-steal is the final safety net if every release is somehow skipped.
afterAll(release);
process.on("exit", release);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { release(); process.exit(130); });
}
