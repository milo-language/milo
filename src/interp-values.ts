// Reference interpreter, values and state: the shapes docs/semantics/mini-milo.md §2 calls
// slots, places and values, plus the errors the interpreter raises. No rules live here.
//
// Representation choices (the spec leaves them open):
//   int      bigint, wrapped to its type by the rule that made it   float  number
//   struct   fields in declaration order; a moved field holds MOVED
//   string   a counted buffer (spec §5, strings): a copy shares it, the last drop frees it
//   Vec      a header {buf,start,len,cap} owned by its slot over a buffer on the heap
//   Heap<T>  box: one cell on the heap

export class InterpUnsupported extends Error {
  constructor(public what: string) { super(`interp: unsupported: ${what}`); }
}

// The program reached a state no rule applies to. For a program the checker accepted this is
// a checker bug or a spec bug, which is exactly what the interpreter exists to show.
export class InterpStuck extends Error {
  constructor(public rule: string, detail: string) { super(`interp: stuck at ${rule}: ${detail}`); }
}

// A runtime trap the program asked for (assert, bounds, overflow, unwrap of None).
export class Panic extends Error {}
export class ExitProgram { constructor(public code: number) {} }

export interface Moved { k: "moved" }
export const MOVED: Moved = { k: "moved" };

export interface StrBuf { bytes: number[]; rc: number; id: number } // id < 0: static, never counted
export interface Str { k: "str"; b: StrBuf }
export interface Struct { k: "struct"; name: string; f: Record<string, Value> }
export interface EnumV { k: "enum"; en: string; variant: string; tag: number; a: Value[] }
export interface ArrV { k: "arr"; e: Value[] }
export interface VecBuf { id: number; elems: Value[] }
// `view`: a slice, which borrows the buffer and drops nothing. `buf` null: nothing allocated.
export interface VecV { k: "vec"; buf: VecBuf | null; start: number; len: number; cap: number; view: boolean }
export interface BoxV { k: "box"; id: number; cell: { v: Value } }
export interface IfaceV { k: "iface"; concrete: string; inner: Value }
export interface FnRef { k: "fn"; name: string }
export interface Slot { v: Value; dead?: boolean }
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
export type Value = bigint | number | boolean | undefined | Moved | Str | Struct | EnumV | ArrV | VecV | BoxV | IfaceV | FnRef | ClosureV | Ref;
export interface Place { slot: Slot; path: Step[]; ro: boolean; viaRef: boolean }

export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const strText = (s: Str) => dec.decode(Uint8Array.from(s.b.bytes));
export const staticStr = (text: string): Str => ({ k: "str", b: { bytes: [...enc.encode(text)], rc: 1, id: -1 } });

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
