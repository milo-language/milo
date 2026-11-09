// Differential gate for the generated thread boundary pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { threadBoundaryFindings } from "../src/checker-thread-boundary";
import { setThreadBoundaryCapture } from "../src/checker-thread-boundary-host";

if (import.meta.main) await runPassDiff({
  name: "thread-boundary",
  inputs: ["src/ast-walk-thread-boundary.ts","src/checker-implicit-calls.ts","src/checker-thread-boundary.ts"],
  astRoot: "ThreadInput",
  setCapture: setThreadBoundaryCapture,
  findings: threadBoundaryFindings,
  size: (input) => input.facts.length,
  unit: "facts",
  // Make the touch report never run, so every program with a race finding differs.
  neuter: {
    what: "touch report",
    find: "fn reportTouches(self: &mut ThreadScan) {",
    put: "fn reportTouches(self: &mut ThreadScan) {\n        if self.tName.len >= 0 { return }",
  },
});
