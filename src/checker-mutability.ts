// Two "say what you mean" warnings that need the finished program, so they run with the
// whole-program passes: `var-never-reassigned` (a `var` nothing writes after its
// initializer) and `unwritten-mut-param` (a `&mut T` param nothing writes through).
//
// Both read the checker's own notion of "this place is written": the sets it fills while it
// enforces mutability (`writtenExprs`, `autoBorrowed`, `explicitMutArgs`, `matchSubjectMut`)
// plus the statement shapes it handles directly (assignment, `for .. in &mut`, `&mut x`,
// closure write-back). A write the checker enforces on a `let` therefore cannot be missed
// here, which is what makes the `var` -> `let` fix leave a program that still checks.
//
// Names are matched per function, not per scope: a write to any `x` in a function keeps
// every `var x` in it. That only ever loses a hit, never invents one.
//
// std is checked like user code: it has to stay clean, because every user program compiles
// the std modules it imports.
//
// This file is the pass itself, in the portable subset: plain data in, findings out. The
// checker's object-keyed facts reach it as `MutFacts` through src/checker-mutability-host.ts.
import type { Function, Span } from "./ast";
import { walkStmts } from "./ast-walk";
import { MutScan, isTrue } from "./mutability-scan";
import type { MutFacts } from "./mutability-scan";

export interface FnEntry {
  name: string;
  // Id of the first node of this function's body (ids run in pre-order over each body).
  base: number;
  fn: Function;
  // Whether the checker has a signature for it, and which of its params are references.
  hasSig: boolean;
  refParams: boolean[];
}

export interface MutInput {
  facts: MutFacts;
  // Every function the passes can walk, in the order the program view lists them.
  view: FnEntry[];
  // The free functions of the program, in declaration order.
  program: FnEntry[];
}

export interface Note { message: string; span: Span }
export interface Finding { code: string; message: string; hint: string; span: Span; len: number; notes: Note[] }

const ROOT_PARENT_ID = -1;

export function newScan(facts: MutFacts): MutScan {
  const mutated = new Set<number>(facts.mutated);
  const aggregate = new Set<number>(facts.aggregate);
  const arrays = new Set<number>(facts.arrays);
  const rootIdx = new Map<number, number>();
  const capIdx = new Map<number, number>();
  const callIdx = new Map<number, number>();
  let i = 0;
  while (i < facts.roots.length) {
    rootIdx.set(facts.roots[i].id, i);
    i++;
  }
  i = 0;
  while (i < facts.captures.length) {
    if (!capIdx.has(facts.captures[i].id)) { capIdx.set(facts.captures[i].id, i); }
    i++;
  }
  i = 0;
  while (i < facts.calls.length) {
    callIdx.set(facts.calls[i].id, i);
    i++;
  }
  return new MutScan(facts, mutated, aggregate, arrays, rootIdx, capIdx, callIdx);
}

// Runs one walk of `fn`'s body in `mode` and leaves the result in the scan.
export function scanBody(scan: MutScan, base: number, mode: number, watch: string, fn: Function): void {
  scan.begin(base, mode, watch);
  walkStmts(scan, fn.body, { kind: "None", id: ROOT_PARENT_ID, op: "" }, "");
}

function startsWithAngle(name: string): boolean {
  return name.length > 0 && name.charCodeAt(0) === 60;
}

function hasAttributes(f: Function): boolean {
  if (f.attributes !== undefined) { return f.attributes.length > 0; }
  return false;
}

function isRefMutParam(f: Function, i: number): boolean {
  if (f.params[i].type !== null) { return f.params[i].type.isRefMut; }
  return false;
}

export function mutabilityFindings(input: MutInput): Finding[] {
  const scan = newScan(input.facts);
  const out: Finding[] = [];

  // ── var-never-reassigned ─────────────────────────────────────────────────────────
  // Generic bodies are checked once per instance, each a clone with the same spans: a
  // `var` is reported only when every copy leaves it unwritten.
  let i = 0;
  while (i < input.view.length) {
    const e = input.view[i];
    if (!startsWithAngle(e.name) && !e.fn.isExtern && e.fn.typeParams.length === 0) {
      scanBody(scan, e.base, 0, "", e.fn);
      scanBody(scan, e.base, 1, "", e.fn);
    }
    i++;
  }
  i = 0;
  while (i < scan.vars.length) {
    if (scan.vars[i].ok) {
      out.push({
        code: "var-never-reassigned",
        message: `'${scan.vars[i].name}' is never reassigned`,
        hint: `declare it with 'let': nothing writes to it after its initializer`,
        span: scan.vars[i].span,
        len: 3,
        notes: [],
      });
    }
    i++;
  }

  // ── unwritten-mut-param ──────────────────────────────────────────────────────────
  // Free, non-generic, non-pub fns only. A `pub` signature is API and is left alone (no
  // warning at all, not even a soft one); trait and inherent methods are not in
  // program.functions. Passing the param on as an argument to any `&mut` parameter counts
  // as a write, so a chain of forwarders is peeled one link per `milo fix` round.
  i = 0;
  while (i < input.view.length) {
    if (!startsWithAngle(input.view[i].name)) { scanBody(scan, input.view[i].base, 2, "", input.view[i].fn); }
    i++;
  }
  i = 0;
  while (i < input.program.length) {
    checkFn(scan, input.program[i], out);
    i++;
  }
  return out;
}

function checkFn(scan: MutScan, e: FnEntry, out: Finding[]): void {
  const f = e.fn;
  if (f.isExtern || isTrue(f.isPub) || f.typeParams.length > 0 || f.name === "main" || hasAttributes(f)) { return; }
  if (f.retType.isRefMut || scan.values.has(f.name) || !e.hasSig) { return; }
  const mutIdx: number[] = [];
  let p = 0;
  while (p < f.params.length) {
    if (isRefMutParam(f, p) && p < e.refParams.length && e.refParams[p]) { mutIdx.push(p); }
    p++;
  }
  if (mutIdx.length === 0) { return; }
  scanBody(scan, e.base, 0, "", f);
  let m = 0;
  while (m < mutIdx.length) {
    checkParam(scan, e, mutIdx[m], out);
    m++;
  }
}

function checkParam(scan: MutScan, e: FnEntry, pi: number, out: Finding[]): void {
  if (e.fn.params[pi].span !== undefined && !scan.written.has(e.fn.params[pi].name)) {
    scanBody(scan, e.base, 3, e.fn.params[pi].name, e.fn);
    if (scan.escapes) { return; }
    // A call site in another file cannot be rewritten by this file's fix.
    const notes: Note[] = [];
    let otherFile = false;
    let s = 0;
    while (s < scan.sites.length) {
      if (scan.sites[s].callee === e.fn.name && scan.sites[s].idx === pi && scan.sites[s].explicit) {
        if (scan.sites[s].span.file !== e.fn.params[pi].span.file) { otherFile = true; }
        notes.push({ message: "'&mut' is not needed here", span: scan.sites[s].span });
      }
      s++;
    }
    if (!otherFile) {
      out.push({
        code: "unwritten-mut-param",
        message: `'${e.fn.params[pi].name}' is taken as '&mut' but never written through`,
        hint: `take '&T' instead and drop '&mut' at the call sites: shared borrows are implicit`,
        span: e.fn.params[pi].span,
        len: e.fn.params[pi].name.length,
        notes: notes,
      });
    }
  }
}
