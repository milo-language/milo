// The @cLayout/@cSig verification cache (src/cdeclcache.ts): a passing guard TU is not
// re-compiled on the next build, a change to any header it read re-runs the check, and a
// failing check is never cached. Each test uses a private cache root and a private header
// reached through CPATH, and reads MILO_VERBOSE's report rather than timing anything.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDepfile } from "../src/cdeclcache";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const PROGRAM = `@cLayout("struct milo_probe", "milo_probe.h")
extern struct Probe {
    a: i32,
    b: i64,
}

fn main() {
    print(sizeOf<Probe>())
}
`;

const GOOD_HEADER = `struct milo_probe { int a; long long b; };\n`;
const BAD_HEADER = `struct milo_probe { int a; int b; };\n`;

function build(dir: string): { status: number | null; stderr: string } {
  const r = spawnSync("bun", ["run", MAIN, "build", join(dir, "p.milo"), "-o", join(dir, "p")], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: join(dir, "cache"), CPATH: join(dir, "inc"), MILO_VERBOSE: "1", MILO_OBJ_CACHE: "1" },
  });
  return { status: r.status, stderr: r.stderr };
}

function setup(header: string): string {
  const dir = mkdtempSync(join(tmpdir(), "milo-cdeclcache-"));
  spawnSync("mkdir", ["-p", join(dir, "inc")]);
  writeFileSync(join(dir, "inc", "milo_probe.h"), header);
  writeFileSync(join(dir, "p.milo"), PROGRAM);
  return dir;
}

test("an unchanged passing verification is a hit on the second build", () => {
  const dir = setup(GOOD_HEADER);
  try {
    const first = build(dir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).not.toContain("cdeclcache: hit");
    const second = build(dir);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toContain("cdeclcache: hit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing a header the guard read re-runs the check and catches the drift", () => {
  const dir = setup(GOOD_HEADER);
  try {
    expect(build(dir).status).toBe(0);
    // A content-only change (same layout) must still miss: the cache cannot know it is benign.
    writeFileSync(join(dir, "inc", "milo_probe.h"), `/* v2 */\n${GOOD_HEADER}`);
    const benign = build(dir);
    expect(benign.status, benign.stderr).toBe(0);
    expect(benign.stderr).not.toContain("cdeclcache: hit");
    // The library "upgrades" and b shrinks: the warm cache must not hide it.
    writeFileSync(join(dir, "inc", "milo_probe.h"), BAD_HEADER);
    const drifted = build(dir);
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("error[c-decl]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing verification is never cached", () => {
  const dir = setup(BAD_HEADER);
  try {
    for (let i = 0; i < 2; i++) {
      const r = build(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("error[c-decl]");
      expect(r.stderr).not.toContain("cdeclcache: hit");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("depfile parsing joins continuations and keeps escaped spaces", () => {
  const deps = parseDepfile("x.o: a.c \\\n  /usr/include/stdio.h \\\n  /opt/my\\ dir/h.h\n");
  expect(deps).toEqual(["a.c", "/usr/include/stdio.h", "/opt/my dir/h.h"]);
});
