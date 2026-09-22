// src/contract-tests — `milo test --contracts`: property tests written by the contracts.
//
// A fn with `requires`/`ensures` already states what a test would check. This module
// turns each eligible fn into a `testContract_<name>` test fn, in Milo source, appended
// to the file it lives in: draw inputs (biased toward the edges an integer contract
// cares about), skip a draw that fails `requires`, call, and evaluate every `ensures`
// with `result` bound to what came back. A violation prints the inputs and fails the
// test through the ordinary `milo test` harness; nothing new runs the process.
//
// Deliberately source-level: the harness is Milo, so the contract expressions are
// re-printed from the AST and evaluated by the same compiler that checks them, and a
// reader can `--emit-source` the file to see exactly what ran.

import type { Program, Function, Expr, MiloType } from "./ast";

export interface ContractTest { name: string; fn: string; source: string }
export interface ContractDiscovery { tests: ContractTest[]; skipped: { name: string; why: string }[] }

// Draws per test and the cap on rejected draws before "nothing satisfied requires" fails
// the test. A property test that never ran is not green.
const CASES = 200;
const MAX_TRIES = 20000;
// Fixed by default: a CI gate that draws different cases every run is a gate whose red is
// not reproducible. `MILO_CONTRACT_SEED` lets a nightly or manual sweep draw a fresh
// sample. The point of the default is determinism, not that this one sample is special.
const SEED = Number(process.env.MILO_CONTRACT_SEED) || 20260921;

const INT_TYPES: Record<string, { min: bigint; max: bigint }> = {
  i8: { min: -(2n ** 7n), max: 2n ** 7n - 1n },
  i16: { min: -(2n ** 15n), max: 2n ** 15n - 1n },
  i32: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
  i64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  u8: { min: 0n, max: 2n ** 8n - 1n },
  u16: { min: 0n, max: 2n ** 16n - 1n },
  u32: { min: 0n, max: 2n ** 32n - 1n },
  // u64 is drawn as an i64 bit pattern; the cast covers the top half
  u64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

export function discoverContractTests(program: Program): ContractDiscovery {
  const tests: ContractTest[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const fn of program.functions) {
    const why = ineligible(fn);
    if (why) {
      if (fn.contracts.some(c => c.kind === "requires" || c.kind === "ensures")) skipped.push({ name: fn.name, why });
      continue;
    }
    const source = harnessFor(fn);
    if (typeof source !== "string") { skipped.push({ name: fn.name, why: source.why }); continue; }
    tests.push({ name: `testContract_${fn.name}`, fn: fn.name, source });
  }
  return { tests, skipped };
}

// The helpers every harness in a file shares. Emitted once, after the tests. The Rng
// import is skipped when the file already has it (an import twice is a resolver error);
// an aliased import would not do, a struct's static call does not go through the alias.
export function contractTestSupport(program: Program): string {
  const hasRng = program.imports.some(i => i.path === "std/rng" && i.names.includes("Rng"));
  return [
    ``,
    hasRng ? `` : `from "std/rng" import { Rng }`,
    ``,
    // Edges first: a contract over integers is about 0, 1, -1 and the type's bounds far
    // more often than about 4,611,686,018,427,387,904, and a `requires 0 <= x && x < n`
    // is only ever satisfied by a small draw.
    `fn __miloCtInt(rng: &mut Rng, min: i64, max: i64): i64 {`,
    `    let pick = rng.int(8)`,
    `    if pick == 0 { return min }`,
    `    if pick == 1 { return max }`,
    `    if pick == 2 && min <= 0 && 0 <= max { return 0 }`,
    `    if pick == 3 && min <= 1 && 1 <= max { return 1 }`,
    `    if pick == 4 && min <= -1 && -1 <= max { return -1 }`,
    `    if pick <= 6 {`,
    `        var lo: i64 = -64`,
    `        if lo < min { lo = min }`,
    `        var hi: i64 = 64`,
    `        if hi > max { hi = max }`,
    `        return rng.range(lo, hi + 1)`,
    `    }`,
    `    if min == max { return min }`,
    `    return rng.range(min, max)`,
    `}`,
    ``,
    `fn __miloCtFloat(rng: &mut Rng): f64 {`,
    `    let pick = rng.int(6)`,
    `    if pick == 0 { return 0.0 }`,
    `    if pick == 1 { return 1.0 }`,
    `    if pick == 2 { return -1.0 }`,
    `    if pick == 3 { return 0.5 }`,
    `    return rng.floatRange(-1000.0, 1000.0)`,
    `}`,
    ``,
    // Empty, ASCII, multibyte, whitespace, numeric spellings: the shapes string
    // contracts (`result.len == s.len`, parse/format round trips) distinguish.
    `fn __miloCtString(rng: &mut Rng): string {`,
    `    let pick = rng.int(12)`,
    `    if pick == 0 { return "" }`,
    `    if pick == 1 { return "a" }`,
    `    if pick == 2 { return "hello world" }`,
    `    if pick == 3 { return "aéb" }`,
    `    if pick == 4 { return "日本語" }`,
    `    if pick == 5 { return "  padded  " }`,
    `    if pick == 6 { return "0" }`,
    `    if pick == 7 { return "-12" }`,
    `    if pick == 8 { return "3.5e2" }`,
    `    if pick == 9 { return "AbC xYz" }`,
    `    let n = rng.int(24)`,
    `    return __miloCtStringOfLen(&mut rng, n)`,
    `}`,
    ``,
    `fn __miloCtStringOfLen(rng: &mut Rng, n: i64): string {`,
    `    var s: string = ""`,
    `    for _i in 0..n {`,
    `        s.push(rng.range(32, 127) as u8)`,
    `    }`,
    `    return s`,
    `}`,
    ``,
  ].join("\n");
}

function ineligible(fn: Function): string | null {
  if (fn.isExtern) return "extern";
  if (fn.typeParams.length > 0) return "generic functions are not drawn";
  if (!fn.contracts.some(c => c.kind === "requires" || c.kind === "ensures")) return "no requires or ensures";
  if (fn.params.some(p => p.name === "self")) return "methods are not drawn (no receiver to build)";
  for (const p of fn.params) {
    const t = p.type;
    if (!t) return `parameter '${p.name}' has no written type`;
    if (t.isRefMut) return `parameter '${p.name}' is &mut; the harness has no way to state what it may change`;
    if (!drawable(t)) return `parameter '${p.name}': no generator for ${typeSource(t)}`;
  }
  for (const c of fn.contracts) {
    if (c.kind !== "requires" && c.kind !== "ensures") continue;
    if (mentionsOld(c.expr)) return "a contract uses old(): the harness cannot snapshot a value it does not own";
  }
  return null;
}

function drawable(t: MiloType): boolean {
  if (t.isPtr) return false;
  if (t.typeArgs && t.typeArgs.length > 0) return false;
  return t.name in INT_TYPES || t.name === "bool" || t.name === "f64" || t.name === "f32" || t.name === "string";
}

function mentionsOld(e: Expr): boolean {
  let found = false;
  walk(e, n => { if (n.kind === "Call" && n.func === "old") found = true; });
  return found;
}

function walk(e: Expr, visit: (n: Expr) => void): void {
  visit(e);
  const n = e as any;
  for (const k of ["left", "right", "operand", "object", "index"]) if (n[k]) walk(n[k], visit);
  for (const k of ["args", "elements"]) if (Array.isArray(n[k])) for (const a of n[k]) walk(a, visit);
}

function harnessFor(fn: Function): string | { why: string } {
  const lines: string[] = [];
  const draws: string[] = [];
  const shown: string[] = [];
  const requires = fn.contracts.filter(c => c.kind === "requires");
  const ensures = fn.contracts.filter(c => c.kind === "ensures");
  const exactLens = exactStringLens(requires.map(c => c.expr));
  for (const p of fn.params) {
    const t = p.type!;
    // a `&string` param is drawn as an owned local; the call auto-borrows it
    const draw = t.name === "string" && exactLens.has(p.name)
      ? `__miloCtStringOfLen(&mut __rng, ${exactLens.get(p.name)})`
      : drawExpr(t);
    draws.push(`        let ${p.name}: ${typeSource({ ...t, isRef: false })} = ${draw}`);
    shown.push(`${p.name}={${p.name}}`);
  }
  const printed: string[] = [];
  for (const c of [...requires, ...ensures]) {
    const src = exprSource(c.expr);
    if (typeof src !== "string") return { why: `${c.kind} uses ${src.why}, which the harness cannot re-print` };
    printed.push(src);
  }
  const retIsVoid = fn.retType.name === "void" && !fn.retType.typeArgs;
  const resultShown = showable(fn.retType) ? " result={result}" : "";
  // an owned string is moved by the call and the ensures still reads it, so the call
  // gets a clone; every other drawable type is Copy
  const callArgs = fn.params.map(p => p.type!.name === "string" && !p.type!.isRef ? `${p.name}.clone()` : p.name).join(", ");

  lines.push(`fn testContract_${fn.name}(): void {`);
  lines.push(`    var __rng: Rng = Rng.new(${SEED})`);
  lines.push(`    var __tried: i64 = 0`);
  lines.push(`    var __ran: i64 = 0`);
  lines.push(`    while __tried < ${MAX_TRIES} && __ran < ${CASES} {`);
  lines.push(`        __tried += 1`);
  lines.push(...draws);
  requires.forEach((_c, i) => {
    lines.push(`        if !(${printed[i]}) {`);
    lines.push(`            continue`);
    lines.push(`        }`);
  });
  if (retIsVoid) {
    lines.push(`        ${fn.name}(${callArgs})`);
  } else {
    lines.push(`        let result = ${fn.name}(${callArgs})`);
  }
  ensures.forEach((_c, i) => {
    const src = printed[requires.length + i];
    const shownSrc = JSON.stringify(src).slice(1, -1).replace(/\{/g, "{{").replace(/\}/g, "}}");
    lines.push(`        if !(${src}) {`);
    lines.push(`            eprint($"ensures ${shownSrc} failed: ${shown.join(" ")}${resultShown}")`);
    lines.push(`            exit(1)`);
    lines.push(`        }`);
  });
  lines.push(`        __ran += 1`);
  lines.push(`    }`);
  lines.push(`    if __ran == 0 {`);
  lines.push(`        eprint("no drawn input satisfied requires after ${MAX_TRIES} tries; the contract wants a shape the generator does not produce")`);
  lines.push(`        exit(1)`);
  lines.push(`    }`);
  lines.push(`    print($"{__ran} cases")`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

// `requires key.len == 32` names the one shape that satisfies it; a random length would
// hit it once in thousands of draws, and three such params never. Mined from every
// `p.len == N` / `N == p.len` conjunct of the requires clauses.
function exactStringLens(exprs: Expr[]): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (e: Expr) => {
    const n = e as any;
    if (n.kind !== "BinOp") return;
    if (n.op === "&&") { visit(n.left); visit(n.right); return; }
    if (n.op !== "==") return;
    for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
      if (a.kind === "FieldAccess" && a.field === "len" && a.object.kind === "Ident" && b.kind === "IntLit") {
        out.set(a.object.name, Number(b.value));
      }
    }
  };
  for (const e of exprs) visit(e);
  return out;
}

function drawExpr(t: MiloType): string {
  if (t.name in INT_TYPES) {
    const r = INT_TYPES[t.name]!;
    const raw = `__miloCtInt(&mut __rng, ${r.min}, ${r.max})`;
    return t.name === "i64" ? raw : `${raw} as ${t.name}`;
  }
  if (t.name === "bool") return `__rng.bool()`;
  if (t.name === "f64") return `__miloCtFloat(&mut __rng)`;
  if (t.name === "f32") return `__miloCtFloat(&mut __rng) as f32`;
  return `__miloCtString(&mut __rng)`;
}

function showable(t: MiloType): boolean {
  return !t.isPtr && !t.typeArgs?.length && (t.name in INT_TYPES || t.name === "bool" || t.name === "f64" || t.name === "f32" || t.name === "string");
}

function typeSource(t: MiloType): string {
  let s = t.name;
  if (t.typeArgs && t.typeArgs.length > 0) s += `<${t.typeArgs.map(typeSource).join(", ")}>`;
  if (t.isPtr) s = "*".repeat(t.ptrDepth ?? 1) + s;
  if (t.isRefMut) s = "&mut " + s;
  else if (t.isRef) s = "&" + s;
  return s;
}

// Contract expressions re-printed as source. Every binary operation is parenthesised, so
// the AST's precedence is the printed precedence with no table to get wrong; the harness
// is never formatted. A node kind outside the contract subset makes the fn ineligible
// rather than guessing at its spelling.
function exprSource(e: Expr): string | { why: string } {
  const n = e as any;
  switch (n.kind) {
    case "Ident": return n.name;
    case "IntLit": return String(n.value);
    case "FloatLit": return floatSource(n.value);
    case "BoolLit": return n.value ? "true" : "false";
    case "StringLit": return JSON.stringify(n.value);
    case "CharLit": return `${n.value} as u8`;
    case "BinOp": {
      const l = exprSource(n.left); if (typeof l !== "string") return l;
      const r = exprSource(n.right); if (typeof r !== "string") return r;
      return `(${l} ${n.op} ${r})`;
    }
    case "UnaryOp": {
      const o = exprSource(n.operand); if (typeof o !== "string") return o;
      return `(${n.op}${o})`;
    }
    case "FieldAccess": {
      const o = exprSource(n.object); if (typeof o !== "string") return o;
      return `${o}.${n.field}`;
    }
    case "IndexAccess": {
      const o = exprSource(n.object); if (typeof o !== "string") return o;
      const i = exprSource(n.index); if (typeof i !== "string") return i;
      return `${o}[${i}]`;
    }
    case "Call": {
      const args = argsSource(n.args); if (typeof args !== "string") return args;
      return `${n.func}(${args})`;
    }
    case "MethodCall": {
      const o = exprSource(n.object); if (typeof o !== "string") return o;
      const args = argsSource(n.args); if (typeof args !== "string") return args;
      return `${o}.${n.method}(${args})`;
    }
    case "CastExpr": {
      const o = exprSource(n.operand); if (typeof o !== "string") return o;
      return `(${o} as ${typeSource(n.targetType)})`;
    }
    case "EnumLit": {
      const args = argsSource(n.args ?? []); if (typeof args !== "string") return args;
      return n.args && n.args.length > 0 ? `${n.enumName}.${n.variant}(${args})` : `${n.enumName}.${n.variant}`;
    }
    default: return { why: `a ${n.kind} expression` };
  }
}

function argsSource(args: Expr[]): string | { why: string } {
  const out: string[] = [];
  for (const a of args) {
    const s = exprSource(a); if (typeof s !== "string") return s;
    out.push(s);
  }
  return out.join(", ");
}

// A float literal must read back as a float: `1` would be an int.
function floatSource(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}
