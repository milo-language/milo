// DWARF line-table emission (M1). Guards three invariants:
//   1. -g IR is well-formed (passes the LLVM verifier via llvm-as)
//   2. debug metadata is absent by default (zero-cost when off)
//   3. the built binary yields a real source line table (lldb `b file.milo:N` binds)
// The lldb/llvm-as legs are skipped when the tools aren't on PATH so CI without an
// LLVM toolchain still runs the metadata-shape checks.
import { test, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { writeFileSync, unlinkSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

const SRC = `fn add(a: i32, b: i32): i32 {
    return a + b
}
fn main(): i32 {
    let x = add(19, 23)
    print(x)
    return 0
}
`;

function have(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "pipe" }).status === 0;
}

function emitIr(path: string, debug: boolean): string {
  const g = debug ? " -g" : "";
  return execSync(`bun run ${COMPILER} emit-ir ${path}${g}`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
}

test("-g emits DWARF metadata that passes the LLVM verifier", () => {
  const f = join(tmpdir(), "milo_dbg_verify.milo");
  writeFileSync(f, SRC);
  try {
    const ir = emitIr(f, true);
    expect(ir).toContain("!DICompileUnit");
    expect(ir).toContain("!DISubprogram");
    expect(ir).toContain("!DILocation");
    expect(ir).toContain(`!"Debug Info Version"`);
    // every user fn's define carries its subprogram
    expect(ir).toMatch(/define .*@main\(.*\) !dbg !\d+ \{/);
    expect(ir).toMatch(/define .*@add\(.*\) !dbg !\d+ \{/);
    // no leftover deferred markers made it into the final IR
    expect(ir).not.toContain(";MILODBG");

    if (have("llvm-as")) {
      const ll = join(tmpdir(), "milo_dbg_verify.ll");
      writeFileSync(ll, ir);
      // llvm-as runs the verifier; a bad !dbg scope / missing module flag fails here
      execSync(`llvm-as ${ll} -o /dev/null`, { stdio: ["pipe", "pipe", "pipe"] });
      unlinkSync(ll);
    }
  } finally {
    unlinkSync(f);
  }
});

test("no debug metadata without -g (zero-cost by default)", () => {
  const f = join(tmpdir(), "milo_dbg_off.milo");
  writeFileSync(f, SRC);
  try {
    const ir = emitIr(f, false);
    expect(ir).not.toContain("!DICompileUnit");
    expect(ir).not.toContain("!dbg");
    expect(ir).not.toContain(";MILODBG");
  } finally {
    unlinkSync(f);
  }
});

test("built binary carries a source line table lldb can bind to", () => {
  if (!have("lldb")) return; // toolchain-gated
  const f = join(tmpdir(), "milo_dbg_lldb.milo");
  const bin = join(tmpdir(), "milo_dbg_lldb");
  writeFileSync(f, SRC);
  try {
    execSync(`bun run ${COMPILER} build ${f} -o ${bin} -g`, { stdio: ["pipe", "pipe", "pipe"] });
    const r = spawnSync("lldb", [bin,
      "-o", "b milo_dbg_lldb.milo:5", "-o", "run", "-o", "frame info", "-o", "quit"],
      { stdio: "pipe" });
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    // breakpoint resolves to the .milo source line, and the stop reports that frame
    expect(out).toMatch(/Breakpoint 1: .*at milo_dbg_lldb\.milo:5/);
    expect(out).toMatch(/main at milo_dbg_lldb\.milo:5/);
  } finally {
    unlinkSync(f);
    try { rmSync(bin); } catch {}
    try { rmSync(`${bin}.dSYM`, { recursive: true, force: true }); } catch {}
    if (existsSync(`${bin}.dbg.o`)) unlinkSync(`${bin}.dbg.o`);
  }
});

const VARS_SRC = `struct Point { x: i32, y: i32 }
fn compute(a: i32, b: i32): i32 {
    let sum = a + b
    let flag = sum > 10
    let p = Point { x: 3, y: 4 }
    return sum + p.x
}
fn main(): i32 {
    print(compute(7, 8))
    return 0
}
`;

const ENUM_SRC = `enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Empty,
}
enum Color { Red, Green, Blue }
fn main(): i32 {
    let s = Shape.Rect(3.0, 4.0)
    let c = Color.Green
    match s {
        Shape.Rect(w, h) => { print(w * h) }
        _ => { print(0.0) }
    }
    print(c == Color.Green)
    return 0
}
`;

test("enums emit an enumerated tag and a per-variant payload union", () => {
  const f = join(tmpdir(), "milo_dbg_enum_ir.milo");
  writeFileSync(f, ENUM_SRC);
  try {
    const ir = emitIr(f, true);
    // tag is a real DWARF enumeration, not a bare i32
    expect(ir).toMatch(/DW_TAG_enumeration_type, name: "Shape\$tag"/);
    expect(ir).toContain(`!DIEnumerator(name: "Rect", value: 1)`);
    // payload is a union of per-variant types; fieldless Empty contributes no member
    expect(ir).toMatch(/DW_TAG_union_type, name: "Shape\$payload"/);
    expect(ir).toMatch(/DW_TAG_structure_type, name: "Shape::Rect"/); // multi-field variant
    expect(ir).not.toMatch(/DW_TAG_member, name: "Empty"/);
    // all-fieldless enum collapses to the enumeration itself — no phantom payload
    expect(ir).toMatch(/DW_TAG_enumeration_type, name: "Color"/);
    expect(ir).not.toContain(`"Color$payload"`);

    if (have("llvm-as")) {
      const ll = join(tmpdir(), "milo_dbg_enum_ir.ll");
      writeFileSync(ll, ir);
      execSync(`llvm-as ${ll} -o /dev/null`, { stdio: ["pipe", "pipe", "pipe"] });
      unlinkSync(ll);
    }
  } finally {
    unlinkSync(f);
  }
});

test("frame variable renders enum variants by name with typed payloads", () => {
  if (!have("lldb")) return; // toolchain-gated
  const f = join(tmpdir(), "milo_dbg_enum.milo");
  const bin = join(tmpdir(), "milo_dbg_enum");
  writeFileSync(f, ENUM_SRC);
  try {
    execSync(`bun run ${COMPILER} build ${f} -o ${bin} -g --debug`, { stdio: ["pipe", "pipe", "pipe"] });
    const r = spawnSync("lldb", [bin,
      "-o", "b milo_dbg_enum.milo:10", "-o", "run", "-o", "frame variable", "-o", "quit"],
      { stdio: "pipe" });
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    expect(out).toMatch(/tag = Rect/);              // named variant, not `tag = 1`
    expect(out).toMatch(/Rect = \(_0 = 3, _1 = 4\)/); // f64 payload, not raw i64 bit patterns
    expect(out).toMatch(/\(Color\)\s+c = Green/);   // fieldless enum: no payload slots at all
  } finally {
    unlinkSync(f);
    try { rmSync(bin); } catch {}
    try { rmSync(`${bin}.dSYM`, { recursive: true, force: true }); } catch {}
    if (existsSync(`${bin}.dbg.o`)) unlinkSync(`${bin}.dbg.o`);
  }
});

// -g --debug: -O0 keeps the allocas that dbg.declare binds, so locals are inspectable.
test("frame variable inspects Milo locals, params, and structs (M2)", () => {
  if (!have("lldb")) return; // toolchain-gated
  const f = join(tmpdir(), "milo_dbg_vars.milo");
  const bin = join(tmpdir(), "milo_dbg_vars");
  writeFileSync(f, VARS_SRC);
  try {
    execSync(`bun run ${COMPILER} build ${f} -o ${bin} -g --debug`, { stdio: ["pipe", "pipe", "pipe"] });
    const r = spawnSync("lldb", [bin,
      "-o", "b milo_dbg_vars.milo:6", "-o", "run", "-o", "frame variable", "-o", "quit"],
      { stdio: "pipe" });
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    // lldb renders a 4-byte signed DIBasicType as its own name `int`.
    expect(out).toMatch(/\(int\)\s+a = 7/);        // param
    expect(out).toMatch(/\(int\)\s+sum = 15/);     // computed scalar local
    expect(out).toMatch(/\(bool\)\s+flag = true/); // bool local
    expect(out).toMatch(/\(Point\)\s+p = /);       // struct, named-field aggregate
    expect(out).toMatch(/x = 3/);
  } finally {
    unlinkSync(f);
    try { rmSync(bin); } catch {}
    try { rmSync(`${bin}.dSYM`, { recursive: true, force: true }); } catch {}
    if (existsSync(`${bin}.dbg.o`)) unlinkSync(`${bin}.dbg.o`);
  }
});
