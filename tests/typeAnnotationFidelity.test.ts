// A type annotation must mean what it says, or be refused.
//
// The failure this exists to prevent is not "a type is unsupported" — it is a type that is
// ACCEPTED and silently means a different one. `MiloType` carries a single `isArray` flag,
// so the parser built an array type from its inner type's NAME alone and dropped
// everything else about it. The result:
//
//     var g: [[i64; 2]; 2] = [1, 2]     // accepted, and `g` was an [i64; 2]
//     var a: [&string; 2]  = ["x","y"]  // accepted, and `a` was an OWNED [string; 2]
//     fn total(a: [Vec<i64>; 2])        // resolved to a plain Vec<i64>, array dropped
//
// Nothing was missing at the call site to notice: a flat literal satisfied a nested
// annotation, so the mismatch surfaced far away as invalid LLVM IR, or as an error about a
// type the program never wrote ("cannot iterate over type 'i64'").
//
// So the property here is fidelity, checked from the outside: a literal of the WRONG shape
// must not satisfy an annotation, and an annotation the type system cannot represent must
// be refused rather than quietly reinterpreted. Both directions are asserted, because a
// checker that rejected everything would pass half of this.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { errorsFor as checkSource } from "./checkSource";

const dir = mkdtempSync(join(tmpdir(), "milo-annot-"));
let n = 0;

function errorsFor(src: string): string[] {
  const entry = join(dir, `a${n++}.milo`);
  writeFileSync(entry, src);
  return checkSource(src, entry);
}

// Annotations that ARE representable, with a value of the right shape. These must compile:
// a gate made only of rejections is satisfied by a compiler that rejects everything.
const FAITHFUL: { name: string; ty: string; value: string; use: string }[] = [
  { name: "fixed array of scalars", ty: "[i64; 2]", value: "[1, 2]", use: "print(x[0])" },
  { name: "fixed array of strings", ty: "[string; 2]", value: `["a", "b"]`, use: "print(x[1])" },
  { name: "Vec of scalars", ty: "Vec<i64>", value: "Vec.new()", use: "print(x.len)" },
  { name: "Vec of Vecs", ty: "Vec<Vec<i64>>", value: "Vec.new()", use: "print(x.len)" },
  { name: "fixed array of a generic", ty: "[Vec<i64>; 2]", value: "[Vec.new(), Vec.new()]", use: "print(x[0].len)" },
  { name: "HashMap", ty: "HashMap<string, i64>", value: "HashMap.new()", use: "print(x.len)" },
  { name: "Vec.filled with a matching value", ty: "Vec<i64>", value: "Vec.filled(3, 7)", use: "print(x[0])" },
  { name: "array repeat with a matching value", ty: "[i64; 3]", value: "[7; 3]", use: "print(x[2])" },
];

describe("a representable annotation compiles and means itself", () => {
  for (const c of FAITHFUL) {
    test(c.name, () => {
      expect(errorsFor(`fn main() {\n    let x: ${c.ty} = ${c.value}\n    ${c.use}\n}\n`)).toEqual([]);
    });
  }
});

// A value whose SHAPE does not match the annotation. Every one of these was the bug: the
// annotation was reinterpreted until the value fitted it.
const MISMATCHED: { name: string; ty: string; value: string }[] = [
  { name: "flat literal for a nested array", ty: "[[i64; 2]; 2]", value: "[1, 2]" },
  { name: "nested literal for a nested array", ty: "[[i64; 2]; 2]", value: "[[1, 2], [3, 4]]" },
  { name: "array of references", ty: "[&string; 2]", value: `["x", "y"]` },
  { name: "string literal for an int array", ty: "[i64; 2]", value: `["a", "b"]` },
  { name: "wrong element type in a Vec", ty: "Vec<i64>", value: `["a"]` },
  // Constructor forms reach the element through a different path than a literal does, and
  // that path had the identical discard: the value was hint-checked and the answer dropped.
  { name: "wrong fill value in Vec.filled", ty: "Vec<i64>", value: `Vec.filled(3, "a")` },
  { name: "wrong repeated element", ty: "[i64; 3]", value: `["x"; 3]` },
];

describe("a value of the wrong shape does not satisfy an annotation", () => {
  for (const c of MISMATCHED) {
    test(c.name, () => {
      const errs = errorsFor(`fn main() {\n    let x: ${c.ty} = ${c.value}\n    print("used")\n}\n`);
      expect({ case: c.name, rejected: errs.length > 0 }).toEqual({ case: c.name, rejected: true });
    });
  }
});
