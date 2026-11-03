// Locks the guarantee that guarded children cannot eat the machine. macOS
// enforces no rlimits, so scripts/guard.ts's RSS watchdog is the ONLY thing
// standing between a runaway milo-self allocation and an OS-crashing swap
// spiral — if these tests break, fix the guard before touching anything else.
import { test, expect } from "bun:test";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  // Which LAYER stopped it is a race, not a contract, and asserting it is what keeps
  // breaking this test. The comment above already says so for Linux; a constrained macOS
  // runner behaves the same way. On CI this hog died on its own in 585ms with no
  // guardKill at all: the allocator refused before the polling watchdog's next tick. That
  // is the kernel doing the guard's job, which is a better outcome than being SIGKILLed,
  // and it is indistinguishable here from the guard working perfectly.
  //
  // So check the mechanism only when the watchdog is what acted. This does not thin the
  // guard's coverage: "monitorPidTree kills an allocating child" and "shell watchdog
  // survives parent death and still kills the hog" exercise the watchdog directly and do
  // not depend on winning that race. What this test owns is the end-to-end property, and
  // that is asserted unconditionally above.
  if (process.platform === "darwin" && r.guardKill !== undefined) {
    expect(r.guardKill).toBe("memory");
    expect(r.signal).toBe("SIGKILL");
  }
}, 35000);

test("kills a process that exceeds the wall-clock timeout", async () => {
  const r = await guardedRun("sleep", ["30"], { timeoutMs: 1500 });
  expect(r.guardKill).toBe("timeout");
  expect(r.signal).toBe("SIGKILL");
}, 10000);

// MILO_GUARD_PRESSURE_KILL_LEVEL has to move BOTH watchdogs. The in-pgid shell
// watchdog used to hardcode `-ge 2` while the node side read PRESSURE_KILL_LEVEL, so
// on a host whose idle pressure IS 2 — this dev Mac, routinely — raising the knob
// relented one layer and the other still SIGKILLed every tree older than
// PRESSURE_SUSTAIN_TICKS (2.5s). An 8s self-host build could not complete at all, and
// the failure looked like a compiler bug: exit 137, empty stdout, no diagnostic.
//
// This sleeps well past the sustain window, so it can only pass if the shell layer
// honours the knob too. It is deliberately NOT the 1.5s timeout case above, which
// passes either way because its timeout fires before the shell watchdog does.
// Runs guard.ts as a CLI subprocess, not via guardedRun(): PRESSURE_KILL_LEVEL is a
// module-load constant, so the env var has to be set before the guard's own import.
test("raising the pressure kill level moves the shell watchdog too", async () => {
  const code = await new Promise<number>(resolve => {
    const p = spawn("bun", [join(import.meta.dir, "..", "scripts", "guard.ts"),
      "--timeout-s", "20", "--", "sleep", "5"], {
      env: { ...process.env, MILO_GUARD_PRESSURE_KILL_LEVEL: "3" },
      stdio: "ignore",
    });
    p.on("exit", c => resolve(c ?? -1));
  });
  // 137 = SIGKILL: the shell watchdog ignored the knob and shed the tree at
  // PRESSURE_SUSTAIN_TICKS, long before the 20s timeout.
  expect(code).toBe(0);
}, 40000);

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

// A SIGKILL cannot flush stdio, so on a piped stdout every line a killed program
// printed used to die with it — the guard reported "SIGKILL: exceeded Nms" and the
// program's own trace of how far it got was gone, which is exactly the evidence you
// are killing it to collect. The guard now sets MILO_LINE_BUFFERED for its children
// and codegen honours it with setvbuf at entry. Both halves have to hold: this test
// fails if either the guard stops setting the variable or main stops reading it.
test("a program the guard kills still delivers what it printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-linebuf-"));
  try {
    const src = join(dir, "hang.milo");
    const bin = join(dir, "hang");
    // The counter must not overflow: with a bare `i + 1`, LLVM proves the loop's only exit
    // is the overflow trap and jumps straight to it, so the program ends before any kill.
    writeFileSync(src, 'fn main() {\n  print("printed before the hang")\n  var i = 0\n  while true { i = (i + 1) % 7 }\n}\n');
    execFileSync("bun", ["run", join(import.meta.dir, "..", "src", "main.ts"), "build", src, "-o", bin],
      { cwd: join(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });

    const killed = await guardedRun(bin, [], { timeoutMs: 2000 });
    expect(killed.guardKill).toBe("timeout");
    expect(killed.stdout).toContain("printed before the hang");

    // ...and the default stays block-buffered, so the opt-out is real and print keeps
    // costing one write per BUFFER on a pipe rather than one per line.
    const optedOut = await guardedRun(bin, [], { timeoutMs: 2000, env: { ...process.env, MILO_GUARD_NO_LINE_BUFFER: "1" } });
    expect(optedOut.guardKill).toBe("timeout");
    expect(optedOut.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
