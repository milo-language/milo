// One rule, checked across every container that can hold a non-Copy value.
//
// The bug this exists to prevent: "move a non-Copy element out of a borrow" was
// enforced in checker.ts for FIELDS and in codegen.ts for INDICES, so the two
// drifted — `b.v` was a hard error while `arr[0]` silently loaded in place and
// double-freed (fixed 2026-08-01). Nothing tested the two spellings against each
// other, so the divergence was invisible for as long as it existed.
//
// This is a GOLDEN matrix, not an equality assertion: the cells legitimately
// differ today (field errors, index clones). The point is that every cell is
// written down in one place, so a change to any container's behaviour shows up
// as a diff here, and a newly added container has to declare its cell rather
// than inheriting whichever code path it happens to hit.
//
// Update the golden with MILO_UPDATE_MATRIX=1 bun test tests/aliasingMatrix.test.ts
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { guardedRun, type RunResult } from "../scripts/guard";

const MILO_ROOT = join(import.meta.dir, "..");
const GOLDEN = join(import.meta.dir, "aliasing-matrix.golden.md");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";
const WORK = mkdtempSync(join(tmpdir(), "milo-matrix-"));
const MILOC = join(WORK, "miloc") + EXE;
const CHILD_ENV = { ...process.env, MILO_ROOT };

afterAll(() => {
  try { rmSync(WORK, { recursive: true, force: true }); } catch {}
});

// Each container supplies the same four probes over a non-Copy element type
// (string — a heap buffer, so an aliased copy double-frees and an independent
// one costs a malloc). Empty string = the probe is not expressible for that
// container and the cell records why.
type Probe = "moveOutOfBorrow" | "extractThenMutate" | "consumeInline" | "mutateWhileBorrowed";

const CONTAINERS: Record<string, Record<Probe, string>> = {
  // A struct field: the spelling the checker rejects outright.
  field: {
    moveOutOfBorrow: `
struct Box { v: string }
fn peek(b: &Box): string { return b.v }
fn main(): i32 {
    let b = Box { v: $"heap {0}" }
    print(peek(b))
    return 0
}`,
    // The explicit `.clone()` is the point, not an unfair handicap: a bare
    // `let taken = b.v` is rejected, so a field is the one container where the
    // copy has to be asked for. Every other row gets the same copy for free.
    extractThenMutate: `
struct Box { v: string }
fn main(): i32 {
    var b = Box { v: $"heap {0}" }
    let taken = b.v.clone()
    b.v = $"replaced {1}"
    print(taken)
    print(b.v)
    return 0
}`,
    consumeInline: `
struct Box { v: string }
fn main(): i32 {
    let b = Box { v: $"heap {0}" }
    var n = 0
    var i = 0
    while i < 50 {
        n = n + b.v.len
        i = i + 1
    }
    print($"{n}")
    return 0
}`,
    mutateWhileBorrowed: `
struct Box { v: string }
fn bump(b: &mut Box, s: &string): void { b.v = $"clobber {1}"; print(s) }
fn main(): i32 {
    var b = Box { v: $"heap {0}" }
    bump(&mut b, b.v)
    return 0
}`,
  },
  vec: {
    moveOutOfBorrow: `
fn peek(v: &Vec<string>): string { return v[0] }
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    print(peek(v))
    return 0
}`,
    extractThenMutate: `
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    let taken = v[0]
    v[0] = $"replaced {1}"
    print(taken)
    print(v[0])
    return 0
}`,
    consumeInline: `
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    var n = 0
    var i = 0
    while i < 50 {
        n = n + v[0].len
        i = i + 1
    }
    print($"{n}")
    return 0
}`,
    mutateWhileBorrowed: `
fn grow(v: &mut Vec<string>, s: &[string]): void { v.push($"clobber {1}"); print(s[0]) }
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    grow(&mut v, v[0..1])
    return 0
}`,
  },
  // A sized array: the arm that had no clone and double-freed.
  array: {
    moveOutOfBorrow: `
fn peek(a: &[string; 2]): string { return a[0] }
fn main(): i32 {
    var a: [string; 2] = [$"heap {0}", $"heap {1}"]
    print(peek(a))
    return 0
}`,
    extractThenMutate: `
fn main(): i32 {
    var a: [string; 2] = [$"heap {0}", $"heap {1}"]
    let taken = a[0]
    a[0] = $"replaced {1}"
    print(taken)
    print(a[0])
    return 0
}`,
    consumeInline: `
fn main(): i32 {
    var a: [string; 2] = [$"heap {0}", $"heap {1}"]
    var n = 0
    var i = 0
    while i < 50 {
        n = n + a[0].len
        i = i + 1
    }
    print($"{n}")
    return 0
}`,
    mutateWhileBorrowed: `
fn clobber(a: &mut [string; 2], s: &string): void { a[0] = $"clobber {1}"; print(s) }
fn main(): i32 {
    var a: [string; 2] = [$"heap {0}", $"heap {1}"]
    clobber(&mut a, a[1])
    return 0
}`,
  },
  slice: {
    moveOutOfBorrow: `
fn peek(s: &[string]): string { return s[0] }
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    print(peek(v[0..1]))
    return 0
}`,
    extractThenMutate: `
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    let s = v[0..1]
    let taken = s[0]
    v[0] = $"replaced {1}"
    print(taken)
    print(v[0])
    return 0
}`,
    consumeInline: `
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    let s = v[0..1]
    var n = 0
    var i = 0
    while i < 50 {
        n = n + s[0].len
        i = i + 1
    }
    print($"{n}")
    return 0
}`,
    mutateWhileBorrowed: `
fn main(): i32 {
    var v: Vec<string> = Vec.new()
    v.push($"heap {0}")
    let s = v[0..1]
    v.push($"clobber {1}")
    print(s[0])
    return 0
}`,
  },
  arena: {
    moveOutOfBorrow: `
from "std/arena" import { Arena, Handle }
fn peek(a: &Arena<string>, h: Handle<string>): string { return a.get(h)! }
fn main(): i32 {
    var a: Arena<string> = Arena<string>.new()
    let h = a.alloc($"heap {0}")
    print(peek(a, h))
    return 0
}`,
    extractThenMutate: `
from "std/arena" import { Arena }
fn main(): i32 {
    var a: Arena<string> = Arena<string>.new()
    let h = a.alloc($"heap {0}")
    let taken = a.get(h)!
    a.set(h, $"replaced {1}")
    print(taken)
    print(a.get(h)!)
    return 0
}`,
    consumeInline: `
from "std/arena" import { Arena }
fn main(): i32 {
    var a: Arena<string> = Arena<string>.new()
    let h = a.alloc($"heap {0}")
    var n = 0
    var i = 0
    while i < 50 {
        n = n + a.get(h)!.len
        i = i + 1
    }
    print($"{n}")
    return 0
}`,
    mutateWhileBorrowed: `
from "std/arena" import { Arena }
fn main(): i32 {
    var a: Arena<string> = Arena<string>.new()
    let h = a.alloc($"heap {0}")
    let taken = a.get(h)!
    a.clear()
    print(taken)
    print($"{a.valid(h)}")
    return 0
}`,
  },
};

const PROBES: Probe[] = ["moveOutOfBorrow", "extractThenMutate", "consumeInline", "mutateWhileBorrowed"];

// Collapse a run into one cell: what a user would observe, with anything
// host-specific (paths, temp names, line numbers) stripped so the golden is
// stable across machines and platforms.
function cell(build: RunResult, run: RunResult | null): string {
  if (build.code !== 0) {
    // Diagnostics are colourised; strip SGR before matching or the `error:`
    // marker is split across escape sequences.
    const plain = build.stderr.replace(/\x1b\[[0-9;]*m/g, "");
    const m = plain.match(/error:\s*(.+)/);
    return `compile error — ${m ? m[1].trim() : "build failed"}`;
  }
  if (!run) return "compiled (not run)";
  if (run.signal || run.code !== 0) return `RUNTIME FAILURE — ${run.signal ?? `exit ${run.code}`}`;
  return `runs — ${run.stdout.trim().split("\n").map(l => l.trim()).join(" / ")}`;
}

function renderGolden(rows: Record<string, Record<string, string>>): string {
  const head = `# Aliasing consistency matrix

Generated by \`tests/aliasingMatrix.test.ts\` — do not hand-edit; regenerate with
\`MILO_UPDATE_MATRIX=1 bun test tests/aliasingMatrix.test.ts\`.

Each cell is what a user observes when they apply one operation to one kind of
container holding a non-Copy element (\`string\`). Cells that disagree across a
row are places where the same concept is taught differently depending on the
spelling — that is the signal this file exists to surface, not a failure.

| container | ${PROBES.join(" | ")} |
|---|${PROBES.map(() => "---").join("|")}|
`;
  const body = Object.keys(CONTAINERS)
    .map(c => `| \`${c}\` | ${PROBES.map(p => rows[c][p]).join(" | ")} |`)
    .join("\n");
  return head + body + "\n";
}

describe("aliasing consistency matrix", () => {
  const rows: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    execSync(`bun build --compile ${join(MILO_ROOT, "src", "main.ts")} --outfile ${MILOC}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const [container, probes] of Object.entries(CONTAINERS)) {
      rows[container] = {};
      for (const probe of PROBES) {
        const src = probes[probe];
        const stem = `${container}_${probe}`;
        const srcPath = join(WORK, `${stem}.milo`);
        const binPath = join(WORK, stem);
        writeFileSync(srcPath, src.trimStart() + "\n");
        const build = await guardedRun(MILOC, ["build", srcPath, "-o", binPath], {
          env: CHILD_ENV, virtualMemMb: 8192,
        });
        const run = build.code === 0 && existsSync(binPath + EXE)
          ? await guardedRun(binPath + EXE, [], { env: CHILD_ENV, virtualMemMb: 8192 })
          : null;
        rows[container][probe] = cell(build, run);
      }
    }
  }, 600_000);

  test("matrix matches the committed golden", () => {
    const actual = renderGolden(rows);
    if (process.env.MILO_UPDATE_MATRIX) {
      writeFileSync(GOLDEN, actual);
      return;
    }
    expect(actual).toEqual(readFileSync(GOLDEN, "utf-8"));
  });

  // The one property that is NOT allowed to differ: no container may hand out an
  // aliased copy that the runtime then double-frees. A cell reading RUNTIME
  // FAILURE is a memory-safety bug in safe code no matter which container it is.
  test("no container aborts at runtime", () => {
    const failures: string[] = [];
    for (const container of Object.keys(CONTAINERS)) {
      for (const probe of PROBES) {
        if (rows[container][probe].startsWith("RUNTIME FAILURE")) {
          failures.push(`${container}.${probe}: ${rows[container][probe]}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
