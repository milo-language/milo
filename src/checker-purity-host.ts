// The boundary between the checker and the portable @pure body pass (src/checker-purity.ts). The
// checker keys call resolution by object; this file numbers every node of each @pure body in the
// walker's pre-order and restates how each call resolved as plain data keyed by that id.
import type { Program, Function } from "./ast";
import { collectStmts, type AnyNode } from "./ast-nodes";
import { isStdCollectionModule } from "./checker";
import type { ProgramPassHost, ProgramView } from "./checker-program-passes";
import {
  purityFindings, IMPURE_NONE, IMPURE_FN_VALUE, IMPURE_INTERFACE, IMPURE_FN_FIELD, IMPURE_EXTERN, IMPURE_CALLEE,
  type BodyTask, type CallFact, type PurityInput,
} from "./checker-purity";

// Built-in free functions with no ambient effect. An allowlist, not a denylist: a new
// intrinsic has to be judged pure deliberately rather than inheriting it by default.
// `assert` is here because trapping is not an effect under this definition.
const PURE_BUILTINS = new Set(["format", "max", "min", "assert"]);

// Test hook (scripts/ts2milo-purity-diff.ts): sees each input the pass is about to run on.
// Unset in every real compile, so it changes nothing.
let captureInput: ((input: PurityInput) => void) | undefined;
export function setPurityCapture(f: ((input: PurityInput) => void) | undefined): void { captureInput = f; }

export function checkPurity(host: ProgramPassHost, program: Program, view: ProgramView): void {
  const pureNames = new Set<string>();
  const bodies: Function[] = [];
  // A generic declaration is registered as pure but not walked — its instances are what
  // call sites resolved to, and they are the copies whose expressions carry resolution
  // data.
  for (const f of view.fns.values()) {
    if (!f.attributes?.some(a => a.name === "pure")) continue;
    pureNames.add(f.name);
    if (!f.isExtern && f.typeParams.length === 0) bodies.push(f);
  }
  if (bodies.length === 0) return;

  const { pretty } = view;
  const tasks: BodyTask[] = [];
  const calls: CallFact[] = [];
  let total = 0;

  // What a call to `target` means for purity: nothing to report, or an extern or impure callee.
  const calleeVerdict = (target: string): number => {
    if (pureNames.has(target) || PURE_BUILTINS.has(target)) return IMPURE_NONE;
    // std/hashmap and std/vec are the builtin collections' method bodies, which act only
    // on the receiver and the arguments handed to them, as the builtins did. They cannot
    // say '@pure' themselves: their bodies are unsafe (raw slot access), which @pure refuses.
    if (isStdCollectionModule(view.fns.get(target)?.sourceFile)) return IMPURE_NONE;
    const sig = host.functions.get(target);
    // No registered signature: a compiler builtin (`Vec.new`, `v.len()`). Those act
    // only on the data handed to them, so they are pure by construction — the ones
    // that are not (`print`, `exit`, the `_milo*`/`_atomic*` intrinsics) do have a
    // registered signature and fall through to the impure branch below.
    if (!sig) return IMPURE_NONE;
    return sig.isExtern ? IMPURE_EXTERN : IMPURE_CALLEE;
  };

  for (const fn of bodies) {
    const nodes: AnyNode[] = [];
    collectStmts(fn.body, nodes);
    const base = total;
    total += nodes.length;
    tasks.push({ body: fn.body, base, params: fn.params.map(p => p.name), who: fn.sourceName ?? pretty(fn.name), fnName: fn.name });

    nodes.forEach((e, i) => {
      const id = base + i;
      const fact = (verdict: number, name: string, target: string, iface: string): void => {
        calls.push({ id, verdict, name, target, pretty: target === "" ? "" : pretty(target), iface });
      };
      if (e.kind === "Call") {
        // A call through a value (closure, fn-typed param, C function pointer) has no
        // static target, and purity is not part of a fn type yet.
        if (host.closureCalls.has(e) || host.cfnCalls.has(e)) fact(IMPURE_FN_VALUE, e.func, "", "");
        else { const t = view.calleeOf(e) ?? e.func; fact(calleeVerdict(t), e.func, t, ""); }
      } else if (e.kind === "EnumLit") {
        // Static method calls (`Math.sqrt(x)`) parse as EnumLit and are resolved into
        // staticCalls; without an entry this is ordinary enum construction.
        const t = view.calleeOf(e);
        if (t) fact(calleeVerdict(t), `${e.enumName}.${e.variant}`, t, "");
      } else if (e.kind === "MethodCall") {
        const iface = host.interfaceMethodCalls.get(e);
        if (iface) {
          fact(IMPURE_INTERFACE, e.method, "", iface.ifaceName);
        } else if (host.fnFieldCalls.has(e) || host.cfnFieldCalls.has(e)) {
          fact(IMPURE_FN_FIELD, e.method, "", "");
        } else {
          const t = view.calleeOf(e);
          if (t) fact(calleeVerdict(t), e.method, t, "");
        }
      }
    });
  }

  const globals = program.globals.filter(g => g.mutable).map(g => g.name);
  const input: PurityInput = { tasks, calls, globals };
  if (captureInput) captureInput(input);
  for (const f of purityFindings(input)) host.error(f.message, f.span, f.hint);
}
