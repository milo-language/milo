// The one fixed runtime piece still kept as LLVM IR text: the atomics (src/runtime/atomic.ll),
// linked into milo-opt's module (mlir/Link.cpp). Each is a single LLVM atomic instruction with
// a memory order Milo's source has no way to spell, so a typed builder or Milo code would add
// nothing. Everything else the backend calls by name (strings, formatting, map and Vec buffers,
// drop glue) is Milo code in std/rt.milo.
//
// The text import is embedded by `bun build --compile`, so a shipped binary carries it like the
// bundled stdlib.
import ATOMIC_LL from "./runtime/atomic.ll" with { type: "text" };
import type { TargetInfo } from "./target";

const FILE = "src/runtime/atomic.ll";

// `; @@ key` starts a section, which runs to the next marker. Every other whole-line `;`
// comment is documentation and is dropped, as is a section's trailing blank space, so a
// section prints exactly the lines it holds and comments can be added without changing IR.
export function parseSections(text: string): Map<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    const m = /^; @@ (\S+)\s*$/.exec(line);
    if (m) {
      if (sections.has(m[1])) throw new Error(`${FILE}: section ${m[1]} defined twice`);
      sections.set(m[1], cur = []);
    } else if (/^\s*;/.test(line)) {
      continue;
    } else if (cur) {
      cur.push(line);
    } else if (line.trim() !== "") {
      throw new Error(`${FILE}: '${line}' is outside any '; @@' section`);
    }
  }
  for (const body of sections.values()) while (body.length && body[body.length - 1].trim() === "") body.pop();
  return sections;
}

const SECTIONS = parseSections(ATOMIC_LL);
export const runtimeSectionKeys = (): string[] => [...SECTIONS.keys()];

/**
 * The lines of section `key`, with each `{{name}}` replaced from `subst`. A line that is
 * only `{{name}}` takes a string[] and expands to those lines (a variant block). A
 * placeholder without a value, or a value without a placeholder, throws: either one means
 * the section and its caller disagree about what the helper references.
 */
export function runtimeFn(key: string, subst: Record<string, string | readonly string[]> = {}): string[] {
  const body = SECTIONS.get(key);
  if (!body) throw new Error(`${FILE}: no section ${key}`);
  const used = new Set<string>();
  const value = (k: string): string | readonly string[] => {
    if (!(k in subst)) throw new Error(`${FILE}: section ${key} needs a value for {{${k}}}`);
    used.add(k);
    return subst[k];
  };
  const out: string[] = [];
  for (const l of body) {
    const whole = /^\s*\{\{(\w+)\}\}\s*$/.exec(l);
    const v = whole ? value(whole[1]) : null;
    if (Array.isArray(v)) { out.push(...v); continue; }
    out.push(l.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const s = value(k);
      if (typeof s !== "string") throw new Error(`${FILE}: section ${key} uses {{${k}}} inside a line, which takes a string`);
      return s;
    }));
  }
  for (const k of Object.keys(subst)) if (!used.has(k)) throw new Error(`${FILE}: section ${key} has no {{${k}}}`);
  return out;
}

// std's `_atomic<Op><Width>` builtins, one instance of a milo.atomic.* section each. Every
// one is sequentially consistent: Milo deliberately exposes no ordering parameter (see
// docs/site/features/concurrency.md). `bool` widths hold an i1 in a byte of memory.
export const ATOMIC_INTRINSICS: Record<string, { kind: "load" | "store" | "rmw" | "cas"; rmwOp?: string; ty: string; align: number }> = {
  _atomicLoadI64: { kind: "load", ty: "i64", align: 8 },
  _atomicStoreI64: { kind: "store", ty: "i64", align: 8 },
  _atomicAddI64: { kind: "rmw", rmwOp: "add", ty: "i64", align: 8 },
  _atomicSubI64: { kind: "rmw", rmwOp: "sub", ty: "i64", align: 8 },
  _atomicSwapI64: { kind: "rmw", rmwOp: "xchg", ty: "i64", align: 8 },
  _atomicCasI64: { kind: "cas", ty: "i64", align: 8 },
  _atomicLoadI32: { kind: "load", ty: "i32", align: 4 },
  _atomicStoreI32: { kind: "store", ty: "i32", align: 4 },
  _atomicAddI32: { kind: "rmw", rmwOp: "add", ty: "i32", align: 4 },
  _atomicSubI32: { kind: "rmw", rmwOp: "sub", ty: "i32", align: 4 },
  _atomicSwapI32: { kind: "rmw", rmwOp: "xchg", ty: "i32", align: 4 },
  _atomicCasI32: { kind: "cas", ty: "i32", align: 4 },
  _atomicLoadBool: { kind: "load", ty: "i8", align: 1 },
  _atomicStoreBool: { kind: "store", ty: "i8", align: 1 },
  _atomicSwapBool: { kind: "rmw", rmwOp: "xchg", ty: "i8", align: 1 },
  _atomicCasBool: { kind: "cas", ty: "i8", align: 1 },
};
/** The runtime function behind `_atomic<Op><Width>`, or null for any other name. */
export const atomicFn = (builtin: string): string | null => ATOMIC_INTRINSICS[builtin] ? `milo.atomic.${builtin}` : null;

/**
 * The std/rt function that grows a Vec buffer of `elemSize`-byte elements. A zero-sized
 * element is never realloc'd (realloc(p, 0) may free p), and Cortex-M's bump heap (os
 * "none") has no realloc at all.
 */
export const vecGrowFn = (target: TargetInfo, elemSize: number): string => target.os !== "none" && elemSize > 0 ? "rtVecGrowRealloc" : "rtVecGrowCopy";

/** The std/rt function that appends a scalar of each kind to a string (see pushScalar). */
export const PUSH_SCALAR_FN = { i64: "rtStringPushI64", u64: "rtStringPushU64", f64: "rtStringPushF64", f32: "rtStringPushF32", bool: "rtStringPushBool", ptr: "rtStringPushPtr" } as const;

/** Every atomic section, as one LLVM module's text. */
export function runtimeModule(): string {
  const out: string[] = [];
  for (const [builtin, spec] of Object.entries(ATOMIC_INTRINSICS)) {
    const key = { load: "milo.atomic.load", store: "milo.atomic.store", rmw: "milo.atomic.rmw", cas: "milo.atomic.cas" }[spec.kind];
    out.push("", ...runtimeFn(key, { name: atomicFn(builtin)!, ty: spec.ty, align: String(spec.align), ...(spec.kind === "rmw" ? { op: spec.rmwOp! } : {}) }));
  }
  return out.join("\n") + "\n";
}
