#!/usr/bin/env bun
// Ownership diagnostic-site census: how many ownership-worded checker diagnostics does at least one tests/errors fixture reach?
//
//   bun scripts/ownership-sites.ts [--list] [--check] [--update-baseline]
//
// Static half: the TypeScript compiler API finds every call to a diagnostic helper in src/checker*.ts
// (error, errorWithNotes, errorCode, report, fail, reportBorrowed, requireUnsafe) and takes the first string/template
// argument as the site's message; template holes become wildcards. A site is ownership-worded when its
// literal text contains a word from OWNERSHIP_WORDS.
// Dynamic half: a site is reached when some `// @error:` substring in tests/errors/*.milo occurs in the
// site's text (holes match anything), or the site's literal pieces occur in order inside the substring.
//
// Over/under-counts (static text matching, not execution):
//  - a message built from a variable or a helper's return value is not listed (under-counts sites);
//  - a test reaching a site through a different message, or two sites sharing wording, can mark a site
//    reached that never ran (over-counts reached) or leave a reached one unmarked (under-counts);
//  - the reverse match needs 10+ literal characters so a bare "'" cannot reach everything;
//  - warnings (this.warn) are excluded: they are not @error diagnostics.
// Baseline: scripts/ownership-sites-baseline.json. Sites are keyed "file: message" so line drift is free.
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(import.meta.dir, "ownership-sites-baseline.json");

// The one table deciding what counts as an ownership-worded diagnostic.
export const OWNERSHIP_WORDS = ["moved", "move", "borrow", "borrowed", "owner", "owned", "drop", "dropped", "freed", "escape", "escapes", "alias", "lifetime", "consumed", "use after"];
const OWNERSHIP_RE = new RegExp(`\\b(${OWNERSHIP_WORDS.join("|")})(s|es|ed|ing)?\\b`, "i"); // inflections: "borrows", "moves", "dropping"
const REPORTERS = new Set(["error", "errorWithNotes", "errorCode", "report", "fail", "reportBorrowed", "requireUnsafe"]);
const MIN_REVERSE_LITERAL = 10;

export type Site = { file: string; line: number; pieces: string[] }; // pieces: literal text between holes
export const siteText = (s: Site) => s.pieces.join("${}");
export const siteKey = (s: Site) => `${s.file}: ${siteText(s).slice(0, 100)}`;

// Literal pieces of a string-ish expression; null when it has no literal head at all.
function piecesOf(e: ts.Expression): string[] | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map(sp => sp.literal.text)];
  if (ts.isParenthesizedExpression(e)) return piecesOf(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = piecesOf(e.left);
    if (!l) return null;
    const r = piecesOf(e.right);
    if (!r) return [...l, ""];
    return [...l.slice(0, -1), l[l.length - 1]! + r[0]!, ...r.slice(1)];
  }
  return null;
}

export function isOwnershipWorded(s: Site): boolean { return OWNERSHIP_RE.test(s.pieces.join(" ")); }

export function findSites(file: string, source: string): Site[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Site[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const nm = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
      if (REPORTERS.has(nm)) {
        for (const a of node.arguments) {
          const p = piecesOf(a);
          if (p) { out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, pieces: p }); break; }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// pieces appear in order inside text (holes = any run)
function piecesWithin(pieces: string[], text: string): boolean {
  let at = 0;
  for (const p of pieces) { if (!p) continue; const i = text.indexOf(p, at); if (i < 0) return false; at = i + p.length; }
  return true;
}

export function isReached(site: Site, expected: string[]): boolean {
  const lit = site.pieces.join("").length;
  // forward: the expected substring sits inside the site's text, holes matching any run
  const re = new RegExp(site.pieces.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*"));
  return expected.some(sub => {
    if (!sub) return false;
    if (site.pieces.some(p => p.includes(sub))) return true;
    // reverse: the whole site wording occurs in the expected text (short sites excluded)
    return lit >= MIN_REVERSE_LITERAL && re.test(sub) && piecesWithin(site.pieces, sub);
  });
}

export type Census = { sites: Site[]; reachedSites: number; unreached: string[] };
export function census(sites: Site[], expected: string[]): Census {
  const unreached: string[] = [];
  for (const s of sites) if (!isReached(s, expected)) unreached.push(siteKey(s));
  return { sites, reachedSites: sites.length - unreached.length, unreached };
}

export type Baseline = { reached: number; unreached: string[] };
// Reached may not drop and the unreached list may not grow: both fail, naming the sites.
export function checkAgainst(base: Baseline, cur: { reached: number; unreached: string[] }): string[] {
  const problems: string[] = [];
  if (cur.reached < base.reached) problems.push(`reached ${cur.reached} < baseline ${base.reached}`);
  const known = new Set(base.unreached);
  for (const u of new Set(cur.unreached)) if (!known.has(u)) problems.push(`newly unreached: ${u}`);
  return problems;
}

export function collectSites(): Site[] {
  const files = readdirSync(join(ROOT, "src")).filter(f => /^checker(-[\w-]+)?\.ts$/.test(f)).sort();
  const all: Site[] = [];
  for (const f of files) for (const s of findSites(`src/${f}`, readFileSync(join(ROOT, "src", f), "utf-8"))) if (isOwnershipWorded(s)) all.push(s);
  return all;
}

export function collectExpected(): string[] {
  const dir = join(ROOT, "tests", "errors");
  const out: string[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith(".milo"))) {
    for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/^\/\/ @error:\s*(.+?)\s*$/gm)) out.push(m[1]!);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const c = census(collectSites(), collectExpected());
  const total = c.sites.length;
  console.log(`sites: ${total}`);
  console.log(`reached: ${c.reachedSites} of ${total} (${((100 * c.reachedSites) / Math.max(total, 1)).toFixed(1)}%)`);
  if (argv.includes("--list")) {
    const un = new Set(c.unreached);
    for (const s of c.sites) if (un.has(siteKey(s))) console.log(`${s.file}:${s.line}  ${siteText(s).slice(0, 100)}`);
  }
  const cur = { reached: c.reachedSites, unreached: [...new Set(c.unreached)].sort() };
  if (argv.includes("--update-baseline")) {
    writeFileSync(BASELINE, JSON.stringify(cur, null, 1) + "\n");
    console.log(`baseline written: reached ${cur.reached}, unreached ${cur.unreached.length}`);
  }
  if (argv.includes("--check")) {
    const problems = checkAgainst(JSON.parse(readFileSync(BASELINE, "utf-8")) as Baseline, cur);
    for (const p of problems) console.error(`REGRESSED: ${p}`);
    if (problems.length) process.exit(1);
    console.log("check ok");
  }
}
