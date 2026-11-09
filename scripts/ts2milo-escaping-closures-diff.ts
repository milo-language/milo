// Differential gate for the generated escaping-closure pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { escapingClosuresFindings } from "../src/checker-escaping-closures";
import { setEscapingClosuresCapture } from "../src/checker-escaping-closures-host";

if (import.meta.main) await runPassDiff({
  name: "escaping-closures",
  inputs: ["src/ast-walk-escaping-closures.ts","src/checker-escaping-closures.ts"],
  astRoot: "EscapingClosuresInput",
  setCapture: setEscapingClosuresCapture,
  findings: escapingClosuresFindings,
  size: (input) => input.nodes.length,
  unit: "facts",
  // Make the check rule never fire, so every program with a finding differs.
  neuter: {
    what: "check rule",
    find: "fn check(self: &mut EscapingScan, value: &Expr, lit: i64, verb: &string, tail: &string, holder: &string, filter: i64) {",
    put: "fn check(self: &mut EscapingScan, value: &Expr, lit: i64, verb: &string, tail: &string, holder: &string, filter: i64) {\n        if self.next >= 0 { return }",
  },
});
