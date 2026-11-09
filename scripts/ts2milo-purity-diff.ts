// Differential gate for the generated @pure body pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { purityFindings } from "../src/checker-purity";
import { setPurityCapture } from "../src/checker-purity-host";

if (import.meta.main) await runPassDiff({
  name: "purity",
  inputs: ["src/ast-walk-purity.ts","src/checker-purity.ts"],
  astRoot: "PurityInput",
  setCapture: setPurityCapture,
  findings: purityFindings,
  size: (input) => input.calls.length,
  unit: "call facts",
  // Make the 'unsafe' block rule never fire, so every tests/errors program that expects that message differs.
  neuter: {
    what: "unsafe rule",
    find: "fn visitUnsafeBlock(self: &mut PurityScan, n: &UnsafeBlock, _id: i64, _parent: &Parent, _key: EdgeKey, _index: i64) {",
    put: "fn visitUnsafeBlock(self: &mut PurityScan, n: &UnsafeBlock, _id: i64, _parent: &Parent, _key: EdgeKey, _index: i64) {\n        if self.depth >= 0 { return }",
  },
});
