// Holds the invariant that makes `checkThreadBoundary` sound: every OS thread a Milo
// program can create is spawned by a function marked `@thread`.
//
// The checker exempts green tasks from the mutable-global race rule because the scheduler
// is cooperative and single-threaded, so two green tasks never run at the same instant.
// That exemption is correct today and silently becomes unsound the moment the runtime
// gains a second scheduler thread (work stealing, a parallel poll loop, a helper worker) —
// and nothing would fail, because the rule would simply stop being applied to code that
// now races. An assumption no test can notice being broken is the worst kind, so this
// test is the tripwire: add a thread-creating call outside a `@thread` function and it
// goes red, pointing at the exemption that has to be revisited.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STD = join(import.meta.dir, "..", "std");

// Anything that hands control to a new OS thread.
const SPAWNERS = [/\bpthread_create\s*\(/, /\bCreateThread\s*\(/, /\b_beginthreadex\s*\(/];

// Spawn sites outside a @thread fn, each with who checks the closure instead. Adding a name
// here means someone audited that path, so keep this short.
const AUDITED: Record<string, string> = {
  spawnWorkerAudited: "its only caller, std/http serveRouterFactory, is @thread and checked the closure where it entered",
};

/** Call sites of a thread spawner, paired with the function that encloses them. */
function spawnCallSites(): { file: string; line: number; fn: string; annotated: boolean }[] {
  const out: { file: string; line: number; fn: string; annotated: boolean }[] = [];
  for (const name of readdirSync(STD).filter(f => f.endsWith(".milo"))) {
    const lines = readFileSync(join(STD, name), "utf8").split("\n");
    let fn = "<file scope>";
    let annotated = false;
    let pendingThread = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("@thread")) { pendingThread = true; return; }
      const m = /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
      if (m) {
        fn = m[1]!;
        annotated = pendingThread;
        pendingThread = false;
        return;
      }
      // An attribute other than @thread, or any other decl, ends a pending annotation.
      if (t.startsWith("@")) pendingThread = false;
      // A declaration is not a call, and the Windows shim named pthread_create is the
      // implementation of the spawner, not a second door into one.
      if (t.startsWith("extern fn") || t.includes("pub extern fn") || m) return;
      if (fn === "pthread_create") return;
      if (SPAWNERS.some(re => re.test(line))) {
        out.push({ file: name, line: i + 1, fn, annotated });
      }
    });
  }
  return out;
}

describe("thread door invariant", () => {
  test("every OS-thread spawn site sits in a @thread function", () => {
    const undeclared = spawnCallSites()
      .filter(s => !s.annotated && !(s.fn in AUDITED))
      .map(s => `std/${s.file}:${s.line} in '${s.fn}' spawns an OS thread but is not @thread`);
    expect(undeclared).toEqual([]);
  });

  test("at least one spawn site exists, so the scan above cannot pass by finding nothing", () => {
    // Without this, renaming pthread_create would make the test above vacuously green:
    // zero sites checked, zero undeclared, reported as healthy forever.
    expect(spawnCallSites().length).toBeGreaterThan(0);
  });
});
