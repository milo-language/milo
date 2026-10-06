// Gate on the platform suffix split: `std/x.darwin.milo`, `std/x.linux.milo` and
// `std/x.windows.milo` must export the SAME public surface.
//
// The resolver picks an arm by target OS and there is no `#[cfg]`, so the filename
// suffix is the whole mechanism (CLAUDE.md §Layout). A name only one arm provides is
// not a smaller feature set — it is a program that compiles on your laptop and fails to
// resolve in CI, and nothing in the repo compared the arms before this.
//
// Deliberate asymmetry is real: kqueue filter constants have no epoll analogue and vice
// versa. Those go in ARM_ONLY below, named and reasoned, so the exception is a decision
// on the record rather than a silence.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const STD = join(ROOT, "std");

// wasm is a partial target by design (no processes, no sockets); it is compared
// separately from the three full ones so its gaps do not mask a real posix/windows gap.
const FULL_ARMS = ["darwin", "linux", "windows"] as const;
type Arm = (typeof FULL_ARMS)[number];

// A name is exempt only if it is a RAW OS BINDING — `pub extern` in every arm that
// declares it. `GetConsoleMode` and `kevent` exist on one platform because the syscall
// does, and demanding a Win32 name on darwin would mean stubbing a function nothing
// portable calls. Anything an arm writes in Milo is the portable surface and must match,
// which is not the same as "not extern": std/platform.windows implements `access`,
// `close` and `mmap` as Milo shims where posix binds them directly, so both spellings of
// one name have to count as the same name.
const EXPORT = /^pub (extern )?(?:fn|struct|enum|type|interface|trait|let|var) ([A-Za-z_][A-Za-z0-9_]*)/gm;

interface Exports { all: Set<string>; externOnly: Set<string> }

function exportsOf(file: string): Exports {
  const src = readFileSync(join(STD, file), "utf-8");
  const all = new Set<string>();
  const externOnly = new Set<string>();
  const inMilo = new Set<string>();
  for (const m of src.matchAll(new RegExp(EXPORT.source, "gm"))) {
    const name = m[2]!;
    all.add(name);
    (m[1] ? externOnly : inMilo).add(name);
  }
  for (const n of inMilo) externOnly.delete(n);
  return { all, externOnly };
}

function families(): Map<string, Partial<Record<Arm, string>>> {
  const out = new Map<string, Partial<Record<Arm, string>>>();
  for (const f of readdirSync(STD)) {
    const m = /^(.*)\.(darwin|linux|windows)\.milo$/.exec(f);
    if (!m) continue;
    const fam = out.get(m[1]!) ?? {};
    fam[m[2]! as Arm] = f;
    out.set(m[1]!, fam);
  }
  return out;
}

// name -> the arms that legitimately provide it alone, with the reason.
const ARM_ONLY: Record<string, { arms: Arm[]; why: string }> = {};
for (const [names, arms, why] of [
  [["evAdd", "evClear", "evDelete", "evEnable", "evOneshot", "evfiltRead", "evfiltUser", "evfiltWrite", "noteTrigger", "keventSize"],
   ["darwin"], "kqueue filter/flag constants — epoll and IOCP have no analogue"],
  [["epollCtlAdd", "epollCtlDel", "epollCtlMod", "epollErr", "epollHup", "epollIn", "epollOneshot", "epollOut",
    "epollEventSize", "efdCloexec", "efdNonblock"],
   ["linux"], "epoll/eventfd constants and layout — kqueue and IOCP have no analogue"],
  [["Kevent"], ["darwin"], "the kqueue event struct"],
  [["EpollEvent"], ["linux"], "the epoll event struct"],
  [["wakeupIdentBase"], ["darwin", "windows"],
   "an identifier base for user-triggered wakeups; linux wakes through an eventfd, which needs no identifier space"],
  [["fionbio", "maskRead", "maskWrite", "maskToNet", "winLoopTableCap",
    "wlCap", "wlGet", "wlSet", "wlSize", "wlMaskIdx", "wlSockIdx", "wlWevtIdx"],
   ["windows"], "WSAEventSelect wait-list table and its ioctl/mask constants — the IOCP readiness path has no posix analogue"],
  [["tiocgwinsz", "tiocswinsz", "tiocsctty"], ["darwin", "linux"],
   "termios window-size and controlling-terminal ioctls; the Windows console sizes through GetConsoleScreenBufferInfo"],
  [["freeArgv"], ["darwin", "linux"],
   "frees the C argv built for execvp; the Windows pty passes one command line string to CreateProcess and never builds an argv"],
  [["REG_STARTEND"], ["darwin", "linux"],
   "a POSIX regexec flag; the Windows arm does not go through <regex.h>"],
  [["getConsoleModeOf", "rawModeFrom", "stdinHandle"], ["windows"],
   "console-mode helpers over HANDLEs; the posix arms configure a tty through termios instead"],
] as const) {
  for (const n of names) ARM_ONLY[n] = { arms: [...arms] as Arm[], why };
}

const SAFE_WINDOWS_SHIMS = new Set<string>([
  "access", "dlclose", "dlerror", "dlopen", "dlsym", "getcontext", "getpid", "gettimeofday", "lseek",
  "makecontext", "mmap", "mprotect", "munmap", "pipe", "read", "swapcontext", "usleep", "write",
  "pthread_cond_broadcast", "pthread_cond_destroy", "pthread_cond_init", "pthread_cond_signal",
  "pthread_cond_wait", "pthread_create", "pthread_detach", "pthread_join", "pthread_mutex_destroy",
  "pthread_mutex_init", "pthread_mutex_lock", "pthread_mutex_unlock", "pthread_rwlock_destroy",
  "pthread_rwlock_init", "pthread_rwlock_rdlock", "pthread_rwlock_unlock", "pthread_rwlock_wrlock",
  "pthread_self",
]);

describe("platform arm parity", () => {
  const fams = families();

  test("the scan finds the platform families", () => {
    expect(fams.size).toBeGreaterThan(5);
  });

  for (const [fam, arms] of [...fams].sort()) {
    const present = FULL_ARMS.filter(a => arms[a]);

    test(`std/${fam} exports the same names on ${present.join(", ")}`, () => {
      const byArm = new Map<Arm, Exports>(present.map(a => [a, exportsOf(arms[a]!)]));
      // A file whose exports do not parse would make every comparison trivially equal.
      for (const [arm, e] of byArm) expect(`${fam}.${arm}: ${e.all.size}`).not.toBe(`${fam}.${arm}: 0`);

      const all = new Set([...byArm.values()].flatMap(e => [...e.all]));
      const gaps: string[] = [];
      for (const name of [...all].sort()) {
        const has = present.filter(a => byArm.get(a)!.all.has(name));
        if (has.length === present.length) continue;
        // Raw OS binding: extern in every arm that has it at all.
        if (has.every(a => byArm.get(a)!.externOnly.has(name))) continue;
        const allowed = ARM_ONLY[name];
        if (allowed && has.length === allowed.arms.length && allowed.arms.every(a => has.includes(a))) continue;
        gaps.push(`${name} (only on ${has.join(", ")})`);
      }
      expect(gaps).toEqual([]);
    });
  }

  // Same names are not enough: a name the posix arms export as a bare extern needs
  // `unsafe` there (the extern-call rule), so a Windows Milo shim of it must be `@unsafe`
  // too, or a program that closes an fd some owner still holds compiles on Windows only.
  // SAFE_WINDOWS_SHIMS is the ratchet of shims not yet aligned; it may only shrink.
  test("a Windows shim of a posix extern is @unsafe", () => {
    const unaligned: string[] = [];
    const seen = new Set<string>();
    for (const [fam, arms] of [...fams].sort()) {
      if (!arms.windows || !arms.darwin || !arms.linux) continue;
      const posix = [arms.darwin, arms.linux].map(f => exportsOf(f).externOnly);
      const win = readFileSync(join(STD, arms.windows), "utf-8");
      for (const m of win.matchAll(/((?:^@\w+.*\n)*)^pub fn ([A-Za-z_][A-Za-z0-9_]*)/gm)) {
        const name = m[2]!;
        if (!posix.every(s => s.has(name))) continue;
        seen.add(name);
        const isUnsafe = /^@unsafe\b/m.test(m[1]!);
        if (!isUnsafe && !SAFE_WINDOWS_SHIMS.has(name)) unaligned.push(`${fam}.${name}`);
        if (isUnsafe && SAFE_WINDOWS_SHIMS.has(name)) unaligned.push(`${fam}.${name} (aligned now: drop it from SAFE_WINDOWS_SHIMS)`);
      }
    }
    expect(seen.has("close")).toBe(true);
    expect(unaligned).toEqual([]);
    expect([...SAFE_WINDOWS_SHIMS].filter(n => !seen.has(n))).toEqual([]);
  });

  test("no ARM_ONLY entry is stale", () => {
    // An allowance for a name that no longer exists, or that every arm now provides,
    // is an exception outliving its reason.
    const everywhere = new Map<string, Arm[]>();
    for (const [, arms] of fams) {
      for (const a of FULL_ARMS) {
        if (!arms[a]) continue;
        for (const n of exportsOf(arms[a]!).all) everywhere.set(n, [...(everywhere.get(n) ?? []), a]);
      }
    }
    const stale = Object.entries(ARM_ONLY)
      .filter(([n, v]) => {
        const has = everywhere.get(n);
        return has === undefined || has.length !== v.arms.length;
      })
      .map(([n]) => n);
    expect(stale).toEqual([]);
  });
});
