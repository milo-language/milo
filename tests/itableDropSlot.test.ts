// Every itable carries a destructor slot, and it is filled for a type that has one.
//
// Boxing a value behind an interface erases its concrete type. The itable is the only
// thing that survives that erasure, and it used to carry method pointers ONLY — so a value
// in a `Heap<Iface>` had its box freed and was never destroyed. RAII through polymorphism
// was silently a no-op, while the identical `Heap<Concrete>` was correct.
//
// The fix appends one slot after the methods: the concrete type's destructor, or null when
// it has none. Nothing structural forces that slot to keep existing, which is the same gap
// that produced the bug in the first place — so this asserts it from the emitted IR, where
// a regression shows up as a missing or misnamed pointer rather than as a destructor
// quietly not running.
//
// Appended rather than prepended so existing method indices stay valid; dispatch GEPs by
// index and never reads the struct type, which the slot count below also pins.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "milo-itable-"));

// `S` implements a 1-method interface and HAS a Drop impl; `T` implements a 2-method one
// and has none. Two arities, so a hardcoded slot count cannot pass by accident.
const SRC = `interface One {
    fn a(self: &Self): i64
}

interface Two {
    fn a(self: &Self): i64
    fn b(self: &Self): i64
}

struct S {
    n: i64,
}

impl S {
    fn a(self: &Self): i64 { return self.n }
}

impl Drop for S {
    fn drop(self: &mut Self): void { print("dropped S") }
}

struct T {
    m: i64,
}

impl T {
    fn a(self: &Self): i64 { return self.m }
    fn b(self: &Self): i64 { return self.m }
}

fn main() {
    let x: Heap<One> = Heap(S { n: 1 })
    let y: Heap<Two> = Heap(T { m: 2 })
    print(x.a(), y.b())
}
`;

test("an itable ends in a drop slot, filled when the concrete type has a destructor", () => {
  const src = join(WORK, "itable.milo");
  writeFileSync(src, SRC);
  const r = spawnSync("bun", [join(ROOT, "src", "main.ts"), "emit-ir", src], { encoding: "utf8" });
  const ir = r.stdout ?? "";
  expect(ir).toContain("@itable.");

  const rows = [...ir.matchAll(/@itable\.(\w+)\.(\w+) = [^{]*\{([^}]*)\} \{([^}]*)\}/g)]
    .map(m => ({
      concrete: m[1],
      iface: m[2],
      slotTypes: m[3].split(",").length,
      values: m[4].split(",").map(v => v.trim()),
    }));

  const findings = rows.map(row => {
    const last = row.values[row.values.length - 1];
    // S has a Drop impl, so its slot must name a milo.drop.* destructor (its mangling is
    // not this test's concern); T has none, so null.
    const want = row.concrete === "S" ? "destructor" : "ptr null";
    const methodCount = row.iface === "Two" ? 2 : 1;
    return {
      itable: `${row.concrete}.${row.iface}`,
      slots: row.values.length,
      expectedSlots: methodCount + 1,
      typesMatchValues: row.slotTypes === row.values.length,
      last: last === "ptr null" || !/^ptr @milo\.drop\./.test(last) ? last : "destructor",
      expectedLast: want,
    };
  });

  expect(findings.length).toBe(2);
  for (const f of findings) {
    expect({ itable: f.itable, slots: f.slots, typesMatchValues: f.typesMatchValues, last: f.last })
      .toEqual({ itable: f.itable, slots: f.expectedSlots, typesMatchValues: true, last: f.expectedLast });
  }

  rmSync(WORK, { recursive: true, force: true });
}, 120_000);
