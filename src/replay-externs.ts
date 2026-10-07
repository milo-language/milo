// Compiler-driven record/replay of extern calls (docs/record-replay.md §Extern calls).
//
// A call to a C function is invisible to std/replay unless something records it. Under
// MILO_RECORD / MILO_REPLAY this module makes the compiler do it: for every extern a
// program calls from code that does not record its own calls (anything not marked
// `@replayHooked`), it generates a Milo wrapper, and the checker redirects the call to it.
// The wrapper is one compare when neither variable is set; otherwise it records the
// return value, errno and the output buffers the extern catalog (src/extern-effects.ts) or
// the extern's own `@records(...)` attribute describes, and under replay answers from the
// trace without making the call. An extern that cannot be recorded that way (a pointer
// param with no description, a library that builds pointer-linked results) gets a hole
// wrapper instead, which makes the call and reports, once per run, that it happened.
//
// The wrappers are Milo source, parsed into a synthetic unit (RR_WRAPPER_FILE) that the
// resolver adds after the program's own files, so they are checked and lowered like any
// other code.

import type { Function, MiloType, Program, Span } from "./ast";
import { externEffect, parseOutSpec, cTypeSize, type ExternEffect, type OutSpec, type SizeSpec } from "./extern-effects";
import { formatMiloType } from "./derive-template";

export const RR_WRAPPER_FILE = "<replay wrappers>";

// The std/replay names generated wrappers call.
export const RR_IMPORTS = ["replayOff", "replayHole", "replayCallBegin", "ReplayCall", "replayF64Bits", "replayF64FromBits"];

export interface ReplayPlan {
  /** Wrapper fn name; a variadic extern gets one per arity, `<wrapper>_<nargs>`. */
  wrapper: string;
  variadic: boolean;
  fixed: number;
  /** Set for a hole: why the call cannot be recorded. */
  hole?: string;
}

const INT_NAMES = new Set(["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize"]);
const FLOAT_NAMES = new Set(["f32", "f64"]);

const isPtrish = (t: MiloType) => t.isPtr || (t.ptrDepth ?? 0) > 0 || t.isRef || t.isRefMut || !!t.isNullableRef;
const isVoid = (t: MiloType) => t.name === "void" && !isPtrish(t);
const isScalar = (t: MiloType) => !isPtrish(t) && !t.isArray && !t.isFn && !t.isCFn
  && (INT_NAMES.has(t.name) || FLOAT_NAMES.has(t.name) || t.name === "bool");

export function isReplayHookedFn(fn: Function): boolean {
  return !!fn.fromReplayHookedModule || fn.sourceFile === RR_WRAPPER_FILE
    || !!fn.attributes?.some(a => a.name === "replayHooked");
}

// ── @records validation ──

function sizeParams(s: SizeSpec): string[] {
  if (s.tag === "param" || s.tag === "deref") return [s.name];
  if (s.tag === "cstr" && s.cap) return sizeParams(s.cap);
  return [];
}

// Errors in an extern's `@records(...)` arguments; empty when it is well formed.
export function recordsAttrErrors(fn: Function): string[] {
  const attr = fn.attributes?.find(a => a.name === "records");
  if (!attr) return [];
  const errs: string[] = [];
  const params = new Map(fn.params.map(p => [p.name, p.type]));
  for (const arg of attr.args) {
    const spec = parseOutSpec(arg);
    if (typeof spec === "string") { errs.push(spec); continue; }
    if (spec.param === "ret") {
      if (spec.size.tag !== "cstr") errs.push(`'${arg}': a pointer return can only be described as 'ret[cstr]'`);
      continue;
    }
    const t = params.get(spec.param);
    if (t === undefined) { errs.push(`'${arg}': '${fn.name}' has no parameter '${spec.param}'`); continue; }
    if (!t || !isPtrish(t)) errs.push(`'${arg}': '${spec.param}' is not a pointer, so the call cannot write through it`);
    if (spec.size.tag === "sizeof") errs.push(`'${arg}': write the byte count instead of sizeof`);
    for (const n of sizeParams(spec.size)) if (!params.has(n)) errs.push(`'${arg}': '${fn.name}' has no parameter '${n}'`);
  }
  if (isPtrish(fn.retType) && !attr.args.some(a => a.trim().startsWith("ret["))) {
    errs.push(`it returns a pointer; say what it points at with "ret[cstr]"`);
  }
  return errs;
}

// ── which externs a program calls, and from where ──

// Every call's callee name and arity in `node`, skipping nothing: a closure's body runs
// in its enclosing fn's context, which is what decides whether the call is redirected.
function collectCalls(node: unknown, out: Map<string, Set<number>>, seen = new Set<unknown>()): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) { for (const n of node) collectCalls(n, out, seen); return; }
  const n = node as { kind?: string; func?: unknown; args?: unknown[] };
  if (n.kind === "Call" && typeof n.func === "string") {
    let s = out.get(n.func);
    if (!s) { s = new Set(); out.set(n.func, s); }
    s.add(n.args?.length ?? 0);
  }
  for (const [k, v] of Object.entries(node)) if (k !== "span") collectCalls(v, out, seen);
}

// ── wrapper generation ──

interface Target { os: string; arch: string }

class Unsupported extends Error {}

function ptrExpr(p: { name: string; type: MiloType }): string {
  const t = p.type;
  if ((t.isRef || t.isRefMut) && !t.isNullableRef) return `(${p.name}.addrOf() as *u8)`;
  return `(${p.name} as *u8)`;
}

function pointee(t: MiloType): string {
  const depth = t.ptrDepth ?? (t.isPtr ? 1 : 0);
  if ((t.isRef || t.isRefMut) && depth === 0) return t.name;
  if (depth === 1) return t.name;
  return "";
}

class Gen {
  lines: string[] = [];
  constructor(private target: Target) {}

  private params(fn: Function): { name: string; type: MiloType }[] {
    return fn.params.map(p => {
      if (!p.type) throw new Unsupported("untyped param");
      return { name: p.name, type: p.type };
    });
  }

  // The wrapper's param list, the variadic tail as `va<i>: i64`, then the call site.
  private sig(fn: Function, name: string, extra: number): string {
    const ps = this.params(fn).map(p => {
      const t = p.type.isNullableRef ? { ...p.type, isRef: false, isRefMut: false, isPtr: true } : p.type;
      return `${p.name}: ${formatMiloType(t)}`;
    });
    for (let i = 0; i < extra; i++) ps.push(`va${i}: i64`);
    ps.push("_site: *u8");
    return `fn ${name}(${ps.join(", ")}): ${formatMiloType(fn.retType)} {`;
  }

  private callArgs(fn: Function, extra: number): string {
    const as = this.params(fn).map(p => (p.type.isRefMut && !p.type.isNullableRef) ? `&mut ${p.name}` : p.name);
    for (let i = 0; i < extra; i++) as.push(`va${i}`);
    return `${fn.name}(${as.join(", ")})`;
  }

  private size(fn: Function, s: SizeSpec, retVar: string): string {
    const params = new Map(this.params(fn).map(p => [p.name, p]));
    switch (s.tag) {
      case "bytes": return `${s.n}`;
      case "ret": return `${s.k} * (${retVar} as i64)`;
      case "param": {
        const p = params.get(s.name);
        if (!p || !isScalar(p.type) || FLOAT_NAMES.has(p.type.name)) throw new Unsupported(`no integer param '${s.name}' to size it by`);
        return `${s.k} * (${s.name} as i64)`;
      }
      case "deref": {
        const p = params.get(s.name);
        if (!p) throw new Unsupported(`no param '${s.name}' to size it by`);
        const inner = pointee(p.type);
        if (!INT_NAMES.has(inner)) throw new Unsupported(`size param ${s.name} does not point at an integer`);
        return `${s.k} * ((${ptrExpr(p)} as *${inner})[0] as i64)`;
      }
      case "sizeof": {
        const n = cTypeSize(s.ctype, this.target.os, this.target.arch);
        if (n === undefined) throw new Unsupported(`no size for ${s.ctype} on ${this.target.os}`);
        return `${n}`;
      }
      default: throw new Unsupported(`size ${s.tag}`);
    }
  }

  // A wrapper that records and replays the call.
  record(fn: Function, name: string, extra: number, e: { kind: string; outs: OutSpec[]; in: string[]; ret?: string; net: boolean }): string[] {
    const L: string[] = [];
    const ps = this.params(fn);
    const byName = new Map(ps.map(p => [p.name, p]));
    const ret = fn.retType;
    const net = e.net ? "true" : "false";
    const call = this.callArgs(fn, extra);
    const deep = e.outs.filter(o => o.size.tag === "deep");
    const outs = e.outs.filter(o => o.size.tag !== "deep");
    for (const o of e.outs) {
      const p = byName.get(o.param);
      if (!p || !isPtrish(p.type)) throw new Unsupported(`no pointer param '${o.param}' to record`);
    }
    const retPtr = isPtrish(ret);
    if (retPtr && !e.ret) throw new Unsupported("pointer return with no description");
    if (!retPtr && !isVoid(ret) && !isScalar(ret)) throw new Unsupported("non-scalar return");

    // A small shell LLVM inlines into every call site, so the cost when neither variable
    // is set is the one compare; the recording and replaying body is its own fn.
    const slow = `${name}_rr`;
    const fwd = [...ps.map(p => (p.type.isRefMut && !p.type.isNullableRef) ? `&mut ${p.name}` : p.name),
      ...Array.from({ length: extra }, (_, i) => `va${i}`), "_site"].join(", ");
    L.push(this.sig(fn, name, extra));
    L.push(`    if replayOff() {`);
    L.push(isVoid(ret) ? `        unsafe { ${call} }\n        return` : `        unsafe { return ${call} }`);
    L.push(`    }`);
    L.push(isVoid(ret) ? `    ${slow}(${fwd})` : `    return ${slow}(${fwd})`);
    L.push(`}`, ``);
    L.push(this.sig(fn, slow, extra));
    // One unsafe block for the rest: it casts pointers and calls the extern throughout.
    L.push(`    unsafe {`);
    L.push(`    var c = replayCallBegin("${e.kind}")`);
    const inNames = new Map<string, SizeSpec | null>();
    for (const i of e.in) {
      const spec = parseOutSpec(i);
      if (typeof spec === "string") inNames.set(i, null);
      else inNames.set(spec.param, spec.size);
    }
    for (const p of ps) {
      if (isScalar(p.type)) {
        if (FLOAT_NAMES.has(p.type.name)) L.push(`    c.argInt(replayF64Bits(${p.name} as f64))`);
        else if (p.type.name === "bool") L.push(`    if ${p.name} {\n        c.argInt(1)\n    } else {\n        c.argInt(0)\n    }`);
        else L.push(`    c.argInt(${p.name} as i64)`);
      } else if (inNames.has(p.name)) {
        const sz = inNames.get(p.name);
        if (sz === null || sz === undefined) L.push(`    c.argCstr(${ptrExpr(p)})`);
        else L.push(`    c.argBytes(${ptrExpr(p)}, ${this.size(fn, sz, "0")})`);
      }
    }
    for (let i = 0; i < extra; i++) L.push(`    c.argInt(va${i})`);
    // A pointer-linked result cannot be copied back; a call that asks for one is a hole.
    for (const d of deep) {
      L.push(`    if ${ptrExpr(byName.get(d.param)!)} as i64 != 0 {\n        replayHole("${fn.name}", _site)\n    }`);
    }
    const rt = formatMiloType(ret);
    // replay
    L.push(`    if c.replaying() {`);
    L.push(`        c.take(${net})`);
    for (const o of outs) L.push(`        c.outInto(${ptrExpr(byName.get(o.param)!)})`);
    if (isVoid(ret)) L.push(`        return`);
    else if (retPtr) {
      const k = e.ret!;
      if (k === "cstr" || k.startsWith("static:")) L.push(`        return c.outCopy() as ${rt}`);
      else if (k === "handle") L.push(`        return c.retVal() as ${rt}`);
      else if (k.startsWith("param:")) {
        const p = byName.get(k.slice(6));
        if (!p) throw new Unsupported(`ret ${k}`);
        L.push(`        if c.retVal() == 0 {\n            return 0 as ${rt}\n        }\n        return ${p.name}`);
      } else throw new Unsupported(`ret ${k}`);
    } else if (FLOAT_NAMES.has(ret.name)) L.push(`        return replayF64FromBits(c.retVal()) as ${rt}`);
    else if (ret.name === "bool") L.push(`        return c.retVal() != 0`);
    else L.push(`        return c.retVal() as ${rt}`);
    L.push(`    }`);
    // record
    if (isVoid(ret)) L.push(`    ${call}`);
    else L.push(`    let r: ${rt} = ${call}`);
    L.push(`    c.saveErrno(${net})`);
    if (isVoid(ret)) L.push(`    c.setRet(0)`);
    else if (retPtr) {
      const k = e.ret!;
      if (k === "handle") L.push(`    c.setRet(r as i64)`);
      else L.push(`    if r as i64 != 0 {\n        c.setRet(1)\n    }`);
    } else if (FLOAT_NAMES.has(ret.name)) L.push(`    c.setRet(replayF64Bits(r as f64))`);
    else if (ret.name === "bool") L.push(`    if r {\n        c.setRet(1)\n    }`);
    else L.push(`    c.setRet(r as i64)`);
    const retVar = isVoid(ret) || retPtr || ret.name === "bool" || FLOAT_NAMES.has(ret.name) ? "0" : "r";
    for (const o of outs) {
      const p = ptrExpr(byName.get(o.param)!);
      if (o.size.tag === "cstr") {
        L.push(`        c.outCstr(${p}, ${o.size.cap ? this.size(fn, o.size.cap, retVar) : "-1"})`);
      } else if (o.size.tag === "ret") {
        if (retVar === "0") throw new Unsupported("ret-sized output without an integer return");
        L.push(`        if (r as i64) < 0 {\n            c.outFrom(${p}, -1)\n        } else {\n            c.outFrom(${p}, ${this.size(fn, o.size, retVar)})\n        }`);
      } else {
        L.push(`        c.outFrom(${p}, ${this.size(fn, o.size, retVar)})`);
      }
    }
    if (retPtr) {
      const k = e.ret!;
      if (k === "cstr") L.push(`        c.outCstr(r as *u8, -1)`);
      else if (k.startsWith("static:")) {
        const spec = parseOutSpec(`r[${k.slice(7)}]`);
        if (typeof spec === "string") throw new Unsupported(spec);
        L.push(`        c.outFrom(r as *u8, ${this.size(fn, spec.size, "0")})`);
      }
    }
    L.push(`    c.put(${net})`);
    L.push(isVoid(ret) ? `    return` : `    return r`);
    L.push(`    }`);
    L.push(`}`);
    return L;
  }

  // A wrapper that makes the call and reports, once per run, that it went unrecorded.
  hole(fn: Function, name: string, extra: number): string[] {
    const call = this.callArgs(fn, extra);
    return [
      this.sig(fn, name, extra),
      `    if !replayOff() {`,
      `        replayHole("${fn.name}", _site)`,
      `    }`,
      isVoid(fn.retType) ? `    unsafe { ${call} }` : `    unsafe { return ${call} }`,
      `}`,
    ];
  }
}

// What recording an extern needs, or why it is a hole. undefined: leave its calls alone.
function classify(fn: Function, os: string): { record?: { kind: string; outs: OutSpec[]; in: string[]; ret?: string; net: boolean }; hole?: string } | undefined {
  if (fn.attributes?.some(a => a.name === "pure")) return undefined;
  const kind = `x.${fn.name}`;
  const recordsAttr = fn.attributes?.find(a => a.name === "records");
  if (recordsAttr) {
    const outs: OutSpec[] = [];
    let ret: string | undefined;
    for (const a of recordsAttr.args) {
      const s = parseOutSpec(a);
      if (typeof s === "string") return undefined; // reported by the checker
      if (s.param === "ret") ret = "cstr";
      else outs.push(s);
    }
    return { record: { kind, outs, in: [], ret, net: false } };
  }
  const e: ExternEffect | undefined = externEffect(fn.name, os);
  if (e) {
    switch (e.effect) {
      case "pure": case "local": return undefined;
      case "sync": return { hole: "a raw thread or lock primitive: the order other threads see it in is not recorded (use std/sync)" };
      case "sched": return { hole: "an event-loop wait outside std/runtime, whose decisions are not recorded" };
      case "hole": return { hole: e.why ?? "it cannot be recorded" };
    }
    const outs: OutSpec[] = [];
    for (const o of e.out ?? []) {
      const s = parseOutSpec(o);
      if (typeof s === "string") throw new Error(`extern-effects.ts: ${fn.name}: ${s}`);
      outs.push(s);
    }
    return { record: { kind: e.kind ?? kind, outs, in: e.in ?? [], ret: e.ret, net: e.errno === "net" } };
  }
  const scalarOnly = fn.params.every(p => p.type && isScalar(p.type)) && (isVoid(fn.retType) || isScalar(fn.retType));
  if (scalarOnly && !fn.isVariadic) return { record: { kind, outs: [], in: [], net: false } };
  return { hole: `it takes or returns a pointer and has no @records description or std catalog entry` };
}

/**
 * Plan and generate the wrappers for every extern `fns` call from code that does not
 * record its own calls. Returns undefined when there is nothing to wrap.
 */
export function planReplayWrappers(programs: Program[], target: Target): { plans: Map<string, ReplayPlan>; source: string } | undefined {
  if (target.os !== "darwin" && target.os !== "linux" && target.os !== "windows") return undefined;
  const externs = new Map<string, Function>();
  const calls = new Map<string, Set<number>>();
  for (const p of programs) {
    for (const f of p.functions) {
      // Last wins, as in the resolver's merge: the decl the program ends up with. A Milo
      // fn that wins over an extern of the same name (a program's own `fn pipe` next to
      // std/platform's `extern fn pipe`) is what every call binds to, wrapper included.
      if (f.isExtern) { externs.set(f.name, f); continue; }
      externs.delete(f.name);
      if (!isReplayHookedFn(f)) collectCalls(f.body, calls);
    }
    for (const im of p.impls) for (const m of im.methods) if (!isReplayHookedFn(m)) collectCalls(m.body, calls);
    for (const g of p.globals) collectCalls(g.value, calls);
  }
  const gen = new Gen(target);
  const plans = new Map<string, ReplayPlan>();
  const src: string[] = [`from "std/replay" import { ${RR_IMPORTS.join(", ")} }`, ""];
  for (const [name, arities] of calls) {
    const fn = externs.get(name);
    if (!fn) continue;
    const c = classify(fn, target.os);
    if (!c) continue;
    const base = c.hole ? `__rrh_${name}` : `__rrx_${name}`;
    const fixed = fn.params.length;
    const plan: ReplayPlan = { wrapper: base, variadic: fn.isVariadic, fixed, ...(c.hole && { hole: c.hole }) };
    const names = fn.isVariadic ? [...arities].filter(n => n >= fixed).map(n => ({ name: `${base}_${n}`, extra: n - fixed })) : [{ name: base, extra: 0 }];
    let ok = true;
    let reason = "";
    const body: string[] = [];
    for (const w of names) {
      try {
        body.push(...(c.hole ? gen.hole(fn, w.name, w.extra) : gen.record(fn, w.name, w.extra, c.record!)), "");
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        ok = false;
        reason = err.message;
      }
    }
    if (!ok) {
      // The description cannot be turned into a wrapper on this target: report it as a
      // hole rather than record it wrong.
      // A catalog entry names std's declaration's params; a program that redeclares the
      // extern under other names, or a size the target has no value for, lands here.
      const why = `its description cannot be recorded on ${target.os} (${reason}); describe it with @records`;
      body.length = 0;
      const holeBase = `__rrh_${name}`;
      for (const w of names) body.push(...gen.hole(fn, w.name.replace(base, holeBase), w.extra), "");
      plans.set(name, { wrapper: holeBase, variadic: fn.isVariadic, fixed, hole: why });
    } else {
      plans.set(name, plan);
    }
    src.push(...body);
  }
  if (plans.size === 0) return undefined;
  return { plans, source: src.join("\n") };
}

/** `file:line` for a hole report, with a std path shortened to `std/x.milo`. */
export function replaySite(span: Span | undefined, stdlibDir: string, cwd: string): string {
  if (!span?.file) return "?";
  let f = span.file;
  if (f.startsWith(stdlibDir + "/std/")) f = f.slice(stdlibDir.length + 1);
  else if (f.startsWith(cwd + "/")) f = f.slice(cwd.length + 1);
  return `${f}:${span.line ?? 0}`;
}
