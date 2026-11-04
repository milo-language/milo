// The fixed runtime helpers (string buffers, int and float formatting, map buffers, atomics),
// kept as LLVM IR text in src/runtime/*.ll and linked into milo-opt's module (mlir/Link.cpp).
//
// Their text never varies per program, only per target, so a typed builder would add no
// checking to them, only lines. The whole set goes to every build: the link takes only the
// functions something calls. The text import is embedded by `bun build --compile`, so a
// shipped binary carries it like the bundled stdlib.
import STR_LL from "./runtime/str.ll" with { type: "text" };
import MAP_LL from "./runtime/map.ll" with { type: "text" };
import ATOMIC_LL from "./runtime/atomic.ll" with { type: "text" };
import type { TargetInfo } from "./target";

const FILE = "src/runtime/*.ll";

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

const SECTIONS = new Map<string, readonly string[]>();
for (const text of [STR_LL, MAP_LL, ATOMIC_LL]) {
  for (const [k, body] of parseSections(text)) {
    if (SECTIONS.has(k)) throw new Error(`${FILE}: section ${k} defined twice`);
    SECTIONS.set(k, body);
  }
}
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

// Below this many live bytes a grow is malloc + memcpy + free rather than realloc. A
// small block cannot be remapped, so realloc saves no memory there, and macOS's realloc
// first looks the pointer's zone and size up: respond's string building (buffers of a
// few hundred bytes) ran 13% slower on realloc than on the copy. At a page and above
// the remap is what keeps peak RSS at the new size (vec_grow: 132 MB -> 68 MB).
const REALLOC_MIN_BYTES = "4096";

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

/** The vec grow helper for elements of `elemSize` bytes (a zero-sized element is never realloc'd). */
export const vecGrowFn = (target: TargetInfo, elemSize: number): string => hasRealloc(target) && elemSize > 0 ? "milo.vec.grow.realloc" : "milo.vec.grow.copy";

// Cortex-M's bump heap (tools/cortex-m/startup.c) has no block headers, so it cannot
// implement realloc; every other target's allocator has one (wasm's runtime.c, libc,
// std/replay's heap).
export const hasRealloc = (target: TargetInfo): boolean => target.os !== "none";

// A bare-metal target (Cortex-M, os "none") has no threads to share a string with, and
// 32-bit M-profile cores have no 64-bit atomic instructions: LLVM would lower the count
// updates to `__atomic_*_8` libcalls that nothing there provides. Plain loads and stores
// say the same thing single-threaded.
function singleThreaded(body: string[]): string[] {
  return body.flatMap(l => {
    const load = l.match(/^(\s+%\S+) = load atomic i64, ptr (%\S+) \w+, align 8$/);
    if (load) return [`${load[1]} = load i64, ptr ${load[2]}, align 8`];
    const rmw = l.match(/^\s+(%\S+) = atomicrmw (add|sub) ptr (%\S+), i64 1 \w+, align 8$/);
    if (rmw) {
      const [, old, op, p] = rmw;
      return [`  ${old} = load i64, ptr ${p}, align 8`, `  ${old}.n = ${op} i64 ${old}, 1`, `  store i64 ${old}.n, ptr ${p}, align 8`];
    }
    if (l.trim() === "fence acquire") return [];
    return [l];
  });
}

// What the sections call that they do not define: libc, one intrinsic, and the overflow
// panic routine the scaffold defines (src/scaffold.ts). The link merges these with the
// program's own declarations.
const PRELUDE = [
  "%String = type { ptr, i64, i64 }",
  "declare ptr @malloc(i64)",
  "declare void @free(ptr)",
  "declare ptr @realloc(ptr, i64)",
  "declare ptr @memcpy(ptr, ptr, i64)",
  "declare i32 @memcmp(ptr, ptr, i64)",
  "declare ptr @memset(ptr, i32, i64)",
  "declare i32 @snprintf(ptr, i64, ptr, ...)",
  "declare double @strtod(ptr, ptr)",
  "declare float @strtof(ptr, ptr)",
  "declare {i64, i1} @llvm.umul.with.overflow.i64(i64, i64)",
  "declare void @__milo_overflow_fail(ptr, i32)",
];
/** The scaffold functions the runtime calls: they must exist whether or not the program calls them. */
export const RUNTIME_NEEDS = ["__milo_overflow_fail"];

const cstr = (name: string, s: string) => `${name} = private unnamed_addr constant [${s.length + 1} x i8] c"${s}\\00"`;

const runtimeTexts = new Map<string, string>();
/** Every runtime section for `target`, as one LLVM module's text. */
export function runtimeModule(target: TargetInfo, noalias: boolean): string {
  const key = `${target.triple}/${target.os}/${noalias}`;
  const known = runtimeTexts.get(key);
  if (known) return known;
  const realloc = hasRealloc(target);
  const none = target.os === "none";
  let pairs = "";
  for (let i = 0; i < 100; i++) pairs += String(i).padStart(2, "0");
  const out: string[] = [...PRELUDE, cstr("@milo.rt.digits", pairs), cstr("@milo.rt.where", "<string allocation>")];
  const add = (body: string[]) => out.push("", ...body);
  add(runtimeFn("milo.strfind"));
  add(runtimeFn("milo.strview.step"));
  add(runtimeFn("milo.fmt.u64", { table: "@milo.rt.digits" }));
  add(runtimeFn("milo.fmt.i64"));
  // The string runtime proper: the reference count (see the sections' comments).
  const str = runtimeFn("milo.str.oom", { where: "@milo.rt.where" });
  for (const k of ["milo.str.alloc", "milo.str.free", "milo.str.release", "milo.str.from", "milo.str.share", "milo.str.unique"]) str.push("", ...runtimeFn(k));
  if (realloc) str.push("", ...runtimeFn("milo.str.realloc"));
  add(none ? singleThreaded(str) : str);
  const grow = runtimeFn(realloc ? "milo.str.reserve.grow.realloc" : "milo.str.reserve.grow.copy");
  add(runtimeFn("milo.str.reserve", { grow, reallocMin: REALLOC_MIN_BYTES, reIn: realloc ? `[ %r, %re ]` : `[ %r, %re ], [ %r, %recp ]` }));
  for (const k of ["milo.fmt.g", "milo.fmt.f64", "milo.fmt.f32", "milo.string.concat", "milo.string.append", "milo.string.eq", "milo.string.cmp"]) add(runtimeFn(k));
  add(runtimeFn("milo.string.reserve", { rcload: none ? "load i64, ptr %hdr, align 8" : "load atomic i64, ptr %hdr acquire, align 8" }));
  for (const k of ["milo.string.push_i64", "milo.string.push_u64", "milo.string.push_f64", "milo.string.push_f32", "milo.string.push_bool", "milo.string.push_ptr", "milo.string.push_json", "milo.string.cstr"]) add(runtimeFn(k));
  for (const k of ["milo.string.drop", "milo.closure.drop", "milo.iface.drop"]) add(runtimeFn(k));
  for (const k of ["milo.map.alloc", "milo.hash.byte", "milo.hash.u64", "milo.hash.bytes", "milo.buf.clone", "milo.buf.alloc"]) add(runtimeFn(k));
  add(runtimeFn("milo.vec.grow.copy"));
  if (realloc) add(runtimeFn("milo.vec.grow.realloc", { reallocMin: REALLOC_MIN_BYTES }));
  for (const [builtin, spec] of Object.entries(ATOMIC_INTRINSICS)) {
    const key = { load: "milo.atomic.load", store: "milo.atomic.store", rmw: "milo.atomic.rmw", cas: "milo.atomic.cas" }[spec.kind];
    add(runtimeFn(key, { name: atomicFn(builtin)!, ty: spec.ty, align: String(spec.align), ...(spec.kind === "rmw" ? { op: spec.rmwOp! } : {}) }));
  }
  // Some sections spell `noalias` on their string param; --no-noalias must rule out every
  // noalias in the module, these included, or it cannot clear one as a miscompile's cause.
  const text = out.map(l => noalias || !l.startsWith("define ") ? l : l.replaceAll("ptr noalias ", "ptr ")).join("\n") + "\n";
  runtimeTexts.set(key, text);
  return text;
}
