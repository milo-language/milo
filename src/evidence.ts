// Evidence records: the committed proof that a requirement's inspection, review, demonstration
// or non-unit test claim was met. `milo trace` reads them (src/requirements.ts) so a claim like
// "p95 under 300 ms, test@load" can be satisfied by a record instead of staying a gap forever.
//
//   milo evidence add  <entry.milo> <REQ> --method m [--env e] --result pass|fail ...   (attested)
//   milo evidence run  <entry.milo> <REQ> --method m [--env e] ... -- <cmd> [args...]   (run)
//   milo evidence list <entry.milo>
//
// A record lives in <dir of requirements.json>/evidence/ and is committed; git history says who.
// It pins the requirement text and the implementing code by hash, so editing either makes it stale.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, relative, resolve } from "path";
import type { Function as Fn } from "./ast";
import { ENV_RE, VERIFICATION_METHODS, findRequirementsFile, implementingFns, loadRequirements, type Requirement, type TraceDeps } from "./requirements";

export interface EvidenceRecord {
  req: string;
  method: string;
  env?: string;
  result: "pass" | "fail";
  source: "attested" | "run";
  argv?: string[];
  measured?: string;
  note?: string;
  artifact?: { path: string; sha256: string };
  date: string;
  commit: string | null;
  textHash: string;
  codeHash: string;
}

/** A record and the path it was read from, relative to the requirements directory. */
export interface EvidenceFile { file: string; rec: EvidenceRecord }

export type EvidenceState = "PASS" | "FAILED" | "STALE";
export interface EvidenceRow {
  claim: string;
  state: EvidenceState;
  /** Why a STALE or FAILED record does not count. */
  reason?: "failed" | "text" | "code" | "artifact";
  file: string;
  source: "attested" | "run";
  date: string;
  measured?: string;
}

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const canon = (e: unknown) => JSON.stringify(e, (k, v) => k === "span" || k === "sourceFile" ? undefined : typeof v === "bigint" ? String(v) : v);

export const textHash = (text: string) => sha12(text);

/**
 * Hash of the AST (spans stripped, so reformatting does not change it) of every fn with
 * @req(REQ) or @derived(REQ), sorted by name. Only those fns: their transitive callees are
 * NOT included, so a change in a helper they call does not make a record stale.
 */
export function codeHash(fns: { name: string; fn: Fn }[]): string {
  const parts = fns.map(f => ({ name: f.name, ast: canon(f.fn) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.ast < b.ast ? -1 : 1);
  return sha12(canon(parts));
}

export const claimKey = (method: string, env?: string) => env ? `${method}@${env}` : method;

export function loadEvidence(reqDir: string): EvidenceFile[] {
  const dir = join(reqDir, "evidence");
  if (!existsSync(dir)) return [];
  const out: EvidenceFile[] = [];
  for (const n of readdirSync(dir).sort()) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, n), "utf-8")) as EvidenceRecord;
      if (rec && typeof rec.req === "string" && typeof rec.method === "string") out.push({ file: `evidence/${n}`, rec });
    } catch { /* an unreadable record is not evidence */ }
  }
  return out;
}

/** The latest record (by date, file name breaking ties) for one (req, method, env), or undefined. */
export function latestRecord(all: EvidenceFile[], req: string, method: string, env?: string): EvidenceFile | undefined {
  const mine = all.filter(e => e.rec.req === req && e.rec.method === method && e.rec.env === env);
  mine.sort((a, b) => a.rec.date < b.rec.date ? -1 : a.rec.date > b.rec.date ? 1 : a.file < b.file ? -1 : 1);
  return mine[mine.length - 1];
}

/** Whether one record still counts for the requirement as it is now. */
export function judge(e: EvidenceFile, reqText: string, codeNow: string, reqDir: string): EvidenceRow {
  const r = e.rec;
  const base = { claim: claimKey(r.method, r.env), file: e.file, source: r.source, date: r.date, ...(r.measured ? { measured: r.measured } : {}) };
  if (r.result !== "pass") return { ...base, state: "FAILED", reason: "failed" };
  if (r.textHash !== textHash(reqText)) return { ...base, state: "STALE", reason: "text" };
  if (r.codeHash !== codeNow) return { ...base, state: "STALE", reason: "code" };
  if (r.artifact) {
    const p = join(reqDir, r.artifact.path);
    if (!existsSync(p) || sha256File(p) !== r.artifact.sha256) return { ...base, state: "STALE", reason: "artifact" };
  }
  return { ...base, state: "PASS" };
}

/** The gap message for a claim whose latest record does not count, or for no record at all. */
export function gapMessage(id: string, claim: string, row: EvidenceRow | undefined, artifactPath?: string): string {
  if (!row) return `requirement ${id} lists verification "${claim}", no evidence record (milo evidence add|run)`;
  const day = row.date.slice(0, 10);
  if (row.reason === "failed") return `requirement ${id}: latest evidence record for "${claim}" failed: ${row.file}`;
  if (row.reason === "text") return `requirement ${id}: evidence for "${claim}" is stale: the requirement text changed since ${day}`;
  if (row.reason === "code") return `requirement ${id}: evidence for "${claim}" is stale: the implementing code changed since ${day}`;
  return `requirement ${id}: evidence artifact changed or missing: ${artifactPath ?? row.file}`;
}

// ── commands ──

const USAGE = `usage: milo evidence add <entry.milo> <REQ> --method <m> [--env <e>] --result pass|fail [--measured "<text>"] [--artifact <path>] [--note "<text>"]
       milo evidence run <entry.milo> <REQ> --method <m> [--env <e>] [--measured "<text>"] [--note "<text>"] -- <cmd> [args...]
       milo evidence list <entry.milo>`;

class UsageError extends Error {}

function gitHead(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function runEvidenceCommand(args: string[], deps: TraceDeps): number {
  try {
    return evidenceMain(args, deps);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}\n${USAGE}`);
    return 2;
  }
}

function projectOf(entry: string): { reqPath: string; reqDir: string; reqs: Requirement[] } {
  if (!entry.endsWith(".milo") || !existsSync(entry)) throw new UsageError(`cannot find the entry file '${entry}'`);
  const reqPath = findRequirementsFile(entry);
  if (!reqPath || !existsSync(reqPath)) throw new UsageError(`no requirements.json for ${entry}`);
  const loaded = loadRequirements(reqPath);
  if (loaded.errors.length) throw new UsageError(loaded.errors.join("\n"));
  return { reqPath, reqDir: dirname(reqPath), reqs: loaded.reqs };
}

function evidenceMain(args: string[], deps: TraceDeps): number {
  const sub = args[0];
  if (sub !== "add" && sub !== "run" && sub !== "list") throw new UsageError(sub ? `unknown evidence command '${sub}'` : "missing command");
  let rest = args.slice(1);
  let argv: string[] | undefined;
  const dd = rest.indexOf("--");
  if (sub === "run") {
    if (dd < 0 || dd === rest.length - 1) throw new UsageError("run needs a command after --");
    argv = rest.slice(dd + 1);
    rest = rest.slice(0, dd);
  }
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  const allowed = sub === "add" ? ["method", "env", "result", "measured", "artifact", "note"] : sub === "run" ? ["method", "env", "measured", "note"] : [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!allowed.includes(k)) throw new UsageError(`unknown flag ${a}`);
      const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      opt[k] = v;
    } else pos.push(a);
  }
  const entry = pos[0];
  if (!entry) throw new UsageError("missing <entry.milo>");
  if (pos.length !== (sub === "list" ? 1 : 2)) throw new UsageError(sub === "list" ? "list takes only <entry.milo>" : "expected <entry.milo> <REQ>");
  const { reqDir, reqs } = projectOf(entry);
  const { program } = deps.frontend(entry);
  const codeOf = (id: string) => codeHash(implementingFns(program, entry, id));

  if (sub === "list") {
    const all = loadEvidence(reqDir);
    if (!all.length) console.log("no evidence records");
    for (const e of all) {
      const req = reqs.find(r => r.id === e.rec.req);
      const row = req ? judge(e, req.text, codeOf(req.id), reqDir) : undefined;
      const latest = latestRecord(all, e.rec.req, e.rec.method, e.rec.env) === e;
      const state = !row ? "UNKNOWN-REQ" : row.state + (row.reason && row.reason !== "failed" ? `(${row.reason})` : "");
      console.log(`${e.file}  ${e.rec.req}  ${claimKey(e.rec.method, e.rec.env)}  ${state}  ${e.rec.date.slice(0, 10)}  (${e.rec.source})${latest ? "" : "  superseded"}`);
    }
    return 0;
  }

  const id = pos[1]!;
  const req = reqs.find(r => r.id === id);
  if (!req) throw new UsageError(`unknown requirement '${id}'`);
  const method = opt.method;
  if (!method) throw new UsageError("--method is required");
  if (!(VERIFICATION_METHODS as readonly string[]).includes(method)) throw new UsageError(`--method must be one of ${VERIFICATION_METHODS.join(", ")}`);
  const env = opt.env;
  if (env !== undefined && !ENV_RE.test(env)) throw new UsageError(`--env must be a lowercase token, got '${env}'`);
  let result: "pass" | "fail";
  let artifactFile: string | undefined;
  if (sub === "add") {
    if (opt.result !== "pass" && opt.result !== "fail") throw new UsageError("--result pass|fail is required");
    result = opt.result;
    if (opt.artifact !== undefined) {
      artifactFile = resolve(opt.artifact);
      if (!existsSync(artifactFile)) throw new UsageError(`--artifact file not found: ${opt.artifact}`);
    }
  } else result = "pass";

  const now = new Date().toISOString();
  const rec: EvidenceRecord = {
    req: id, method, ...(env !== undefined ? { env } : {}), result, source: sub === "run" ? "run" : "attested",
    ...(argv ? { argv } : {}),
    ...(opt.measured !== undefined ? { measured: opt.measured } : {}),
    ...(opt.note !== undefined ? { note: opt.note } : {}),
    date: now, commit: gitHead(reqDir), textHash: textHash(req.text), codeHash: codeOf(id),
  };
  let exit = 0;
  let log = "";
  if (sub === "run") {
    const r = spawnSync(argv![0]!, argv!.slice(1), { encoding: "buffer", env: process.env, maxBuffer: 1 << 28 });
    // stdout and stderr are kept in separate pipes, so the log is stdout then stderr, not interleaved.
    log = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]).toString("utf-8");
    if (r.error) log += `\n${r.error.message}\n`;
    exit = r.status ?? 1;
    rec.result = exit === 0 ? "pass" : "fail";
  }
  // The id hashes everything but the artifact's path (a run's log is named after the id).
  const artifactSha = sub === "run" ? sha256Text(log) : artifactFile ? sha256File(artifactFile) : undefined;
  const recId = sha12(canon({ ...rec, artifactSha }));
  const dir = join(reqDir, "evidence");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  if (sub === "run") {
    const path = `evidence/artifacts/${recId}.log`;
    writeFileSync(join(reqDir, path), log);
    rec.artifact = { path, sha256: artifactSha! };
  } else if (artifactFile) {
    rec.artifact = { path: relative(reqDir, artifactFile), sha256: artifactSha! };
  }
  const name = `${id}-${method}${env ? `-${env}` : ""}-${recId}.json`;
  writeFileSync(join(dir, name), JSON.stringify(rec, null, 2) + "\n");
  console.log(`evidence: ${rec.result.toUpperCase()} ${claimKey(method, env)} ${id}  evidence/${name}  (${rec.source})`);
  return sub === "run" ? exit : 0;
}

const sha256Text = (s: string) => createHash("sha256").update(s).digest("hex");
