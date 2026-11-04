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
// Without a profile the matrix is a report. Strict (`--strict`, or a DO-178C `--safety`
// profile) turns the gaps into errors. TODO(coverage): line/branch coverage of the
// implementing fns by the verifying tests is a later task; today a test is traced, not run
// (run `milo test`), and a requirement's "verified" means a `@req` test exists.
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import type { Attribute, Contract, Function, Program } from "./ast";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import type { ProveResult } from "./verify";

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

export interface RequirementRow {
  id: string;
  text: string;
  parent?: string;
  children: string[];
  implementedBy: (SiteRow & { derived?: true })[];
  formalizedBy: ClauseRow[];
  verifiedBy: SiteRow[];
  assumedBy: SiteRow[];
  /** Own or any descendant's implementation / verifying test: a parent is traced through its children. */
  implemented: boolean;
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
    implementedBy: [], formalizedBy: [], verifiedBy: [], assumedBy: [], implemented: false, verified: false,
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
      for (const id of d.implements) rows.get(id)?.verifiedBy.push(site(d));
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
  for (const r of rows.values()) {
    r.implemented = subtreeHas(r.id, x => x.implementedBy.length > 0);
    r.verified = subtreeHas(r.id, x => x.verifiedBy.length > 0);
  }
  for (const r of rows.values()) {
    for (const c of r.formalizedBy) {
      if (c.status !== "UNKNOWN") continue;
      if (r.assumedBy.some(a => a.fn === c.fn)) c.waived = "assume";
      else if (r.verified) c.waived = "test";
    }
  }

  const noImplementation = [...rows.values()].filter(r => !r.implemented).map(r => r.id);
  const noVerifyingTest = [...rows.values()].filter(r => !r.verified).map(r => r.id);
  const unknown = [...rows.values()].reduce((n, r) => n + r.formalizedBy.filter(c => c.status === "UNKNOWN").length, 0);

  for (const u of untraced) strictFailures.push(`${u.file}:${u.line}: fn '${u.fn}' has no @req (or @derived / @deactivated)`);
  for (const id of noImplementation) strictFailures.push(`requirement ${id} has no implementation`);
  for (const id of noVerifyingTest) strictFailures.push(`requirement ${id} has no verifying test`);
  for (const r of rows.values()) {
    for (const c of r.formalizedBy) {
      const at = `${c.file}:${c.line}`;
      const siteFailed = (c.callSites ?? []).some(s => s.status === "FAILED");
      if (c.status === "FAILED" && !siteFailed) strictFailures.push(`${at}: ${c.kind} clause of '${c.fn}' (${r.id}) is FAILED${c.detail ? `: ${c.detail}` : ""}`);
      else if (c.status === "UNKNOWN" && !c.waived) {
        strictFailures.push(`${at}: ${c.kind} clause of '${c.fn}' (${r.id}) is UNKNOWN${c.detail ? `: ${c.detail}` : ""}; prove it, @assume it, or test it`);
      }
      for (const s of c.callSites ?? []) {
        if (s.status === "FAILED") {
          strictFailures.push(`${s.file}:${s.line}: call from '${s.caller}' violates ${r.id}: ${c.kind} clause of '${c.fn}'${s.detail ? ` (${s.detail})` : ""}`);
        }
      }
    }
  }

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
    for (const t of row.verifiedBy) out.push(`${sub}${pad("verified")}${t.file}:${t.line} ${t.fn}`);
    const v2 = via(row.verifiedBy, x => x.verifiedBy.length > 0, row.verified);
    if (v2) out.push(`${sub}${pad("verified")}${v2}`);
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
}

export interface TraceArgs {
  entry: string;
  json: boolean;
  strict: boolean;
  requirements?: string;
  tests?: string;
  z3: boolean;
}

export function parseTraceArgs(args: string[]): TraceArgs | string {
  const out: TraceArgs = { entry: "", json: false, strict: false, z3: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--solver=z3") out.z3 = true;
    else if (a === "--requirements" || a === "--tests") {
      const v = args[++i];
      if (!v) return `${a} expects a path`;
      if (a === "--requirements") out.requirements = v; else out.tests = v;
    } else if (a.startsWith("--requirements=")) out.requirements = a.slice(15);
    else if (a.startsWith("--tests=")) out.tests = a.slice(8);
    else if (a.startsWith("--safety=")) { if (a.slice(9).startsWith("do178")) out.strict = true; }
    else if (a.startsWith("-")) continue;
    else if (!out.entry) out.entry = a;
  }
  return out.entry ? out : "usage: milo trace <entry.milo> [--json] [--strict] [--safety=<do178 profile>] [--requirements <file>] [--tests <file|dir>]";
}

/** Run the trace for an entry; returns the report (strict failures are the caller's exit code). */
export function traceEntry(a: TraceArgs, deps: TraceDeps): TraceReport {
  const { program, check } = deps.frontend(a.entry);
  const prove = deps.prove(program, check, a.entry, a.z3);
  return buildTrace({ entry: a.entry, program, prove, requirementsPath: a.requirements, tests: a.tests, strict: a.strict });
}

export function runTraceCommand(args: string[], deps: TraceDeps): number {
  const a = parseTraceArgs(args);
  if (typeof a === "string") { console.error(a); return 1; }
  const rep = traceEntry(a, deps);
  if (a.json) process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
  else console.log(formatTrace(rep));
  return rep.ok ? 0 : 1;
}
