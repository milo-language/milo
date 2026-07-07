import { test, expect, describe, afterAll } from "bun:test";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "lib", "headerlib.milo");

const dir = mkdtempSync(join(tmpdir(), "milo-header-"));
const libPath = join(dir, "libheaderlib.a");
const headerPath = join(dir, "libheaderlib.h");

execSync(`bun run ${COMPILER} build-lib ${FIXTURE} -o ${libPath}`, { stdio: ["pipe", "pipe", "pipe"] });
const header = readFileSync(headerPath, "utf-8");

afterAll(() => {
  for (const f of [libPath, headerPath, join(dir, "consumer.c"), join(dir, "consumer")]) {
    try { unlinkSync(f); } catch {}
  }
});

describe("header generation", () => {
  test("include guard + standard headers + extern C", () => {
    expect(header).toContain("#ifndef MILO_LIBHEADERLIB_H");
    expect(header).toContain("#include <stdint.h>");
    expect(header).toContain(`extern "C" {`);
  });

  test("opaque extern type → forward typedef only", () => {
    expect(header).toContain("typedef struct Handle Handle;");
    expect(header).not.toContain("struct Handle {");
  });

  test("extern structs defined in dependency order (embedded before user)", () => {
    expect(header).toContain("struct Point {");
    expect(header).toContain("Point origin;");
    expect(header.indexOf("struct Point {")).toBeLessThan(header.indexOf("struct Rect {"));
  });

  test("exported scalar/pointer/fn-ptr prototypes", () => {
    expect(header).toContain("int32_t add(int32_t a, int32_t b);");
    expect(header).toContain("double scale(double v, double k);");
    expect(header).toContain("int64_t rect_area(Rect* r);");
    expect(header).toContain("int32_t apply(int32_t (*cb)(int32_t), int32_t v);");
  });

  test("non-C and by-value-struct functions are skipped with a comment", () => {
    expect(header).toContain("/* skipped make_point:");
    expect(header).toContain("/* skipped build:");
  });

  test("a C consumer compiles against the header and links the .a", () => {
    const consumer = join(dir, "consumer.c");
    writeFileSync(consumer, `#include "libheaderlib.h"
#include <stdio.h>
int main(void) {
    Rect r = { { 0, 0 }, 5, 6 };
    printf("%d %.1f %lld\\n", add(3, 4), scale(2.5, 4.0), (long long)rect_area(&r));
    return 0;
}
`);
    // syntax check first (fast, no toolchain link deps)
    execSync(`clang -fsyntax-only -I ${dir} ${consumer}`, { stdio: ["pipe", "pipe", "pipe"] });
    // then link against the milo static lib and run
    const bin = join(dir, "consumer");
    execSync(`clang -I ${dir} ${consumer} ${libPath} -o ${bin}`, { stdio: ["pipe", "pipe", "pipe"] });
    const out = execSync(bin, { encoding: "utf-8" }).trim();
    expect(out).toBe("7 10.0 30");
  });
});
