// Reference interpreter, values and state: the shapes docs/semantics/milo.md §2 calls
// slots, places and values, plus the errors the interpreter raises. No rules live here.
//
// Representation choices (the spec leaves them open):
//   int      bigint, wrapped to its type by the rule that made it   float  number
//   struct   fields in declaration order; a moved field holds MOVED
//   string   a counted buffer (spec §5, strings): a copy shares it, the last drop frees it
//   Vec      a header {buf,start,len,cap} owned by its slot over a buffer on the heap
//   Heap<T>  box: one cell on the heap
//   handle   a Channel, WaitGroup, atomic or Task: an object the library keeps in raw memory
import type { Interp } from "./interp";
import type { PtrV } from "./interp-mem";

export class InterpUnsupported extends Error {
  where = ""; // the innermost calls when it was raised, for the message `milo interp` prints under the first line
  constructor(public what: string) { super(`interp: unsupported: ${what}`); }
}

// The program reached a state no rule applies to. For a program the checker accepted this is
// a checker bug or a spec bug, which is exactly what the interpreter exists to show.
export class InterpStuck extends Error {
  where = ""; // the innermost calls when it was raised
  constructor(public rule: string, detail: string) { super(`interp: stuck at ${rule}: ${detail}`); }
}

// A runtime trap the program asked for (assert, bounds, overflow, unwrap of None).
export class Panic extends Error {}
export class ExitProgram { constructor(public code: number) {} }

export interface Moved { k: "moved" }
export const MOVED: Moved = { k: "moved" };

export interface StrBuf { bytes: number[]; rc: number; id: number } // id < 0: static, never counted
export interface Str { k: "str"; b: StrBuf }
// ghost: a view of a value someone else owns (an if/match fork of named places, a `get`): dropping it does nothing
export interface Struct { k: "struct"; name: string; f: Record<string, Value>; ghost?: true }
export interface EnumV { k: "enum"; en: string; variant: string; tag: number; a: Value[]; ghost?: true }
export interface ArrV { k: "arr"; e: Value[] }
export interface VecBuf { id: number; elems: Value[] }
// `view`: a slice, which borrows the buffer and drops nothing. `buf` null: nothing allocated.
export interface VecV { k: "vec"; buf: VecBuf | null; start: number; len: number; cap: number; view: boolean }
export interface BoxV { k: "box"; id: number; cell: { v: Value }; ghost?: true }
export interface IfaceV { k: "iface"; concrete: string; inner: Value }
// HashMap: one table block while non-empty; entries keep their key and value in slots so a reference can name them
export interface MapEntry { key: Slot; val: Slot }
export interface MapV { k: "map"; buf: number | null; m: Map<string, MapEntry>; view?: true }
// A runtime object with identity that the library keeps in raw memory (Channel, WaitGroup, atomics, Task):
// one handle per owner, `o.release` runs when an owner drops it (src/interp-co-natives.ts).
export interface HandleV { k: "handle"; kind: string; o: { release(it: Interp): void }; ghost?: true }
export interface FnRef { k: "fn"; name: string }
export interface Slot { v: Value; dead?: boolean; stmt?: boolean; mem?: PtrV; mty?: import("./types").TypeKind } // mem: a slot that is a place in raw memory (src/interp-mem.ts memSlot)
export interface Ref { k: "ref" | "mut"; slot: Slot; path: Step[] }
export interface ClosureV {
  k: "closure";
  params: string[];
  paramRefs: boolean[]; // parameter i is `&T`: callers hand it a reference
  body: unknown[];
  env: { name: string; slot: Slot }[];
  owning: boolean;
  ret: import("./types").TypeKind;
}
export type Step = string | number;
export type Value = bigint | number | boolean | undefined | Moved | Str | Struct | EnumV | ArrV | VecV | BoxV | MapV | IfaceV | FnRef | ClosureV | Ref | HandleV | PtrV;
export interface Place { slot: Slot; path: Step[]; ro: boolean; viaRef: boolean }

export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const strText = (s: Str) => dec.decode(Uint8Array.from(s.b.bytes));
// A literal's \xNN escapes above 0x7f ride U+F780..U+F7FF (src/lower.ts embedFile uses the same): one raw byte each.
export const literalBytes = (text: string): number[] => {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xf780 && cp <= 0xf7ff) out.push(cp - 0xf700);
    else out.push(...enc.encode(ch));
  }
  return out;
};
export const staticStr = (text: string): Str => ({ k: "str", b: { bytes: literalBytes(text), rc: 1, id: -1 } });

// C's %.17g-style shortest round-trip text, the way the compiled runtime prints a float.
export function fmtFloat(x: number, bits = 64): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  let digits = "";
  for (let p = 1; p <= 17; p++) {
    const s = x.toExponential(p - 1);
    if (bits === 32 ? Math.fround(Number(s)) === x : Number(s) === x) { digits = s; break; }
  }
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(digits || x.toExponential(16))!;
  const sign = m[1]!, ds = m[2]! + (m[3] ?? ""), exp = Number(m[4]);
  if (exp < -4 || exp >= (bits === 32 ? 9 : 17)) {
    const mant = ds.length > 1 ? `${ds[0]}.${ds.slice(1)}` : ds;
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp >= 0) return sign + (ds.length <= exp + 1 ? ds.padEnd(exp + 1, "0") : `${ds.slice(0, exp + 1)}.${ds.slice(exp + 1)}`);
  return `${sign}0.${"0".repeat(-exp - 1)}${ds}`;
}

// Raised by the plain interpreter at the first task operation: the driver reruns the program in the
// task interpreter (a run is deterministic and its output is buffered until the end, so nothing is lost).
export class NeedTasks extends Error {}
