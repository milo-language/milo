// Differential gate for the generated non-escaping parameter pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { nonEscapingFindings } from "../src/checker-nonescaping";
import { setNonEscapingCapture } from "../src/checker-nonescaping-host";

if (import.meta.main) await runPassDiff({
  name: "nonescaping",
  inputs: ["src/ast-walk-nonescaping.ts","src/checker-nonescaping.ts"],
  astRoot: "NonEscapingInput",
  setCapture: setNonEscapingCapture,
  findings: nonEscapingFindings,
  size: (input) => input.calls.length,
  unit: "call facts",
  // Make the "is returned" rule never fire: a returned plain closure parameter then falls through
  // to the generic "used as a value" message, so tests/errors/nonEscapingParamReturned.milo differs.
  neuter: {
    what: "returned rule",
    find: "if (parent.kind == NodeKind.Return) {",
    put: "if (parent.kind == NodeKind.None) {",
  },
});
