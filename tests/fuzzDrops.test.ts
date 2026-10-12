// A short, fixed-seed run of the destructor-accounting fuzzer as a regression gate.
//
// The invariant is that every value a program constructs is destroyed exactly once.
// It needs no per-shape expected count, which is what lets the generator compose
// shapes nobody enumerated: a value bound, left as a temporary, captured by a `move`
// closure, re-captured by a nested one, put in a container, carried through a break.
//
// This exists because the bugs here are invisible to every other oracle in the repo.
// A struct that owns no heap and never runs its destructor leaks nothing, so the leak
// ratchet and the ASan sweep both report clean while a user destructor is silently
// skipped. Three such bugs were found the day this was written. Every case is also
// built under ASan and the ownership ledger, and this is the only place the fuzzer
// runs on Linux (CI's macOS job runs it with a varying seed as `fuzz:drops`).
//
// Deliberately small (each case is ~5 CPU-s). The real hunt is
// `bun scripts/fuzz-drops.ts --cases 2000` with varied seeds, in a manual run.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

test("every constructed value is destroyed exactly once", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bun", [join(ROOT, "scripts", "fuzz-drops.ts"), "--cases", "20", "--seed", "3", "--reduce-probes", "0"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? 1;
  }
  expect(code, `destructor accounting did not balance:\n${out}`).toBe(0);

  // Not "did it exit 0" — a generator emitting invalid Milo would build nothing, check
  // nothing and still pass. Assert how many programs actually BUILT (and so ran).
  const built = /(\d+) built/.exec(out)?.[1];
  expect(Number(built ?? 0), `expected 20 programs to build, got: ${out}`).toBe(20);
}, 300_000);
