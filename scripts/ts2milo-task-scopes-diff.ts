// Differential gate for the generated Task.scope pass: TypeScript against its generated Milo,
// on the checker's input for every corpus program that reaches the pass.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiff } from "./ts2milo/pass-diff";
import { taskScopesFindings } from "../src/checker-task-scopes";
import { setTaskScopesCapture } from "../src/checker-task-scopes-host";

if (import.meta.main) await runPassDiff({
  name: "task-scopes",
  inputs: ["src/ast-walk-task-scopes.ts","src/checker-task-scopes.ts"],
  astRoot: "TaskScopesInput",
  setCapture: setTaskScopesCapture,
  findings: taskScopesFindings,
  size: (input) => input.calls.length,
  unit: "facts",
  // Make the report rule never fire, so every program with a finding differs.
  neuter: {
    what: "report rule",
    find: "fn report(self: &mut TaskScopeScan, message: &string, span: &Option<Span>, hint: &string) {",
    put: "fn report(self: &mut TaskScopeScan, message: &string, span: &Option<Span>, hint: &string) {\n        if self.next >= 0 { return }",
  },
});
