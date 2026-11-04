// Spec lock: agents may change code freely but may not silently weaken intent. The intent
// surface is every requirement (requirements.json) plus every contract clause and struct
// invariant. `milo spec <entry>` prints it; `milo spec --diff <ref> <entry>` classifies each
// change against a git ref; spec-signoff.json (beside requirements.json) records the human
// acceptance of a change. `milo trace --strict --spec-base <ref>` fails on an unsigned one.
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, relative, resolve } from "path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import type { Contract, Expr, Function as Fn } from "./ast";
import { clauseImplies } from "./verify";
import { findRequirementsFile, moduleDir } from "./requirements";
import { writePacket } from "./specPacket";

export interface SpecClause {
  id: string;
  kind: Contract["kind"] | "struct invariant";
  text: string;
  /** Hash of the clause's AST (spans stripped): formatting-only edits do not change it. */
  hash: string;
  expr: Expr;
  /** Context the implication check needs. */
  fn?: { params: [string, string][]; ret?: string; requires: Expr[] };
  fields?: [string, string][];
}
export interface SpecSurface {
  requirements: Map<string, string>;
  clauses: Map<string, SpecClause>;
  /** id -> hash accepted in spec-signoff.json */
  signoffs: { id: string; hash: string; who: string; why: string }[];
}

type Source = { read(rel: string): string | null; milo(): string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const canon = (e: unknown) => JSON.stringify(e, (k, v) => k === "span" ? undefined : typeof v === "bigint" ? String(v) : v);

function skipDir(n: string) { return n === "node_modules" || n === ".git" || n.startsWith("."); }

export function fsSource(root: string): Source {
  return {
    read: rel => { const p = join(root, rel); return existsSync(p) ? readFileSync(p, "utf-8") : null; },
    milo: () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) { if (!skipDir(n)) walk(p); }
          else if (n.endsWith(".milo")) out.push(relative(root, p));
        }
      };
      if (existsSync(root)) walk(root);
      return out;
    },
  };
}

function gitSource(top: string, ref: string, relRoot: string): Source {
  const git = (args: string[]) => spawnSync("git", ["-C", top, ...args], { encoding: "utf-8", maxBuffer: 1 << 28 });
  const prefix = relRoot ? relRoot + "/" : "";
  return {
    read: rel => { const r = git(["show", `${ref}:${prefix}${rel}`]); return r.status === 0 ? r.stdout : null; },
    milo: () => {
      const r = git(["ls-tree", "-r", "--name-only", ref, "--", relRoot || "."]);
      if (r.status !== 0) return [];
      return r.stdout.split("\n").filter(f => f.endsWith(".milo") && !f.slice(prefix.length).split("/").some(skipDir)).map(f => f.slice(prefix.length)).sort();
    },
  };
}

function exprLine(src: string, e: Expr): string {
  const sp = (e as any).span as { line: number; col: number } | undefined;
  if (!sp) return "?";
  const line = src.split("\n")[sp.line - 1] ?? "";
  return line.slice(sp.col - 1).replace(/\s*\/\/.*$/, "").trim();
}

const reqTag = (c: Contract) => (c.attributes ?? []).filter(a => a.name === "req").map(a => `@${a.args.join(",")}`).join(" ");

function collect(src: Source, requirementsRel: string | null): SpecSurface {
  const requirements = new Map<string, string>();
  let signoffs: SpecSurface["signoffs"] = [];
  if (requirementsRel) {
    const text = src.read(requirementsRel);
    if (text) {
      try { for (const r of JSON.parse(text).requirements ?? []) requirements.set(String(r.id), String(r.text ?? "")); } catch { /* reported by trace */ }
    }
    const so = src.read(join(dirname(requirementsRel), "spec-signoff.json").replace(/^\.\//, ""));
    if (so) {
      try { signoffs = (JSON.parse(so).signoffs ?? []).map((s: any) => ({ id: String(s.id), hash: String(s.hash), who: String(s.who ?? ""), why: String(s.why ?? "") })); } catch { /* ignored: an unreadable file signs nothing */ }
    }
  }
  const clauses = new Map<string, SpecClause>();
  const add = (base: string, c: SpecClause) => {
    let id = base, n = 1;
    while (clauses.has(id)) id = `${base}#${++n}`;
    clauses.set(id, { ...c, id });
  };
  for (const file of src.milo()) {
    const text = src.read(file);
    if (text === null) continue;
    let program;
    try { program = new Parser(new Lexer(text).tokenize(), text, file).parse(); } catch { continue; }
    const fns: Fn[] = [...program.functions];
    for (const im of program.impls ?? []) for (const m of im.methods) fns.push({ ...m, name: `${im.typeName}.${m.name}` });
    for (const fn of fns) {
      const params: [string, string][] = fn.params.map(p => [p.name, p.type?.name ?? "i64"]);
      const requires = fn.contracts.filter(c => c.kind === "requires").map(c => c.expr);
      for (const c of fn.contracts) {
        const tag = reqTag(c);
        add(`${file}:${fn.name} ${c.kind}${tag ? " " + tag : ""}`, {
          id: "", kind: c.kind, text: exprLine(text, c.expr), hash: sha(canon(c.expr)), expr: c.expr,
          fn: { params, ret: fn.retType?.name, requires },
        });
      }
    }
    for (const st of program.structs ?? []) {
      const fields: [string, string][] = st.fields.map(f => [f.name, f.type.name]);
      for (const c of st.invariants ?? []) {
        const tag = reqTag(c);
        add(`${file}:${st.name} invariant${tag ? " " + tag : ""}`, { id: "", kind: "struct invariant", text: exprLine(text, c.expr), hash: sha(canon(c.expr)), expr: c.expr, fields });
      }
    }
  }
  return { requirements, clauses, signoffs };
}

/** Where the entry's project lives, relative to the git top-level, and its requirements.json relative to the project dir. */
export function layout(entry: string): { projectDir: string; requirementsRel: string | null } {
  const own = moduleDir(entry);
  const projectDir = own ?? dirname(resolve(entry));
  const req = findRequirementsFile(entry);
  return { projectDir, requirementsRel: req ? relative(projectDir, req) : null };
}

export function specSurface(entry: string): SpecSurface {
  const { projectDir, requirementsRel } = layout(entry);
  return collect(fsSource(projectDir), requirementsRel);
}

export function formatSpec(s: SpecSurface): string {
  const out: string[] = [];
  for (const [id, text] of s.requirements) out.push(`requirement ${id}: ${text}`);
  for (const [id, c] of s.clauses) out.push(`${c.kind === "struct invariant" ? "invariant" : "clause"} ${id}: ${c.text}`);
  return out.join("\n");
}

export type SpecVerdict = "ok" | "needs-signoff";
export interface SpecChange {
  id: string;
  what: string;
  verdict: SpecVerdict;
  /** The hash a spec-signoff.json entry must carry to accept this change. */
  hash: string;
  signedOff?: boolean;
  was?: string;
  now?: string;
  counterexample?: string;
  note?: string;
}

function classifyClause(old: SpecClause, now: SpecClause): { strengthens: boolean | null; counterexample?: string; note: string } {
  const undecided = (note: string) => ({ strengthens: null, note });
  if (old.kind !== now.kind) return undecided("clause kind changed");
  if (old.kind === "decreases") return undecided("termination measure changed; not comparable");
  const vars = new Map<string, string>();
  if (old.kind === "struct invariant") {
    if (canon(old.fields) !== canon(now.fields)) return undecided("struct fields changed");
    for (const [n, t] of now.fields!) vars.set(n, t);
    const r = clauseImplies(vars, [], now.expr, old.expr);
    return verdictOf(r, "new invariant implies old", "new invariant allows a state the old one forbade");
  }
  if (canon(old.fn!.params) !== canon(now.fn!.params) || old.fn!.ret !== now.fn!.ret) return undecided("signature changed");
  for (const [n, t] of now.fn!.params) vars.set(n, t);
  if (old.kind === "requires") {
    const r = clauseImplies(vars, [], old.expr, now.expr);
    return verdictOf(r, "old requires implies new: callers lose nothing", "an input the old requires accepted, the new one rejects");
  }
  if (now.fn!.ret && now.fn!.ret !== "void") vars.set("result", now.fn!.ret);
  const r = clauseImplies(vars, old.fn!.requires, now.expr, old.expr);
  return verdictOf(r, "new implies old under the old requires", "an outcome the new contract allows and the old one forbade");
}

function verdictOf(r: ReturnType<typeof clauseImplies>, good: string, bad: string) {
  if (r.status === "implies") return { strengthens: true as const, note: good };
  if (r.status === "refuted") return { strengthens: false as const, counterexample: r.model || "(no model)", note: `weakened: ${bad}` };
  return { strengthens: null, note: "z3 could not decide" };
}

export function diffSurfaces(old: SpecSurface, now: SpecSurface): SpecChange[] {
  const out: SpecChange[] = [];
  for (const [id, text] of now.requirements) {
    const was = old.requirements.get(id);
    if (was === undefined) out.push({ id, what: "requirement added", verdict: "ok", hash: sha(text), now: text });
    else if (was !== text) out.push({ id, what: "requirement text changed", verdict: "needs-signoff", hash: sha(text), was, now: text });
  }
  for (const [id, text] of old.requirements) {
    if (!now.requirements.has(id)) out.push({ id, what: "requirement removed", verdict: "needs-signoff", hash: "removed", was: text });
  }
  for (const [id, c] of now.clauses) {
    const was = old.clauses.get(id);
    if (!was) { out.push({ id, what: "clause added", verdict: "ok", hash: c.hash, now: c.text }); continue; }
    if (was.hash === c.hash) continue;
    const k = classifyClause(was, c);
    out.push({
      id, what: k.strengthens === true ? "clause strengthened" : k.strengthens === false ? "clause weakened" : "clause changed, undecided",
      verdict: k.strengthens === true ? "ok" : "needs-signoff", hash: c.hash, was: was.text, now: c.text,
      ...(k.counterexample ? { counterexample: k.counterexample } : {}), note: k.note,
    });
  }
  for (const [id, c] of old.clauses) {
    if (!now.clauses.has(id)) out.push({ id, what: "clause removed", verdict: "needs-signoff", hash: "removed", was: c.text });
  }
  for (const ch of out) {
    if (ch.verdict === "needs-signoff" && now.signoffs.some(s => s.id === ch.id && s.hash === ch.hash)) { ch.signedOff = true; ch.verdict = "ok"; }
  }
  return out;
}

export function specDiff(entry: string, ref: string): { changes: SpecChange[]; error?: string } {
  const { projectDir, requirementsRel } = layout(entry);
  const top = spawnSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (top.status !== 0) return { changes: [], error: `${projectDir} is not in a git repository` };
  const root = top.stdout.trim();
  if (spawnSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf-8" }).status !== 0) return { changes: [], error: `unknown git ref: ${ref}` };
  // realpath-insensitive: both sides are resolved from the same git root
  const rootReal = spawnSync("git", ["-C", projectDir, "rev-parse", "--show-prefix"], { encoding: "utf-8" }).stdout.trim().replace(/\/$/, "");
  const old = collect(gitSource(root, ref, rootReal), requirementsRel);
  return { changes: diffSurfaces(old, specSurface(entry)) };
}

export function unsignedChanges(changes: SpecChange[]): SpecChange[] {
  return changes.filter(c => c.verdict === "needs-signoff");
}

export function formatDiff(ref: string, changes: SpecChange[]): string {
  const out = [`spec diff against ${ref}: ${changes.length} change${changes.length === 1 ? "" : "s"}`];
  for (const c of changes) {
    const tag = c.verdict === "ok" ? (c.signedOff ? "ok (signed off)" : "ok") : "NEEDS SIGN-OFF";
    out.push(`  ${tag}: ${c.what}: ${c.id}  [hash ${c.hash}]`);
    if (c.was !== undefined) out.push(`      was: ${c.was}`);
    if (c.now !== undefined) out.push(`      now: ${c.now}`);
    if (c.note) out.push(`      ${c.note}`);
    if (c.counterexample) out.push(`      counterexample: ${c.counterexample}`);
  }
  const n = unsignedChanges(changes).length;
  out.push(n ? `${n} change${n === 1 ? " needs" : "s need"} sign-off in spec-signoff.json` : "spec lock: ok");
  return out.join("\n");
}

/** `milo spec [--diff <ref> | --packet <outdir>] [--json] <entry>` */
export function runSpecCommand(args: string[]): number {
  let ref: string | undefined, entry = "", json = false, packet: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--diff") ref = args[++i];
    else if (a.startsWith("--diff=")) ref = a.slice(7);
    else if (a === "--packet") packet = args[++i];
    else if (a.startsWith("--packet=")) packet = a.slice(9);
    else if (a === "--json") json = true;
    else if (!a.startsWith("-") && !entry) entry = a;
  }
  if (!entry || (args.includes("--diff") && !ref) || (args.some(a => a === "--packet") && !packet)) { console.error("usage: milo spec [--diff <git-ref> | --packet <outdir>] [--json] <entry.milo>"); return 1; }
  if (packet !== undefined) {
    try {
      const r = writePacket(entry, packet);
      console.log(`${r.outdir}: ${r.files.length} files`);
      return 0;
    } catch (e) { console.error(`error: ${(e as Error).message}`); return 1; }
  }
  if (ref === undefined) {
    const s = specSurface(entry);
    console.log(json ? JSON.stringify({ requirements: Object.fromEntries(s.requirements), clauses: [...s.clauses.values()].map(c => ({ id: c.id, kind: c.kind, text: c.text, hash: c.hash })) }, null, 2) : formatSpec(s));
    return 0;
  }
  const r = specDiff(entry, ref);
  if (r.error) { console.error(`error: ${r.error}`); return 1; }
  console.log(json ? JSON.stringify(r.changes, null, 2) : formatDiff(ref, r.changes));
  return unsignedChanges(r.changes).length ? 1 : 0;
}
