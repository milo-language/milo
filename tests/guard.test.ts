// Locks the guarantee that guarded children cannot eat the machine. macOS
// enforces no rlimits, so scripts/guard.ts's RSS watchdog is the ONLY thing
// standing between a runaway milo-self allocation and an OS-crashing swap
// spiral — if these tests break, fix the guard before touching anything else.
import { test, expect } from "bun:test";
import { spawn } from "child_process";
import { guardedRun, monitorPidTree } from "../scripts/guard";

test("stops a runaway allocation at the memory cap, not at the timeout", async () => {
  // fill() touches the pages so they count toward RSS
  const hog = "const a=[]; while (true) a.push(new Uint8Array(64*1024*1024).fill(1));";
  const r = await guardedRun("bun", ["-e", hog], { memMb: 512, timeoutMs: 30000 });

  // The property that matters is the same everywhere: the hog is stopped, and stopped by
  // the MEMORY cap rather than by outliving the 30s wall clock. The mechanism is not the
  // same, and asserting the mechanism is what made this fail on Linux:
  //   macOS — enforces no rlimits at all (see scripts/guard.ts), so the polling watchdog
  //           is the only thing that can stop it: guardKill "memory" + SIGKILL.
  //   Linux — enforces `ulimit -v`, which guardedRun sets. The allocation fails inside
  //           the child and it dies on its own (SIGTRAP/abort) before the watchdog is
  //           needed. A kernel-side cap is a better outcome, not a worse one.
  expect(r.guardKill).not.toBe("timeout");
  expect(r.code !== 0 || r.signal !== null).toBe(true);
  if (process.platform === "darwin") {
    expect(r.guardKill).toBe("memory");
    expect(r.signal).toBe("SIGKILL");
  }
}, 35000);

test("kills a process that exceeds the wall-clock timeout", async () => {
  const r = await guardedRun("sleep", ["30"], { timeoutMs: 1500 });
  expect(r.guardKill).toBe("timeout");
  expect(r.signal).toBe("SIGKILL");
}, 10000);

test("passes through a well-behaved process untouched", async () => {
  const r = await guardedRun("echo", ["ok"]);
  expect(r.guardKill).toBeUndefined();
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("ok");
});

// The in-pgid shell watchdog must kill a hog even when THIS process (and its
// node-side poll) is gone: spawn a disposable parent that starts a guarded
// hog and immediately exits, then verify the hog's tree dies anyway.
test("shell watchdog survives parent death and still kills the hog", async () => {
  const parentScript = `
    const { guardedRun } = await import("${process.cwd()}/scripts/guard.ts");
    const hog = "const a=[]; while (true) a.push(new Uint8Array(64*1024*1024).fill(1));";
    guardedRun("bun", ["-e", hog], { memMb: 512, timeoutMs: 60000 });
    // give spawn a beat to register, then die without cleanup
    setTimeout(() => process.exit(0), 500);
  `;
  await new Promise<void>(res => {
    const p = spawn("bun", ["-e", parentScript], { stdio: "ignore" });
    p.on("close", () => res());
  });
  // orphaned hog must be gone within a few watchdog ticks
  const deadline = Date.now() + 15000;
  let hogAlive = true;
  while (Date.now() < deadline) {
    const out = await new Promise<string>(res => {
      const ps = spawn("ps", ["-axo", "command="]);
      let s = "";
      ps.stdout.on("data", d => (s += d));
      ps.on("close", () => res(s));
    });
    hogAlive = out.includes("64*1024*1024");
    if (!hogAlive) break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(hogAlive).toBe(false);
}, 30000);

// monitorPidTree guards `milo run` (non-detached, inherited stdio).
test("monitorPidTree kills an allocating child", async () => {
  const hog = "const a=[]; while (true) a.push(new Uint8Array(64*1024*1024).fill(1));";
  const child = spawn("bun", ["-e", hog], { stdio: "ignore" });
  let breachedMb = 0;
  const stop = monitorPidTree(child.pid!, 512, mb => (breachedMb = mb));
  const signal = await new Promise<string | null>(res => child.on("close", (_c, s) => res(s)));
  stop();
  expect(signal).toBe("SIGKILL");
  expect(breachedMb).toBeGreaterThan(512);
}, 30000);
