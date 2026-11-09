// Mutually recursive types must not blow up the emitted MLIR. Struct and enum types used to
// be spelled whole at every use, so a group of N types reaching each other through Heap/Vec
// grew exponentially (six enums: 30 MB; the compiler's own AST: out of memory in
// moduleText). Each type is now spelled by name and defined once, so the text is linear.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function enums(n: number): string {
  let o = "";
  for (let i = 0; i < n; i++) {
    const nx = [1, 2, 3].map(k => `E${(i + k) % n}`);
    o += `enum E${i} {\n    Leaf(i32),\n    A(Heap<${nx[0]}>, Heap<${nx[1]}>),\n    B(Vec<${nx[2]}>),\n}\n`;
    o += `struct S${i} {\n    a: Option<Heap<S${(i + 1) % n}>>,\n    b: Vec<S${(i + 2) % n}>,\n    e: E${i},\n}\n`;
  }
  return o + "fn main() {\n    let e = E0.A(Heap(E1.Leaf(3)), Heap(E2.Leaf(4)))\n    print(match e { E0.A(_a, _b) => 1, _ => 0 })\n}\n";
}

function moduleBytes(src: string): number {
  const dir = mkdtempSync(join(tmpdir(), "milo-tysize-"));
  try {
    const file = join(dir, "rec.milo");
    writeFileSync(file, src);
    return execFileSync("bun", [join(ROOT, "src/main.ts"), "emit-mlir", file, "--all"], { maxBuffer: 1 << 28 }).length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mutually recursive enums and structs: module size grows by the types, not by their paths", () => {
  const a = moduleBytes(enums(6)), b = moduleBytes(enums(12)), c = moduleBytes(enums(24));
  // Twice the types adds about twice the bytes; path-wise spelling would square or worse.
  expect(c - b).toBeLessThan(2.5 * (b - a));
  // What one enum+struct pair costs: its drop functions and derived Clone instances. Measured
  // 15.8 KB (6 pairs 422 KB, 12 516 KB, 24 706 KB; the runtime and scaffold are ~327 KB of each).
  // It was 8.3 KB until structs derived Clone through Option<Heap<T>> and Vec<T> fields, which
  // these structs have. The bound is per pair so that growth in the runtime does not trip it.
  expect((c - b) / 12).toBeLessThan(20_000);
});
