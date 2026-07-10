// Locks the guarantee that guarded children cannot eat the machine. macOS
// enforces no rlimits, so scripts/guard.ts's RSS watchdog is the ONLY thing
// standing between a runaway milo-self allocation and an OS-crashing swap
// spiral — if these tests break, fix the guard before touching anything else.
import { test, expect } from "bun:test";
import { guardedRun } from "../scripts/guard";

test("kills a process tree that exceeds the memory cap", async () => {
  // fill() touches the pages so they count toward RSS
  const hog = "const a=[]; while (true) a.push(new Uint8Array(64*1024*1024).fill(1));";
  const r = await guardedRun("bun", ["-e", hog], { memMb: 512, timeoutMs: 30000 });
  expect(r.guardKill).toBe("memory");
  expect(r.signal).toBe("SIGKILL");
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
