// Soundness check for `milo prove`, run as part of `bun test` (and thus CI).
//
// The contract gate next door asks "does any contract fail to hold". This asks the more
// fundamental question: when the prover says PROVEN, is it telling the truth? That is the
// only verdict that can be wrong in a dangerous direction — `unknown` and `failed` cost
// you precision and patience, a false `proven` costs you the guarantee itself.
//
// The generator fits a postcondition to two sampled inputs, then executes the program over
// twenty-six. A clause true only on the sample is false in general, so a `proven` verdict
// on one is a false proof by construction and the wide run exhibits the counterexample.
// See scripts/prove-soundness-fuzz.ts for the shapes and the reasoning behind them.
//
// The seed is fixed so a failure here is reproducible verbatim:
//   bun scripts/prove-soundness-fuzz.ts --cases 40 --seed 7 --keep
import { test, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

function proveZ3(file: string): string {
  try {
    return execSync(`bun ${join(import.meta.dir, "..", "src", "main.ts")} prove ${file} --solver=z3`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    return (e.stdout ?? "") + (e.stderr ?? "");   // prove exits 1 when a contract is refuted
  }
}

// The generated cases above cover the constructs the symbolic walker has to model. This
// covers a different failure mode entirely: the walker being right and the TRANSLATION
// being wrong. `-7 % 3` is -1 in Milo and 2 under SMT-LIB's Euclidean `mod`, and lowering
// one to the other made `ensures result == 2` provable for a function returning -1.
//
// Asserted against z3 specifically: the native std/smt engine cannot decide the corrected
// form (it uses `ite`) and answers `unknown`, which is safe but pins nothing.
test("`/` and `%` model Milo's truncation, not SMT-LIB's Euclidean division", () => {
  const out = proveZ3(join(import.meta.dir, "prove", "truncDivNoFalseProof.milo"))
    .replace(/\x1b\[[0-9;]*m/g, "");
  expect(out).toMatch(/proven:\s*5\s+failed:\s*1\s+unknown:\s*0\s+errors:\s*0/);
  // Both true contracts prove and the Euclidean answer is the single refutation.
  expect(out).toMatch(/✗\s*\[postcondition\]\s*wrong/);
});

// A third failure mode: the walker never REACHING the code. Statements nest inside
// expressions here (if-expr arms, match-expr arms, closure bodies are all `Stmt[]`), and a
// walker that enumerated statement fields by hand never descended into any of them — so
// loop havoc could not see `x = 100` and left `x` at its pre-loop value. All three
// spellings proved `ensures result == 0` for a function returning 100.
//
// The fix was to route every "find X anywhere beneath" walker in verify.ts through one
// total reflective descent, so reachability stops being a list someone has to maintain.
// This test is the guard on that: it pins the three known spellings, but the property it
// stands for is that a NEW expression-nested statement form needs no edit to be covered.
test("statements nested in expressions are reachable by the walkers", () => {
  const out = proveZ3(join(import.meta.dir, "prove", "stmtInExprNoFalseProof.milo"))
    .replace(/\x1b\[[0-9;]*m/g, "");
  // Unknown, not refuted: no invariant names `x`, so the havoced value is a free variable
  // and the prover declines to call a model over it a counterexample. The claim is that
  // none of the three is PROVEN.
  expect(out).toMatch(/proven:\s*0\s+failed:\s*0\s+unknown:\s*3\s+errors:\s*0/);
  for (const fn of ["viaIfExpr", "viaMatchExpr", "viaClosure"]) {
    expect(out).toMatch(new RegExp(`\\?\\s*\\[postcondition\\]\\s*${fn}: unknown`));
  }
});

test("no false proofs: a `proven` contract survives execution", () => {
  let out = "";
  let failed = false;
  try {
    out = execSync(`bun ${join(import.meta.dir, "..", "scripts", "prove-soundness-fuzz.ts")} --cases 40 --seed 7`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    failed = true;
  }
  console.log(out);

  // A run where nothing was proven proves nothing about proofs. The fuzzer exits 2 and
  // says so, but assert it here too — a silently vacuous soundness test is exactly the
  // kind of false confidence this file exists to prevent.
  const controls = out.match(/controls proven: (\d+)\/(\d+)/);
  expect(controls).not.toBeNull();
  expect(Number(controls![1])).toBeGreaterThan(0);

  expect(failed ? out : "").toBe("");
}, 900000);
