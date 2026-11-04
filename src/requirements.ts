// Requirements traceability at the source level: `@req(ID)` ties code, contract clauses and
// tests to a requirements.json, and `milo trace <entry.milo>` prints the matrix.
//
//   fn / struct / `@!req` file   implements ID
//   requires / ensures / invariant clause (attribute written before it)   formalizes ID
//   test* fn                     verifies ID
//   @assume(ID) fn               a trusted axiom, listed for review
//   @derived(ID) / @deactivated  exempt from "every fn has an @req", listed for review
//
// Formalizing clauses are not taken on faith: each one's `milo prove` verdict (src/verify.ts
// tags every obligation with the clause it came from) is the evidence, so a green row means
// a solver discharged exactly that clause, and a `requires` clause is judged at every call site.
//
// Verification follows DO-333 (formal methods supplement): a low-level requirement (one with a
// parent) is verified by a PROVEN formalizing clause alone or by a passing test; a high-level
// requirement (no parent), and any requirement with no formalizing clause, needs a passing test
// of its own, because a proof checks code against the spec, not that the spec is right or that
// the binary behaves on target. The matrix says which one verified each requirement.
//
// `@req` tests are RUN (each in its own process, through `milo test`) unless `--no-run`.
//
// Without a profile the matrix is a report. Strict (`--strict`, or `--safety=<profile>` whose
// traceability field is "strict") turns the gaps into errors, except those listed in a baseline
// (`--baseline <file>`, written by `--write-baseline`), which stay warnings so an existing
// codebase can adopt a profile; a baseline entry that is no longer a gap is reported stale.
// TODO(coverage): line/branch coverage of the implementing fns by the verifying tests.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import type { Attribute, Contract, Function, Program } from "./ast";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import type { ProveResult } from "./verify";
import { parseSafetyLevel, traceabilityOf } from "./safety";

export const TRACE_ATTRS = new Set(["req", "assume", "derived", "deactivated"]);
const ID_RE = /^[A-Za-z0-9_.\-]+$/;

/** Shape errors for one traceability attribute (the checker reports them), or null. */
export function traceAttrError(attr: Attribute, where: "fn" | "struct" | "clause"): string | null {
  if (attr.name === "deactivated") {
    if (where !== "fn") return "only a fn can be deactivated";
    if (attr.args.length !== 1 || attr.argKinds?.[0] !== "string" || attr.args[0]!.trim() === "") {
      return `write a reason: @deactivated("flight-test hook")`;
    }
    return null;
  }
  if (attr.name === "assume" && where !== "fn") return "@assume goes on a fn";
  if (attr.name === "derived" && where === "clause") return "@derived goes on a fn or struct";
  if (attr.args.length !== 1) return `write exactly one requirement id: @${attr.name}(HLR-1)`;
  if (!ID_RE.test(attr.args[0]!)) {
    return `'${attr.args[0]}' is not a requirement id: use letters, digits, '-', '_' and '.'`;
  }
  return null;
}

// ── requirements.json ──

export interface Requirement { id: string; text: string; parent?: string }

export interface RequirementsFile { path: string; reqs: Requirement[]; errors: string[] }

/** The file next to the entry, or the explicit one. Null when neither exists. */
export function findRequirementsFile(entry: string, explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  const next = join(dirname(resolve(entry)), "requirements.json");
  return existsSync(next) ? next : null;
}

export function loadRequirements(path: string): RequirementsFile {
  const errors: string[] = [];
  const reqs: Requirement[] = [];
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e: any) {
    return { path, reqs, errors: [`cannot read ${path}: ${e.message}`] };
  }
  if (!doc || !Array.isArray(doc.requirements)) {
    return { path, reqs, errors: [`${path}: expected {"requirements": [{"id", "text", "parent"?}]}`] };
  }
  const seen = new Set<string>();
  for (const [i, r] of doc.requirements.entries()) {
    if (!r || typeof r.id !== "string" || !ID_RE.test(r.id)) { errors.push(`requirements[${i}]: missing or malformed "id"`); continue; }
    if (typeof r.text !== "string") { errors.push(`requirement '${r.id}': missing "text"`); continue; }
    if (r.parent !== undefined && typeof r.parent !== "string") { errors.push(`requirement '${r.id}': "parent" must be an id string`); continue; }
    if (seen.has(r.id)) { errors.push(`duplicate requirement id '${r.id}'`); continue; }
    seen.add(r.id);
    reqs.push({ id: r.id, text: r.text, ...(r.parent !== undefined ? { parent: r.parent } : {}) });
  }
  for (const r of reqs) {
    if (r.parent !== undefined && !seen.has(r.parent)) errors.push(`requirement '${r.id}': parent '${r.parent}' does not exist`);
  }
  // A cycle: walk each requirement's parent chain; revisiting a node on the same walk is one.
  const byId = new Map(reqs.map(r => [r.id, r]));
  const reported = new Set<string>();
  for (const r of reqs) {
    const walk: string[] = [];
    for (let cur: Requirement | undefined = r; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      const at = walk.indexOf(cur.id);
      if (at >= 0) {
        const cycle = walk.slice(at);
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) { reported.add(key); errors.push(`parent cycle: ${[...cycle, cur.id].join(" -> ")}`); }
        break;
      }
      walk.push(cur.id);
    }
  }
  return { path, reqs, errors };
}

// ── what the source says ──

interface Loc { file: string; line: number }

interface ClauseUse {
  contract: Contract;
  kind: string;
  ids: string[];
  text: string;
  loc: Loc;
}

interface DeclUse {
  name: string;
  loc: Loc;
  decl: "fn" | "struct";
  isTest: boolean;
  implements: string[];
  derived: string[];
  assumes: string[];
  deactivated?: string;
  clauses: ClauseUse[];
}

const idsOf = (attrs: Attribute[] | undefined, name: string): string[] =>
  (attrs ?? []).filter(a => a.name === name && a.args.length > 0).map(a => a.args[0]!);

const lineCache = new Map<string, string[]>();
function sourceLine(file: string, line: number): string {
  if (!lineCache.has(file)) {
    try { lineCache.set(file, readFileSync(file, "utf-8").split("\n")); } catch { lineCache.set(file, []); }
  }
  return (lineCache.get(file)![line - 1] ?? "").trim();
}

function declUses(fns: { fn: Function; name: string }[], structs: Program["structs"], inProject: (f: string) => boolean): DeclUse[] {
  const out: DeclUse[] = [];
  const clausesOf = (contracts: Contract[], file: string): ClauseUse[] =>
    contracts.filter(c => idsOf(c.attributes, "req").length > 0).map(c => ({
      contract: c, kind: c.kind, ids: idsOf(c.attributes, "req"),
      // The clause as written. Its attribute line is separate, so the clause starts at its keyword.
      text: sourceLine(file, c.span?.line ?? 0),
      loc: { file, line: c.span?.line ?? 0 },
    }));
  for (const { fn, name } of fns) {
    if (fn.isExtern) continue;
    const file = resolve(fn.span?.file ?? fn.sourceFile ?? "");
    if (!inProject(file)) continue;
    const a = fn.attributes;
    out.push({
      name, loc: { file, line: fn.span?.line ?? 0 }, decl: "fn",
      // A test follows the `milo test` convention: top-level `test*`, no parameters.
      isTest: fn.name.startsWith("test") && fn.params.length === 0 && fn.typeParams.length === 0,
      implements: idsOf(a, "req"), derived: idsOf(a, "derived"), assumes: idsOf(a, "assume"),
      ...(idsOf(a, "deactivated").length ? { deactivated: idsOf(a, "deactivated")[0] } : {}),
      clauses: clausesOf(fn.contracts, file),
    });
  }
  for (const s of structs) {
    if (s.isExtern) continue;
    const file = resolve(s.span?.file ?? "");
    if (!inProject(file)) continue;
    const ids = idsOf(s.attributes, "req");
    const derived = idsOf(s.attributes, "derived");
    const clauses = clausesOf(s.invariants ?? [], file);
    if (ids.length || derived.length || clauses.length) {
      out.push({ name: s.name, loc: { file, line: s.span?.line ?? 0 }, decl: "struct", isTest: false, implements: ids, derived, assumes: [], clauses });
    }
  }
  return out;
}

function projectDecls(program: Program, inProject: (f: string) => boolean): DeclUse[] {
  const fns = [
    ...program.functions.map(fn => ({ fn, name: fn.name })),
    ...(program.impls ?? []).flatMap(im => im.methods.map(fn => ({ fn, name: `${im.typeName}.${fn.name}` }))),
  ];
  return declUses(fns, program.structs, inProject);
}

/** `*_test.milo` beside the entry (and in its `tests/`), or whatever `--tests` names. Parsed, not checked. */
function testDecls(entry: string, tests: string | undefined, inProject: (f: string) => boolean): DeclUse[] {
  const dir = dirname(resolve(entry));
  const files: string[] = [];
  const add = (p: string) => {
    if (!existsSync(p)) return;
    if (p.endsWith(".milo")) { files.push(resolve(p)); return; }
    for (const f of readdirSync(p).sort()) if (f.endsWith("_test.milo")) files.push(join(resolve(p), f));
  };
  if (tests) add(tests);
  else { add(dir); add(join(dir, "tests")); }
  const out: DeclUse[] = [];
  for (const f of files) {
    if (f === resolve(entry)) continue;
    const src = readFileSync(f, "utf-8");
    const prog = new Parser(new Lexer(src).tokenize(), src, f).parse();
    out.push(...projectDecls(prog, () => true).filter(d => d.isTest || d.implements.length || d.clauses.length));
  }
  void inProject;
  return out;
}

// ── the matrix ──

export type Status = "PROVEN" | "FAILED" | "UNKNOWN";

export interface CallSiteRow { caller: string; file: string; line: number; status: Status; detail?: string }

export interface ClauseRow {
  fn: string;
  kind: string;
  text: string;
  file: string;
  line: number;
  status: Status;
  detail?: string;
  /** An UNKNOWN that strict mode accepts, and why: the fn is `@assume`d, or a `@req` test covers the requirement. */
  waived?: "assume" | "test";
  callSites?: CallSiteRow[];
}

interface SiteRow { fn: string; file: string; line: number }

/** A verifying test and, when the tests were run, whether it passed. */
interface TestRow extends SiteRow { result?: "PASS" | "FAIL"; output?: string }

export type Verification = "proof" | "test" | "proof+test" | "none";

export interface RequirementRow {
  id: string;
  text: string;
  parent?: string;
  children: string[];
  implementedBy: (SiteRow & { derived?: true })[];
  formalizedBy: ClauseRow[];
  verifiedBy: TestRow[];
  assumedBy: SiteRow[];
  /** Own or any descendant's implementation: a parent is traced through its children. */
  implemented: boolean;
  /** DO-333: see the header. How this requirement is verified, "none" when it is not. */
  verification: Verification;
  verified: boolean;
}

export interface TraceReport {
  schema: 1;
  entry: string;
  requirementsFile: string | null;
  strict: boolean;
  requirements: RequirementRow[];
  untracedFns: SiteRow[];
  derived: SiteRow[];
  deactivated: (SiteRow & { reason: string })[];
  assumptions: SiteRow[];
  noImplementation: string[];
  noVerifyingTest: string[];
  /** Every gap strict mode would fail on, with the stable key a baseline lists it by. */
  gaps: { key: string; message: string }[];
  /** Gaps the baseline lists: still warnings under strict. */
  baselined: string[];
  /** Baseline entries that are no longer gaps: remove them. */
  staleBaseline: string[];
  /** Formalizing clauses whose verdict is UNKNOWN (waived or not). */
  unknown: number;
  /** Problems with the requirements file or with ids the source uses. Always errors. */
  errors: string[];
  /** What strict mode adds. Listed in a report run too, but only fail it under strict. */
  strictFailures: string[];
  ok: boolean;
}

function proveVerdict(pr: ProveResult | null, clause: Contract): { status: Status; detail?: string; sites: CallSiteRow[] } {
  const mine = pr ? pr.results.filter(r => r.vc.clause === clause) : [];
  const toStatus = (s: string): Status => (s === "proven" ? "PROVEN" : s === "failed" ? "FAILED" : "UNKNOWN");
  const sites: CallSiteRow[] = mine.filter(r => r.vc.kind === "precondition").map(r => ({
    caller: r.vc.fn,
    file: resolve(r.vc.site?.file ?? ""),
    line: r.vc.site?.line ?? 0,
    status: toStatus(r.status),
    ...(r.detail ? { detail: r.detail } : {}),
  }));
  if (mine.length === 0) {
    return { status: "UNKNOWN", detail: clause.kind === "requires" ? "no call site in the program: callers outside it are unchecked" : "no proof obligation reached this clause", sites };
  }
  const bad = mine.find(r => r.status === "failed");
  if (bad) return { status: "FAILED", ...(bad.detail ? { detail: bad.detail } : {}), sites };
  const unk = mine.find(r => r.status !== "proven");
  if (unk) return { status: "UNKNOWN", ...(unk.detail ? { detail: unk.detail } : {}), sites };
  return { status: "PROVEN", sites };
}

export interface TraceOptions {
  entry: string;
  program: Program;
  prove: ProveResult | null;
  requirementsPath?: string;
  tests?: string;
  strict: boolean;
  /** Gap keys that stay warnings under strict. */
  baseline?: Set<string>;
  /** Verdict per "<abs file>:<test name>" when the tests were run; absent = not run. */
  testResults?: Map<string, { pass: boolean; output?: string }>;
}

export function buildTrace(o: TraceOptions): TraceReport {
  const entryAbs = resolve(o.entry);
  const dir = dirname(entryAbs);
  const inProject = (f: string) => f === entryAbs || f.startsWith(dir + sep);
  const errors: string[] = [];
  const strictFailures: string[] = [];

  const reqPath = findRequirementsFile(o.entry, o.requirementsPath);
  let reqs: Requirement[] = [];
  if (reqPath) {
    const loaded = loadRequirements(reqPath);
    reqs = loaded.reqs;
    errors.push(...loaded.errors);
  } else {
    errors.push(`no requirements.json next to ${relative(process.cwd(), entryAbs)} (or pass --requirements <file>)`);
  }
  const known = new Set(reqs.map(r => r.id));

  const decls = projectDecls(o.program, inProject);
  const seenKeys = new Set(decls.map(d => `${d.loc.file}:${d.loc.line}:${d.name}`));
  for (const t of testDecls(o.entry, o.tests, inProject)) {
    if (!seenKeys.has(`${t.loc.file}:${t.loc.line}:${t.name}`)) decls.push(t);
  }

  const rel = (f: string) => relative(dir, f) || f;
  const where = (l: Loc) => `${rel(l.file)}:${l.line}`;
  const site = (d: DeclUse): SiteRow => ({ fn: d.name, file: rel(d.loc.file), line: d.loc.line });
  const testRow = (d: DeclUse): TestRow => {
    const r = o.testResults?.get(`${d.loc.file}:${d.name}`);
    return { ...site(d), ...(r ? { result: r.pass ? "PASS" as const : "FAIL" as const, ...(r.pass || !r.output ? {} : { output: r.output }) } : {}) };
  };

  // Every id the source uses must exist.
  const unknownIds = new Set<string>();
  const checkId = (id: string, l: Loc, what: string) => {
    if (reqPath && !known.has(id)) {
      const key = `${where(l)}:${id}`;
      if (!unknownIds.has(key)) { unknownIds.add(key); errors.push(`${where(l)}: ${what} refers to unknown requirement '${id}'`); }
    }
  };
  for (const d of decls) {
    for (const id of d.implements) checkId(id, d.loc, `${d.isTest ? "test" : d.decl} '${d.name}'`);
    for (const id of d.derived) checkId(id, d.loc, `${d.decl} '${d.name}' (@derived)`);
    for (const id of d.assumes) checkId(id, d.loc, `fn '${d.name}' (@assume)`);
    for (const c of d.clauses) for (const id of c.ids) checkId(id, c.loc, `${c.kind} clause of '${d.name}'`);
  }

  const rows = new Map<string, RequirementRow>(reqs.map(r => [r.id, {
    id: r.id, text: r.text, ...(r.parent ? { parent: r.parent } : {}), children: [],
    implementedBy: [], formalizedBy: [], verifiedBy: [], assumedBy: [], implemented: false, verification: "none" as Verification, verified: false,
  }]));
  for (const r of reqs) if (r.parent && rows.has(r.parent)) rows.get(r.parent)!.children.push(r.id);

  const untraced: SiteRow[] = [];
  const derivedFns: SiteRow[] = [];
  const deactivated: (SiteRow & { reason: string })[] = [];
  const assumptions: SiteRow[] = [];
  for (const d of decls) {
    if (d.deactivated !== undefined) deactivated.push({ ...site(d), reason: d.deactivated });
    if (d.derived.length) derivedFns.push(site(d));
    if (d.assumes.length) assumptions.push(site(d));
    for (const id of d.assumes) rows.get(id)?.assumedBy.push(site(d));
    if (d.isTest) {
      for (const id of d.implements) rows.get(id)?.verifiedBy.push(testRow(d));
      continue;
    }
    for (const id of d.implements) rows.get(id)?.implementedBy.push(site(d));
    for (const id of d.derived) rows.get(id)?.implementedBy.push({ ...site(d), derived: true });
    if (d.decl === "fn" && d.deactivated === undefined && !d.implements.length && !d.derived.length) untraced.push(site(d));
    for (const c of d.clauses) {
      const v = proveVerdict(o.prove, c.contract);
      for (const id of c.ids) {
        const row: ClauseRow = {
          fn: d.name, kind: c.kind, text: c.text, file: rel(c.loc.file), line: c.loc.line,
          status: v.status, ...(v.detail ? { detail: v.detail } : {}),
          ...(c.kind === "requires" ? { callSites: v.sites.map(s => ({ ...s, file: rel(s.file) })) } : {}),
        };
        rows.get(id)?.formalizedBy.push(row);
      }
    }
  }

  // A parent is traced through its children; waivers need the final rollup, so two passes.
  const subtreeHas = (id: string, pick: (r: RequirementRow) => boolean, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false; // a parent cycle is reported as an error; do not loop on it
    seen.add(id);
    const r = rows.get(id)!;
    return pick(r) || r.children.some(c => subtreeHas(c, pick, seen));
  };
  const passingTests = (r: RequirementRow) => r.verifiedBy.filter(t => t.result !== "FAIL").length;
  for (const r of rows.values()) {
    r.implemented = subtreeHas(r.id, x => x.implementedBy.length > 0);
    // DO-333: proof alone verifies only a low-level requirement whose every clause is PROVEN.
    const byProof = !!r.parent && rows.has(r.parent) && r.formalizedBy.length > 0 && r.formalizedBy.every(c => c.status === "PROVEN");
    const byTest = passingTests(r) > 0;
    r.verification = byProof && byTest ? "proof+test" : byProof ? "proof" : byTest ? "test" : "none";
    r.verified = r.verification !== "none";
  }
  for (const r of rows.values()) {
    for (const c of r.formalizedBy) {
      if (c.status !== "UNKNOWN") continue;
      if (r.assumedBy.some(a => a.fn === c.fn)) c.waived = "assume";
      else if (passingTests(r) > 0) c.waived = "test";
    }
  }

  const noImplementation = [...rows.values()].filter(r => !r.implemented).map(r => r.id);
  const noVerifyingTest = [...rows.values()].filter(r => !r.verified).map(r => r.id);
  const unknown = [...rows.values()].reduce((n, r) => n + r.formalizedBy.filter(c => c.status === "UNKNOWN").length, 0);

  // Every gap carries a key that survives edits (no line numbers), so a baseline keeps naming the
  // same gap after the code around it moves.
  const gaps: { key: string; message: string }[] = [];
  const gap = (key: string, message: string) => gaps.push({ key, message });
  for (const u of untraced) gap(`untraced:${u.fn}`, `${u.file}:${u.line}: fn '${u.fn}' has no @req (or @derived / @deactivated)`);
  for (const id of noImplementation) gap(`no-implementation:${id}`, `requirement ${id} has no implementation`);
  for (const r of rows.values()) {
    if (r.verified) continue;
    const failing = r.verifiedBy.filter(t => t.result === "FAIL");
    const why = failing.length ? `its verifying test${failing.length > 1 ? "s" : ""} fail (${failing.map(t => t.fn).join(", ")})`
      : r.parent && r.formalizedBy.length > 0 ? "its clauses are not all PROVEN and no test passes"
      : r.parent ? "it has no formalizing clause and no test"
      : "a high-level requirement needs a passing test of its own";
    gap(`no-verifying-test:${r.id}`, `requirement ${r.id} is not verified: ${why}`);
  }
  const failedSeen = new Set<string>();
  for (const r of rows.values()) {
    for (const t of r.verifiedBy) {
      if (t.result === "FAIL" && !failedSeen.has(t.fn)) gap(`test-failed:${t.fn}`, `${t.file}:${t.line}: test '${t.fn}' (${r.id}) FAILED`);
      if (t.result === "FAIL") failedSeen.add(t.fn);
    }
    for (const c of r.formalizedBy) {
      const at = `${c.file}:${c.line}`;
      const id = `${r.id}|${c.fn}|${c.kind}|${c.text}`;
      const siteFailed = (c.callSites ?? []).some(s => s.status === "FAILED");
      if (c.status === "FAILED" && !siteFailed) gap(`clause-failed:${id}`, `${at}: ${c.kind} clause of '${c.fn}' (${r.id}) is FAILED${c.detail ? `: ${c.detail}` : ""}`);
      else if (c.status === "UNKNOWN" && !c.waived) {
        gap(`clause-unknown:${id}`, `${at}: ${c.kind} clause of '${c.fn}' (${r.id}) is UNKNOWN${c.detail ? `: ${c.detail}` : ""}; prove it, @assume it, or test it`);
      }
      for (const s of c.callSites ?? []) {
        if (s.status === "FAILED") {
          gap(`call-site:${id}|${s.caller}`, `${s.file}:${s.line}: call from '${s.caller}' violates ${r.id}: ${c.kind} clause of '${c.fn}'${s.detail ? ` (${s.detail})` : ""}`);
        }
      }
    }
  }
  const listed = o.baseline ?? new Set<string>();
  const seenKeys2 = new Set(gaps.map(g => g.key));
  const baselined = gaps.filter(g => listed.has(g.key)).map(g => g.message);
  for (const g of gaps) if (!listed.has(g.key)) strictFailures.push(g.message);
  const staleBaseline = [...listed].filter(k => !seenKeys2.has(k)).sort();

  return {
    schema: 1,
    entry: relative(process.cwd(), entryAbs),
    requirementsFile: reqPath ? relative(process.cwd(), reqPath) : null,
    strict: o.strict,
    requirements: [...rows.values()],
    untracedFns: untraced,
    derived: derivedFns,
    deactivated,
    assumptions,
    noImplementation,
    noVerifyingTest,
    gaps,
    baselined,
    staleBaseline,
    unknown,
    errors,
    strictFailures,
    ok: errors.length === 0 && (!o.strict || strictFailures.length === 0),
  };
}

/** Errors for the checker path (`check`, `build`): only the requirements file and unknown ids, no prover. */
export function requirementsDiagnostics(program: Program, entry: string): string[] {
  const reqPath = findRequirementsFile(entry);
  if (!reqPath) return [];
  const used = [...program.functions, ...(program.impls ?? []).flatMap(im => im.methods)];
  const anyUse = used.some(f => f.attributes?.some(a => TRACE_ATTRS.has(a.name)) || f.contracts.some(c => c.attributes?.length))
    || program.structs.some(s => s.attributes?.some(a => TRACE_ATTRS.has(a.name)));
  if (!anyUse) return [];
  const rep = buildTrace({ entry, program, prove: null, strict: false });
  return rep.errors;
}

// ── output ──

const rank: Record<Status, number> = { PROVEN: 0, UNKNOWN: 1, FAILED: 2 };

export function formatTrace(r: TraceReport): string {
  const out: string[] = [];
  const byId = new Map(r.requirements.map(x => [x.id, x]));
  out.push(`requirements trace: ${r.entry}${r.requirementsFile ? `  (${r.requirementsFile}, ${r.requirements.length} requirements)` : ""}`);
  for (const e of r.errors) out.push(`error: ${e}`);
  const pad = (s: string) => (s + "          ").slice(0, 14);
  const show = (row: RequirementRow, depth: number) => {
    const ind = "  ".repeat(depth);
    out.push("");
    out.push(`${ind}${row.id}  ${row.text}`);
    const sub = ind + "  ";
    const via = (own: unknown[], pick: (x: RequirementRow) => boolean, flag: boolean) =>
      own.length === 0 && flag ? `(through ${row.children.filter(c => subtree(byId.get(c)!, pick)).join(", ")})` : "";
    const subtree = (x: RequirementRow, pick: (x: RequirementRow) => boolean): boolean => pick(x) || x.children.some(c => subtree(byId.get(c)!, pick));
    for (const i of row.implementedBy) out.push(`${sub}${pad("implemented")}${i.file}:${i.line} ${i.fn}${i.derived ? "  (derived)" : ""}`);
    const v1 = via(row.implementedBy, x => x.implementedBy.length > 0, row.implemented);
    if (v1) out.push(`${sub}${pad("implemented")}${v1}`);
    if (!row.implemented) out.push(`${sub}${pad("implemented")}NONE`);
    for (const c of row.formalizedBy) {
      const tag = c.waived ? `${c.status} (${c.waived === "assume" ? "assumed" : "tested"})` : c.status;
      out.push(`${sub}${pad("formalized")}${tag.padEnd(8)} ${c.file}:${c.line} ${c.text}  [${c.fn}]`);
      if (c.detail && c.status !== "PROVEN") out.push(`${sub}${pad("")}          ${c.detail}`);
      for (const s of [...(c.callSites ?? [])].sort((a, b) => rank[b.status] - rank[a.status] || a.line - b.line)) {
        out.push(`${sub}${pad("")}  call site ${s.status.padEnd(7)} ${s.file}:${s.line} ${s.caller}${s.detail && s.status !== "PROVEN" ? `  ${s.detail}` : ""}`);
      }
    }
    for (const a of row.assumedBy) out.push(`${sub}${pad("assumed")}${a.file}:${a.line} ${a.fn}`);
    if (row.verification === "proof" || row.verification === "proof+test") {
      out.push(`${sub}${pad("verified")}PROOF     ${row.formalizedBy.length} formalizing clause${row.formalizedBy.length === 1 ? "" : "s"} PROVEN`);
    }
    for (const t of row.verifiedBy) out.push(`${sub}${pad("verified")}${(t.result ?? "NOT RUN").padEnd(9)} ${t.file}:${t.line} ${t.fn}`);
    if (!row.verified) out.push(`${sub}${pad("verified")}NONE`);
    for (const c of row.children) show(byId.get(c)!, depth + 1);
  };
  for (const row of r.requirements) if (!row.parent || !byId.has(row.parent)) show(row, 0);

  out.push("");
  const list = (title: string, items: string[]) => {
    out.push(`${title}: ${items.length === 0 ? "none" : ""}`.trimEnd());
    for (const i of items) out.push(`  ${i}`);
  };
  list("untraced fns", r.untracedFns.map(u => `${u.file}:${u.line} ${u.fn}`));
  list("requirements with no implementation", r.noImplementation);
  list("requirements with no verifying test", r.noVerifyingTest);
  if (r.derived.length) list("derived (feed back to the system level)", r.derived.map(u => `${u.file}:${u.line} ${u.fn}`));
  if (r.assumptions.length) list("assumptions (trusted, for review)", r.assumptions.map(u => `${u.file}:${u.line} ${u.fn}`));
  if (r.deactivated.length) list("deactivated code", r.deactivated.map(u => `${u.file}:${u.line} ${u.fn}: ${u.reason}`));
  out.push(`unknown: ${r.unknown}`);
  for (const m of r.baselined) out.push(`warning: baselined gap: ${m}`);
  for (const k of r.staleBaseline) out.push(`warning: baseline lists a gap that is fixed, remove it: ${k}`);
  if (r.strict) {
    out.push("");
    if (r.strictFailures.length === 0 && r.errors.length === 0) out.push("strict: ok");
    else {
      out.push(`strict: ${r.strictFailures.length} failure${r.strictFailures.length === 1 ? "" : "s"}`);
      for (const f of r.strictFailures) out.push(`  error: ${f}`);
    }
  }
  return out.join("\n");
}

// ── command ──

export interface TraceDeps {
  /** Parse, resolve and type-check; exits with the diagnostics on failure. */
  frontend(entry: string): { program: Program; check: unknown };
  /** `milo prove` over the program, default solver unless `z3`. */
  prove(program: Program, check: unknown, entry: string, z3: boolean): ProveResult;
  /** Run the named tests of one file, each in its own process (`milo test`'s runner). Null: the file would not compile. */
  runTests(file: string, names: string[]): Map<string, { pass: boolean; output?: string }> | null;
}

export interface TraceArgs {
  entry: string;
  json: boolean;
  strict: boolean;
  requirements?: string;
  tests?: string;
  z3: boolean;
  /** Skip running the `@req` tests (--no-run). */
  noRun?: boolean;
  /** Gap keys that stay warnings under strict (--baseline). */
  baseline?: string;
  writeBaseline?: string;
}

export function parseTraceArgs(args: string[]): TraceArgs | string {
  const out: TraceArgs = { entry: "", json: false, strict: false, z3: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--solver=z3") out.z3 = true;
    else if (a === "--no-run") out.noRun = true;
    else if (a === "--baseline" || a === "--write-baseline") {
      const v = args[++i];
      if (!v) return `${a} expects a path`;
      if (a === "--baseline") out.baseline = v; else out.writeBaseline = v;
    } else if (a.startsWith("--baseline=")) out.baseline = a.slice(11);
    else if (a.startsWith("--write-baseline=")) out.writeBaseline = a.slice(17);
    else if (a === "--requirements" || a === "--tests") {
      const v = args[++i];
      if (!v) return `${a} expects a path`;
      if (a === "--requirements") out.requirements = v; else out.tests = v;
    } else if (a.startsWith("--requirements=")) out.requirements = a.slice(15);
    else if (a.startsWith("--tests=")) out.tests = a.slice(8);
    else if (a.startsWith("--safety=")) {
      const level = parseSafetyLevel(a.slice(9));
      if (level && traceabilityOf(level) === "strict") out.strict = true;
    }
    else if (a.startsWith("-")) continue;
    else if (!out.entry) out.entry = a;
  }
  return out.entry ? out : "usage: milo trace <entry.milo> [--json] [--strict] [--safety=<do178 profile>] [--requirements <file>] [--tests <file|dir>] [--no-run] [--baseline <file>] [--write-baseline <file>]";
}

export interface BaselineFile { schema: 1; gaps: string[] }

export function loadBaseline(path: string): Set<string> {
  let doc: any;
  try { doc = JSON.parse(readFileSync(path, "utf-8")); } catch (e: any) { throw new Error(`cannot read baseline ${path}: ${e.message}`); }
  if (!doc || !Array.isArray(doc.gaps)) throw new Error(`${path}: expected {"schema": 1, "gaps": [...]}`);
  return new Set(doc.gaps.map(String));
}

/** Run the trace for an entry; returns the report (strict failures are the caller's exit code). */
export function traceEntry(a: TraceArgs, deps: TraceDeps): TraceReport {
  const { program, check } = deps.frontend(a.entry);
  const prove = deps.prove(program, check, a.entry, a.z3);
  const baseline = a.baseline ? loadBaseline(a.baseline) : undefined;
  // The @req tests, run once: a first pass finds them, a second builds the report with verdicts.
  let testResults: Map<string, { pass: boolean; output?: string }> | undefined;
  if (!a.noRun) {
    const first = buildTrace({ entry: a.entry, program, prove, requirementsPath: a.requirements, tests: a.tests, strict: a.strict });
    const entryDir = dirname(resolve(a.entry));
    const byFile = new Map<string, Set<string>>();
    for (const r of first.requirements) for (const t of r.verifiedBy) {
      const abs = resolve(entryDir, t.file);
      if (!byFile.has(abs)) byFile.set(abs, new Set());
      byFile.get(abs)!.add(t.fn);
    }
    testResults = new Map();
    for (const [file, names] of byFile) {
      const res = deps.runTests(file, [...names]);
      for (const n of names) {
        const r = res?.get(n);
        testResults.set(`${file}:${n}`, r ?? { pass: false, output: res ? "test did not run" : "test file did not compile" });
      }
    }
  }
  return buildTrace({ entry: a.entry, program, prove, requirementsPath: a.requirements, tests: a.tests, strict: a.strict, baseline, testResults });
}

export function runTraceCommand(args: string[], deps: TraceDeps): number {
  const a = parseTraceArgs(args);
  if (typeof a === "string") { console.error(a); return 1; }
  const rep = traceEntry(a, deps);
  if (a.writeBaseline) {
    // A baseline only ever shrinks: writing over an existing one may drop fixed gaps but not add new ones.
    const keys = rep.gaps.map(g => g.key).sort();
    if (existsSync(a.writeBaseline)) {
      const old = loadBaseline(a.writeBaseline);
      const added = keys.filter(k => !old.has(k));
      if (added.length) {
        console.error(`error: ${added.length} gap(s) are not in the existing baseline; a baseline can only shrink, so fix them:`);
        for (const k of added) console.error(`  ${k}`);
        return 1;
      }
    }
    writeFileSync(a.writeBaseline, JSON.stringify({ schema: 1, gaps: keys } satisfies BaselineFile, null, 2) + "\n");
    console.log(`baseline: ${keys.length} gap(s) written to ${a.writeBaseline}`);
    return 0;
  }
  if (a.json) process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
  else console.log(formatTrace(rep));
  return rep.ok ? 0 : 1;
}
