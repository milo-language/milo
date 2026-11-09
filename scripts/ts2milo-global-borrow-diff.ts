// Differential gate for the generated global borrow invalidation pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { globalBorrowFindings } from "../src/checker-global-borrow";
import { setGlobalBorrowCapture } from "../src/checker-global-borrow-host";

if (import.meta.main) await runPassDiff({
  name: "global-borrow",
  inputs: ["src/ast-walk-global-borrow.ts","src/checker-global-borrow.ts"],
  astRoot: "GlobalBorrowInput",
  setCapture: setGlobalBorrowCapture,
  findings: globalBorrowFindings,
  size: (input) => input.calls.length,
  unit: "facts",
  // Make the report rule never fire, so every program with a finding differs.
  neuter: {
    what: "report rule",
    find: "fn report(self: &mut GlobalBorrowScan, message: &string, span: &Option<Span>, hint: &string) {",
    put: "fn report(self: &mut GlobalBorrowScan, message: &string, span: &Option<Span>, hint: &string) {\n        if self.next >= 0 { return }",
  },
});
