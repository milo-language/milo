// Statement (line) coverage of requirement-implementing code by the @req tests, for `milo trace --coverage`.
//
// No compiler instrumentation: `milo test --coverage <dir>` builds each test file with clang's
// gcov counters (the debug info the compiler already emits supplies the lines), every test
// process adds its counts to the .gcda beside the build, and `llvm-cov gcov` turns the
// .gcno/.gcda pairs into per-line counts that are merged here.
//
// Statement only. gcov's branch counts also include contract checks, overflow traps and bounds
// checks, which are not source branches, so they must never be reported as branch coverage.
//
// A test process that aborts (a trap, a failed assert) loses its counts, because the gcov runtime
// writes the .gcda at exit. A passing test never aborts, except one that expects a trap; its lines
// are then counted only if another test reaches them.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { Lexer } from "./lexer";
import { TokenKind, type Token } from "./tokens";
import { LLVM_BIN } from "./llvm-toolchain";

/** A fn that the report accounts for. `line` is the line of its name. */
export interface CoverageSite { name: string; file: string; line: number }

export interface CoverageFn {
  fn: string;
  file: string;
  line: number;
  covered: number;
  total: number;
  uncovered: number[];
}

export interface CoverageReport {
  fns: CoverageFn[];
  covered: number;
  total: number;
  /** 0 to 100; 100 when there is nothing to cover. */
  percent: number;
}

/**
 * clang tags a module's counters by its compile unit's file name in the working directory, so
 * two modules built from sources of the same name would overwrite each other's .gcno. The
 * `llvm.gcov` node names both files explicitly instead (the form clang's own frontend emits).
 */
export function withGcovNotes(ir: string, stem: string): string {
  const cu = /^!(\d+) = distinct !DICompileUnit\(/m.exec(ir);
  if (!cu) throw new Error("coverage: the IR has no compile unit (no debug info to take lines from)");
  let max = 0;
  for (const m of ir.matchAll(/^!(\d+) = /gm)) max = Math.max(max, Number(m[1]));
  const id = max + 1;
  return `${ir.replace(/\n*$/, "\n")}!llvm.gcov = !{!${id}}\n!${id} = !{!"${stem}.gcno", !"${stem}.gcda", !${cu[1]}}\n`;
}

const llvmCov = () => join(LLVM_BIN, "llvm-cov");

/** What is missing for coverage to work, or null. The profile runtime is proven by linking a tiny program with it. */
export function coverageToolsError(): string | null {
  if (!existsSync(llvmCov())) return `llvm-cov not found at ${llvmCov()} (it ships with the LLVM install that provides clang; set MILO_LLVM_BIN)`;
  const clang = join(LLVM_BIN, "clang");
  const dir = join(tmpdir(), `milo_covprobe_${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, "p.c");
  writeFileSync(src, "int main(void){return 0;}\n");
  const r = spawnSync(clang, ["--coverage", src, "-o", join(dir, "p")], { encoding: "utf-8" });
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) return `${clang} cannot link with --coverage (the gcov profile runtime is missing): ${(r.stderr ?? "").trim().split("\n")[0]}`;
  return null;
}

/** line -> count (null: no code on the line), per absolute source path. */
export type LineCounts = Map<string, Map<number, number | null>>;

function findGcda(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findGcda(p, out);
    else if (e.name.endsWith(".gcda")) out.push(p);
  }
  return out;
}

/** Parse one `.gcov` file: the `Source:` header and `count:line:text` rows. */
function parseGcov(text: string): { source: string; rows: [number, number | null][] } | null {
  let source = "";
  const rows: [number, number | null][] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*([^:]+):\s*(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    const line = Number(m[2]);
    if (line === 0) {
      const s = /^Source:(.*)$/.exec(m[3]!);
      if (s) source = s[1]!;
      continue;
    }
    const c = m[1]!.trim();
    if (c === "-") rows.push([line, null]);
    else if (c.startsWith("#") || c.startsWith("=")) rows.push([line, 0]);
    else rows.push([line, Number(c.replace(/\*$/, ""))]);
  }
  return source ? { source, rows } : null;
}

/**
 * Every .gcda under `dir`, merged into one count per source line. Throws when no test process
 * wrote one: an empty profile must never read as "nothing uncovered".
 */
export function readCoverage(dir: string): LineCounts {
  const gcdas = existsSync(dir) ? findGcda(dir) : [];
  if (gcdas.length === 0) throw new Error(`no test process wrote coverage data under ${dir} (no @req test ran, or the profile runtime did not flush)`);
  const out: LineCounts = new Map();
  gcdas.forEach((gcda, i) => {
    // Each pair gets its own directory: llvm-cov names its output after the source's basename.
    const work = join(dir, `gcov${i}`);
    mkdirSync(work, { recursive: true });
    const r = spawnSync(llvmCov(), ["gcov", gcda], { cwd: work, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`llvm-cov gcov ${gcda} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
    for (const f of readdirSync(work)) {
      if (!f.endsWith(".gcov")) continue;
      const g = parseGcov(readFileSync(join(work, f), "utf-8"));
      if (!g) continue;
      const src = isAbsolute(g.source) ? g.source : resolve(dirname(gcda), g.source);
      let lines = out.get(src);
      if (!lines) out.set(src, (lines = new Map()));
      for (const [line, c] of g.rows) {
        const prev = lines.get(line);
        if (c === null) { if (prev === undefined) lines.set(line, null); }
        else lines.set(line, (prev ?? 0) + c);
      }
    }
  });
  return out;
}

const tokenCache = new Map<string, Token[]>();
function tokensOf(file: string): Token[] {
  let t = tokenCache.get(file);
  if (!t) tokenCache.set(file, (t = new Lexer(readFileSync(file, "utf-8")).tokenize()));
  return t;
}

/**
 * The lines strictly inside a fn's body braces, found from the token stream: the fn's span only
 * names its first line, and the `requires`/`ensures` clauses between the signature and the `{`
 * are instrumented too, so counting from the signature would report them. A one-line fn counts
 * its own line. Null when the fn cannot be located.
 */
export function bodyRange(file: string, name: string, line: number): { first: number; last: number } | null {
  const toks = tokensOf(file);
  const base = name.slice(name.lastIndexOf(".") + 1);
  let i = toks.findIndex((t, k) => t.line === line && t.value === base && toks[k - 1]?.kind === TokenKind.Fn);
  if (i < 0) return null;
  let depth = 0;
  for (; i < toks.length; i++) {
    const k = toks[i]!.kind;
    if (k === TokenKind.LParen || k === TokenKind.LBracket) depth++;
    else if (k === TokenKind.RParen || k === TokenKind.RBracket) depth--;
    else if (k === TokenKind.LBrace && depth === 0) break;
  }
  if (i >= toks.length) return null;
  const open = toks[i]!.line;
  let braces = 0;
  for (; i < toks.length; i++) {
    const k = toks[i]!.kind;
    if (k === TokenKind.LBrace) braces++;
    else if (k === TokenKind.RBrace && --braces === 0) {
      const close = toks[i]!.line;
      return close === open ? { first: open, last: open } : { first: open + 1, last: close - 1 };
    }
  }
  return null;
}

/**
 * Covered / total lines of each fn body. A source file with no gcov output at all is an error (the
 * tests never built it into a binary): it would otherwise read as a fully covered "0 of 0".
 */
export function coverageOf(sites: CoverageSite[], counts: LineCounts): { report: CoverageReport; errors: string[] } {
  const fns: CoverageFn[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of sites) {
    const lines = counts.get(s.file);
    if (!lines) {
      if (!seen.has(s.file)) errors.push(`coverage: no gcov data for ${s.file}: no @req test binary includes it`);
      seen.add(s.file);
      continue;
    }
    const range = bodyRange(s.file, s.name, s.line);
    if (!range) { errors.push(`coverage: cannot find the body of '${s.name}' at ${s.file}:${s.line}`); continue; }
    let covered = 0, total = 0;
    const uncovered: number[] = [];
    for (let l = range.first; l <= range.last; l++) {
      const c = lines.get(l);
      if (c === undefined || c === null) continue;
      total++;
      if (c > 0) covered++; else uncovered.push(l);
    }
    // A fn no test binary compiled (an unimported `main`, an unreachable helper) has no
    // instrumented line at all: its statements are uncovered, not "0 of 0".
    if (total === 0) {
      uncovered.push(...codeLines(s.file, range));
      total = uncovered.length;
    }
    fns.push({ fn: s.name, file: s.file, line: s.line, covered, total, uncovered });
  }
  const covered = fns.reduce((n, f) => n + f.covered, 0);
  const total = fns.reduce((n, f) => n + f.total, 0);
  return { report: { fns, covered, total, percent: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10 }, errors };
}

/** Lines in the range holding a token other than a brace: the statements of a body no binary compiled. */
function codeLines(file: string, r: { first: number; last: number }): number[] {
  const lines = new Set<number>();
  for (const t of tokensOf(file)) {
    if (t.line >= r.first && t.line <= r.last && t.kind !== TokenKind.LBrace && t.kind !== TokenKind.RBrace && t.kind !== TokenKind.Eof) lines.add(t.line);
  }
  return [...lines].sort((a, b) => a - b);
}
