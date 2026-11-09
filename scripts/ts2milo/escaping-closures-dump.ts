// The TypeScript half of the checker-escaping-closures probe: the pass input the real checker builds for
// one program (captured through setEscapingClosuresCapture), as JSON, and a finding as the line both
// sides print. Parsing and checking stay in TypeScript; only the pass is compiled from the generated Milo.
import type { Finding, EscapingClosuresInput } from "../../src/checker-escaping-closures";
import { setEscapingClosuresCapture } from "../../src/checker-escaping-closures-host";
import { stringifyKeyed } from "./mut-dump";

export { decoderKeys } from "./mut-dump";

// Runs `check` and returns the inputs the pass saw during it (one per whole-program pass run).
export function captureInputs<T>(check: () => T): { result: T; inputs: EscapingClosuresInput[] } {
  const inputs: EscapingClosuresInput[] = [];
  setEscapingClosuresCapture((i) => inputs.push(i));
  try { return { result: check(), inputs }; } finally { setEscapingClosuresCapture(undefined); }
}

export function dumpInput(input: EscapingClosuresInput, keys: Set<string>): string {
  return stringifyKeyed(input, keys);
}

// One line per finding, identical on both sides: where, message, hint.
export function findingLine(f: Finding): string {
  const s = f.span;
  return `${s?.file}:${s?.line}:${s?.col}\t${f.message}\t${f.hint}`;
}
