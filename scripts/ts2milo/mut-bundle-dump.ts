// The TypeScript half of the checker-mut-bundle probe: the pass input the real checker builds for
// one program (captured through setMutBundleCapture), as JSON, and a finding as the line both
// sides print. Parsing and checking stay in TypeScript; only the pass is compiled from the generated Milo.
import type { Finding, MutBundleInput } from "../../src/checker-mut-bundle";
import { setMutBundleCapture } from "../../src/checker-mut-bundle-host";
import { stringifyKeyed } from "./mut-dump";

export { decoderKeys } from "./mut-dump";

// Runs `check` and returns the inputs the pass saw during it (one per whole-program pass run).
export function captureInputs<T>(check: () => T): { result: T; inputs: MutBundleInput[] } {
  const inputs: MutBundleInput[] = [];
  setMutBundleCapture((i) => inputs.push(i));
  try { return { result: check(), inputs }; } finally { setMutBundleCapture(undefined); }
}

export function dumpInput(input: MutBundleInput, keys: Set<string>): string {
  return stringifyKeyed(input, keys);
}

// One line per finding, identical on both sides: where, message, hint.
export function findingLine(f: Finding): string {
  const s = f.span;
  return `${s?.file}:${s?.line}:${s?.col}\t${f.message}\t${f.hint}`;
}
