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
  for (const f of [libPath, headerPath, join(dir, "consumer.c"), join(dir, "consumer"), join(dir, "opsconsumer.c"), join(dir, "opsconsumer")]) {
    try { unlinkSync(f); } catch {}
  }
});

describe("header generation", () => {
  test("include guard + standard headers + extern C", () => {
    expect(header).toContain("#ifndef MILO_LIBHEADERLIB_H");
    expect(header).toContain("#include <stdint.h>");
    expect(header).toContain(`extern "C" {`);
  });

  // `pub` is the API boundary. The header used to be built from `userFnNames`, which is
  // every fn in the entry file regardless of visibility, so private helpers were published
  // as linkable C entry points.
  test("non-pub functions are not declared", () => {
    expect(header).toContain("int32_t add(");
    expect(header).not.toContain("privateBump");
  });

  // The symbol table follows the header: a C caller could hand-declare `privateBump` and
  // link it while the archive still gave every entry-file fn external linkage.
  test("non-pub functions are not exported symbols either", () => {
    const syms = execSync(`nm ${libPath}`, { encoding: "utf-8" });
    expect(syms).toMatch(/ T _?add\b/);
    expect(syms).not.toMatch(/ T _?privateBump\b/);
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

  // The ABI claim `?&mut T` makes, checked against the published header rather than
  // asserted in prose: one pointer parameter, spelled the same as a raw `*Point`.
  test("nullable extern reference is declared as a plain pointer", () => {
    expect(header).toContain("int32_t point_bump(Point* p);");
  });

  // The C spelling of a fn-pointer field. A Milo fn value is a { code, env } pair; this
  // field is the code pointer alone, which is the only thing that has a C spelling.
  test("extern struct fn-pointer field is declared as a C function pointer", () => {
    expect(header).toContain("int32_t (*read)(uint8_t*, int32_t);");
    expect(header).toContain("int32_t ops_apply(Ops* ops, int32_t v);");
  });

  // `@cName("type") kind: i32` publishes the C name: a C consumer writes `t.type`.
  test("a @cName field is declared under its C name", () => {
    expect(header).toContain("int32_t type;");
    expect(header).not.toContain("int32_t kind;");
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
    /* the nullable extern reference, called the way C calls it: a real object, then NULL.
       If the parameter were anything but a bare pointer this would not compile. */
    Point p = { 41, 7 };
    printf("%d %d %d\\n", point_bump(&p), p.x, point_bump(NULL));
    return 0;
}
`);
    // syntax check first (fast, no toolchain link deps)
    execSync(`clang -fsyntax-only -I ${dir} ${consumer}`, { stdio: ["pipe", "pipe", "pipe"] });
    // then link against the milo static lib and run
    const bin = join(dir, "consumer");
    execSync(`clang -I ${dir} ${consumer} ${libPath} -o ${bin}`, { stdio: ["pipe", "pipe", "pipe"] });
    const out = execSync(bin, { encoding: "utf-8" }).trim();
    expect(out).toBe("7 10.0 30\n42 42 -1");
  });

  // The generated header is Milo describing itself, so a C consumer that includes it
  // cannot disagree with Milo about the layout. This one does NOT include it: it writes
  // the ops table out by hand the way a real C header would, fills the slot with a C
  // function, and calls in. A fat { code, env } field or a call that prepends an
  // environment argument fails here and nowhere in the fixture lane.
  test("a C consumer with its own struct declaration drives the fn-pointer field", () => {
    const consumer = join(dir, "opsconsumer.c");
    writeFileSync(consumer, `#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

/* Hand-written, exactly as a C library would publish it. */
typedef struct { int32_t (*read)(uint8_t *, int32_t); } Ops;
extern int32_t ops_apply(Ops *ops, int32_t v);

_Static_assert(sizeof(Ops) == sizeof(void *), "the ops table is one pointer wide");

static int32_t c_triple(uint8_t *p, int32_t n) { (void)p; return n * 3; }

int main(void) {
    Ops ops = { c_triple };
    Ops empty = { NULL };
    printf("%d %d\\n", ops_apply(&ops, 14), ops_apply(&empty, 14));
    return 0;
}
`);
    execSync(`clang -fsyntax-only ${consumer}`, { stdio: ["pipe", "pipe", "pipe"] });
    const bin = join(dir, "opsconsumer");
    execSync(`clang ${consumer} ${libPath} -o ${bin}`, { stdio: ["pipe", "pipe", "pipe"] });
    expect(execSync(bin, { encoding: "utf-8" }).trim()).toBe("42 -1");
  });

  // `ar r` merges rather than replaces, and each build names its temp object randomly,
  // so a rebuild over an existing archive used to stack a second copy of every symbol.
  test("rebuilding over an existing archive replaces it", () => {
    execSync(`bun run ${COMPILER} build-lib ${FIXTURE} -o ${libPath}`, { stdio: ["pipe", "pipe", "pipe"] });
    const members = execSync(`ar t ${libPath}`, { encoding: "utf-8" })
      .split("\n").filter(l => l.endsWith(".o"));
    expect(members.length).toBe(1);
  });
});
