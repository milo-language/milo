// Differential gate for the generated @concurrent closure-argument pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { concurrentArgsFindings } from "../src/checker-concurrent-args";
import { setConcurrentArgsCapture } from "../src/checker-concurrent-args-host";

if (import.meta.main) await runPassDiff({
  name: "concurrent-args",
  inputs: ["src/ast-walk-concurrent-args.ts","src/checker-concurrent-args.ts"],
  astRoot: "ConcurrentArgsInput",
  setCapture: setConcurrentArgsCapture,
  findings: concurrentArgsFindings,
  size: (input) => input.facts.length,
  unit: "facts",
  // Make the check rule never fire, so every program with a finding differs.
  neuter: {
    what: "check rule",
    find: "fn check(self: &mut ConcurrentArgsScan, id: i64) {",
    put: "fn check(self: &mut ConcurrentArgsScan, id: i64) {\n        if id >= 0 { return }",
  },
});
