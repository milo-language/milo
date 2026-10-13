// MILO_SYSROOT and MILO_CC, the cross-build knobs. With MILO_SYSROOT a hosted cross build reads the
// TARGET's headers for its @cLayout/@cSig guards instead of skipping them. Hermetic: the "sysroot" is a temp dir holding one
// header, and emit-obj runs the guards without linking, so no real target root is needed.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHostTarget } from "../src/target";

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

// Any hosted target that is not the host: both are LP64, so the good header is good on either.
const host = getHostTarget();
const CROSS = host.os === "linux" && host.arch === "x86_64" ? "linux-arm64" : "linux-x64";

function emitObj(header: string, sysroot: boolean): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "milo-sysroot-"));
  try {
    mkdirSync(join(dir, "root", "usr", "include"), { recursive: true });
    writeFileSync(join(dir, "root", "usr", "include", "milo_probe.h"), header);
    writeFileSync(join(dir, "p.milo"), PROGRAM);
    const env: Record<string, string> = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") } as any;
    delete env.MILO_SYSROOT;
    if (sysroot) env.MILO_SYSROOT = join(dir, "root");
    const r = spawnSync("bun", ["run", MAIN, "emit-obj", join(dir, "p.milo"), "-o", join(dir, "p.o"), `--target=${CROSS}`],
      { encoding: "utf8", env });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("without MILO_SYSROOT a cross build announces that its guards are skipped", () => {
  const r = emitObj(`struct milo_probe { int a; int b; };\n`, false);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).toContain("guards skipped");
});

test("with MILO_SYSROOT the guards read the sysroot's header and pass", () => {
  const r = emitObj(`struct milo_probe { int a; long long b; };\n`, true);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).not.toContain("guards skipped");
});

test("with MILO_SYSROOT a layout that disagrees with the sysroot's header fails the build", () => {
  const r = emitObj(`struct milo_probe { int a; int b; };\n`, true);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("error[c-decl]");
});

test("a MILO_CC that is not a working clang is an error, not a silent fallback", () => {
  const r = spawnSync("bun", ["run", MAIN, "build", join(import.meta.dir, "..", "examples", "hello.milo"), "-o", join(tmpdir(), `milo_cc_${process.pid}`)],
    { encoding: "utf8", env: { ...process.env, MILO_CC: "/nonexistent/clang" } });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("MILO_CC=/nonexistent/clang");
});
