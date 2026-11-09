// Differential gate for the generated &mut parameter bundle pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { passSpec, runPassDiff } from "./ts2milo/pass-diff";
import { mutBundleFindings } from "../src/checker-mut-bundle";
import { setMutBundleCapture } from "../src/checker-mut-bundle-host";

export const spec = passSpec({
  name: "mut-bundle",
  inputs: ["src/ast-walk-mut-bundle.ts","src/checker-mut-bundle.ts"],
  astRoot: "MutBundleInput",
  setCapture: setMutBundleCapture,
  findings: mutBundleFindings,
  size: (input) => input.facts.length,
  unit: "facts",
  // Make the report rule never fire, so every program with a finding differs.
  neuter: {
    what: "report rule",
    find: "fn report(self: &mut MutBundleScan) {",
    put: "fn report(self: &mut MutBundleScan) {\n        if self.next >= 0 { return }",
  },
});

if (import.meta.main) runPassDiff(spec);
