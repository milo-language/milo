// Differential gate for the generated pointer-parameter-escape pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { passSpec, runPassDiff } from "./ts2milo/pass-diff";
import { pointerEscapeFindings } from "../src/checker-pointer-escape";
import { setPointerEscapeCapture } from "../src/checker-pointer-escape-host";

export const spec = passSpec({
  name: "pointer-escape",
  inputs: ["src/ast-walk-pointer-escape.ts","src/ast-walk-pointer-mention.ts","src/checker-pointer-mention.ts","src/checker-pointer-escape.ts"],
  astRoot: "PointerEscapeInput",
  setCapture: setPointerEscapeCapture,
  findings: pointerEscapeFindings,
  size: (input) => input.facts.length,
  unit: "facts",
  // Make the assignment rule never fire, so every program with a stored-pointer assignment finding differs.
  neuter: {
    what: "assignment rule",
    find: "fn visitAssign(self: &mut PointerEscapeScan, n: &Assign, id: i64, _parent: &Parent, _key: EdgeKey, _index: i64) {",
    put: "fn visitAssign(self: &mut PointerEscapeScan, n: &Assign, id: i64, _parent: &Parent, _key: EdgeKey, _index: i64) {\n        if self.next >= 0 { return }",
  },
});

if (import.meta.main) runPassDiff(spec);
