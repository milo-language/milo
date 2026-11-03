// The size codegen COMPUTES for each builtin aggregate must match the type it EMITS.
//
// `typeSize()` answers in bytes and drives struct field offsets, aggregate memcpy lengths
// and array strides. It used to spell those answers out — `if (ty === "%HashMap") return
// 32; // ptr + i64 + i64 + i64` — beside a type definition written out separately. Adding
// the tombstone counter to %HashMap changed the definition and left the constant at 32, so
// every struct holding a map got an 8-byte-short memcpy.
//
// Nothing in `bun test` noticed. The fixtures that put a map in a struct still passed,
// because the bytes that stopped being copied were the ones the test did not read. What
// caught it was the self-hosted compiler segfaulting on its first lookup — src-milo is full
// of structs with HashMap fields — and that gate only runs on a commit touching src-milo/,
// std/ or the selfhost scripts. A src/-only commit can break the bootstrap and nothing here
// says a word.
//
// So: compare the two directly. Emit a program using all three aggregates, parse the type
// definitions out of the IR, and check each against typeSize.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// Every field of these is 8 bytes wide (a pointer or an i64), so the size is the field
// count times 8. A future field of another width makes this assertion wrong rather than
// silently weak, which is the intent.
const WIDTH: Record<string, number> = { ptr: 8, i64: 8, i32: 4, i8: 1, double: 8, float: 4 };

test("typeSize agrees with the emitted type for %String, %Vec and %HashMap", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-aggsize-"));
  try {
    const src = join(dir, "agg.milo");
    writeFileSync(src, [
      "pub fn main(): i32 {",
      '    var s: string = "x"',
      "    var v: Vec<i64> = [1]",
      "    var m: HashMap<string, i64> = HashMap.new()",
      '    m.insert("k", 1)',
      "    print(s.len + v.len + m.len)",
      "    return 0",
      "}",
      "",
    ].join("\n"));

    const ir = execFileSync("bun", [join(ROOT, "src", "main.ts"), "emit-ir", src], {
      cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });

    const emitted: Record<string, number> = {};
    for (const m of ir.matchAll(/^%(String|Vec|HashMap) = type \{ ([^}]*) \}/gm)) {
      const fields = m[2]!.split(",").map(f => f.trim());
      let size = 0;
      for (const f of fields) {
        const w = WIDTH[f];
        expect(w, `unhandled field type '${f}' in %${m[1]} — teach this test its width`).toBeDefined();
        size += w!;
      }
      emitted[`%${m[1]}`] = size;
    }

    // All three must actually appear, or this passes by reading nothing.
    expect(Object.keys(emitted).sort()).toEqual(["%HashMap", "%String", "%Vec"]);

    // typeSize is private to the Codegen class, so ask the compiler the same question the
    // way a program does: the stride between consecutive elements of a Vec<T> IS
    // sizeof(T), and `getelementptr %T, ptr null, i32 1` is how codegen computes it.
    // Simpler and just as decisive: assert the sizes the compiler's own table claims.
    // Codegen.typeSize delegates to its Layout now, so ask the Layout directly (an
    // unconstructed Codegen has no layout to delegate to).
    const { Layout } = require(join(ROOT, "src", "layout.ts"));
    const cg = new Layout();
    for (const [ty, want] of Object.entries(emitted)) {
      const got = cg.typeSize(ty);
      expect(got, `${ty}: typeSize says ${got}, emitted type is ${want} bytes`).toBe(want);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
