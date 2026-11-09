// The TypeScript half of the checker-mutability probe: one program's pass input as JSON, and a
// finding as the line both sides print. Parsing and checking stay in TypeScript; only the pass is
// compiled from the generated Milo.
import { readFileSync } from "fs";
import type { Function } from "../../src/ast";
import type { Finding } from "../../src/checker-mutability";
import type { MutInput } from "../../src/checker-mutability";

// The keys the generated decoder reads, so the dump carries no field the Milo side would skip.
export function decoderKeys(decodeMilo: string): Set<string> {
  const keys = new Set<string>(["kind"]);
  for (const m of readFileSync(decodeMilo, "utf8").matchAll(/curField\(c, "([^"]+)"\)/g)) keys.add(m[1]!);
  return keys;
}

// JSON with every object trimmed to the keys the generated decoder reads; bigints as strings.
export function stringifyKeyed(value: unknown, keys: Set<string>): string {
  return JSON.stringify(value, function (this: unknown, _k, v) {
    if (typeof v === "bigint") return String(v);
    // Array indices and the root have no key to test; an object's own keys are filtered.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o: Record<string, unknown> = {};
      for (const kk of Object.keys(v)) if (keys.has(kk)) o[kk] = (v as Record<string, unknown>)[kk];
      return o;
    }
    return v;
  });
}

export function dumpInput(input: MutInput, keys: Set<string>): string {
  const cache = new Map<Function, string>();
  const body = (f: Function): string => {
    let s = cache.get(f);
    if (s === undefined) {
      s = stringifyKeyed(f, keys);
      cache.set(f, s);
    }
    return s;
  };
  const entry = (e: MutInput["view"][number]) => `{"name":${JSON.stringify(e.name)},"base":${e.base},"fn":${body(e.fn)},"hasSig":${e.hasSig},"refParams":${JSON.stringify(e.refParams)}}`;
  return `{"facts":${JSON.stringify(input.facts)},"view":[${input.view.map(entry).join(",")}],"program":[${input.program.map(entry).join(",")}]}`;
}

// One line per finding, identical on both sides: code, where, message, hint, underline length, notes.
export function findingLine(f: Finding): string {
  const at = (s: { file?: string; line: number; col: number } | undefined) => `${s?.file}:${s?.line}:${s?.col}`;
  return `${f.code}\t${at(f.span)}\t${f.message}\t${f.hint}\t${f.len}\t${f.notes.map((n) => `${n.message}@${at(n.span)}`).join(";")}`;
}
