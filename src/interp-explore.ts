// `milo interp --explore`: run a program under many schedules of its green tasks and report the ones that
// deadlock, panic, fail an assert or contract, or print something other than the default (FIFO) run.
// Rules R-EXPLORE-* in docs/semantics/milo.md section 5.
//
// Each schedule is a fresh run of the program (runs are deterministic, so re-running is the simple way to
// get a state back). A schedule is the list of indices taken at the choice points, the pickNext calls with
// two or more tasks ready; past the list the run is FIFO. That list replays with `--schedule`.
import type { Program } from "./ast";
import type { CheckResult } from "./checker";
import { InterpCo, type Task } from "./interp-co";
import type { SysOptions } from "./interp-sys";
import { InterpStuck, InterpUnsupported } from "./interp-values";

export interface ExploreOptions {
  maxSchedules: number; // exhaustive DFS stops here
  random?: number; // N random (PCT) schedules instead of the DFS
  seed: number;
  allowNondeterministicOutput: boolean;
  entryFile: string;
  sys: SysOptions;
}

export type FailureKind = "deadlock" | "panic" | "assert" | "contract" | "stuck" | "nondeterministic-output";
interface Step { task: number; fp: Set<number>; stop: string; cp: number }
interface ChoicePoint { step: number; ready: number[]; chosen: number }
interface Run {
  schedule: number[];
  steps: Step[];
  cps: ChoicePoint[];
  kind: FailureKind | "ok" | "truncated";
  detail: string;
  stdout: string;
  stderr: string;
  code: number;
}

// A run that never ends (a server loop) is cut here: its schedule is neither good nor bad.
const MAX_STEPS = 200_000;
// A task that spins on an atomic waiting for a task that cannot run (nothing preempts it) never reaches pickNext
// again; counting its shared accesses is the only way out of that step.
const MAX_ACCESSES = 500_000;
class StepLimit extends Error {}

type Chooser = (ex: ExploreCo, ready: readonly Task[]) => number;

class ExploreCo extends InterpCo {
  steps: Step[] = [];
  cps: ChoicePoint[] = [];
  chosen: number[] = [];
  private ids = new Map<unknown, number>();
  private outAt = 0;
  private errAt = 0;
  private lastStop = "";
  private accesses = 0;
  constructor(p: Program, r: CheckResult, private chooser: Chooser) {
    super(p, r);
    this.onTouch = k => {
      if (++this.accesses > MAX_ACCESSES) throw new StepLimit();
      const s = this.steps[this.steps.length - 1];
      if (!s) return;
      let id = this.ids.get(k);
      if (id === undefined) { id = this.ids.size; this.ids.set(k, id); }
      s.fp.add(id);
    };
    this.mem.onAccess = a => this.touch(a);
  }
  // A global that is only read is constant; the others are shared state.
  override globalSlot(name: string) {
    if (this.cr.nonConstGlobals.includes(name)) this.touch("global " + name);
    return super.globalSlot(name);
  }
  override *runNative$g(nat: Parameters<InterpCo["runNative$g"]>[0], args: Parameters<InterpCo["runNative$g"]>[1], e?: import("./ast").Expr): ReturnType<InterpCo["runNative$g"]> {
    if (e?.span) this.lastStop = `${(e.span.file ?? this.entryFile).split("/").pop()}:${e.span.line}`;
    return yield* super.runNative$g(nat, args, e);
  }
  // R-EXPLORE-CHOICE
  closeStep(): void {
    const s = this.steps[this.steps.length - 1];
    if (!s) return;
    // output is shared by every task: two steps that print do not commute
    if (this.out.length !== this.outAt || this.err.length !== this.errAt) this.touch("io");
    s.stop = this.lastStop;
  }
  override pickNext(ready: readonly Task[]): number {
    this.closeStep();
    if (this.steps.length >= MAX_STEPS) throw new StepLimit();
    let idx = 0;
    let cp = -1;
    if (ready.length > 1) {
      idx = this.chooser(this, ready);
      cp = this.cps.length;
      this.cps.push({ step: this.steps.length, ready: ready.map(t => t.id), chosen: idx });
      this.chosen.push(idx);
    }
    this.steps.push({ task: ready[idx]!.id, fp: new Set(), stop: "", cp });
    this.outAt = this.out.length; this.errAt = this.err.length;
    this.lastStop = "";
    this.accesses = 0;
    return idx;
  }
}

// R-EXPLORE-FAIL
function runOnce(program: Program, checked: CheckResult, ex: ExploreOptions, chooser: Chooser, schedule: number[]): Run {
  const it = new ExploreCo(program, checked, chooser);
  it.contractChecks = true;
  it.loopInvariantChecks = true;
  it.entryFile = ex.entryFile;
  it.sysOptions = ex.sys;
  let kind: Run["kind"] = "ok";
  let detail = "";
  let code = 0;
  let stderr = "";
  try {
    const r = it.run();
    code = r.code; stderr = r.stderr;
    const msg = it.taskPanics[0] ?? (code === 134 ? stderr.trim().split("\n")[0]! : "");
    if (msg) { kind = classifyPanic(msg); detail = msg; }
  } catch (e) {
    if (e instanceof StepLimit) { kind = "truncated"; detail = "cut: too many steps, or a step that spins"; }
    else if (e instanceof InterpStuck) { kind = e.rule === "S-DEADLOCK" ? "deadlock" : "stuck"; detail = e.message.replace(/^interp: stuck at \S+: /, ""); code = 4; }
    else if (e instanceof InterpUnsupported) throw e;
    else throw e;
  }
  it.closeStep();
  return { schedule, steps: it.steps, cps: it.cps, kind, detail, stdout: new TextDecoder().decode(Uint8Array.from(it.out)), stderr, code };
}
const classifyPanic = (m: string): FailureKind => (/assertion failed/.test(m) ? "assert" : /clause violated/.test(m) ? "contract" : "panic");

// The schedule list for `--schedule`: trailing zeros are the fallback anyway.
const trimmed = (s: readonly number[]): number[] => { const a = [...s]; while (a.length && a[a.length - 1] === 0) a.pop(); return a; };

const prefixChooser = (prefix: readonly number[]): Chooser => (ex, ready) => {
  const i = prefix[ex.cps.length];
  return i !== undefined && i < ready.length ? i : 0;
};

// Probabilistic concurrency testing: each task gets a random priority, the highest-priority ready task runs, and
// at `depth - 1` random steps the running task drops to the lowest priority.
// R-EXPLORE-RANDOM
function pctChooser(rng: () => number, horizon: number, depth: number): Chooser {
  const prio = new Map<number, number>();
  const change = new Set<number>();
  for (let i = 1; i < depth; i++) change.add(Math.floor(rng() * Math.max(1, horizon)));
  let low = 0;
  return (ex, ready) => {
    if (change.has(ex.steps.length) && ex.steps.length > 0) prio.set(ex.steps[ex.steps.length - 1]!.task, --low);
    let best = 0, bp = -Infinity;
    ready.forEach((t, i) => {
      if (!prio.has(t.id)) prio.set(t.id, 1 + rng());
      const p = prio.get(t.id)!;
      if (p > bp) { bp = p; best = i; }
    });
    return best;
  };
}
// R-EXPLORE-RANDOM
function mulberry32(a: number): () => number {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Moving step `alt` (the first later step of the other task) in front of the chosen one gives an equivalent
// run when it shares nothing with the steps in between (R-EXPLORE-INDEP): the swapped schedule is not new.
function independent(run: Run, cp: ChoicePoint, other: number): boolean | null {
  let j = cp.step + 1;
  while (j < run.steps.length && run.steps[j]!.task !== other) j++;
  if (j >= run.steps.length) return null; // it never ran again in this run (the program ended first): unknown
  const fp = run.steps[j]!.fp;
  for (let s = cp.step; s < j; s++) for (const k of run.steps[s]!.fp) if (fp.has(k)) return false;
  return true;
}

interface Finding { kind: FailureKind; run: Run; index: number }

export interface ExploreReport { text: string; failures: number; findings: Finding[]; schedules: number }

// R-EXPLORE-DFS R-EXPLORE-FAIL
export function explore(program: Program, checked: CheckResult, ex: ExploreOptions, file: string): ExploreReport {
  const base = runOnce(program, checked, ex, prefixChooser([]), []);
  const runs: Run[] = [base];
  let pruned = 0;
  let leftover = 0;
  let truncated = base.kind === "truncated" ? 1 : 0;
  const outcomes = new Set<string>();
  const outcomeKey = (r: Run) => `${r.kind}|${r.code}|${r.stdout}`;
  outcomes.add(outcomeKey(base));
  const findings = new Map<FailureKind, Finding>();
  const judge = (r: Run, index: number) => {
    let k: FailureKind | null = r.kind === "ok" || r.kind === "truncated" ? null : r.kind;
    if (!k && r.kind === "ok" && r.stdout !== base.stdout) k = "nondeterministic-output";
    if (k && !findings.has(k)) findings.set(k, { kind: k, run: r, index });
  };
  judge(base, 1);
  const note = (r: Run) => { outcomes.add(outcomeKey(r)); if (r.kind === "truncated") truncated++; judge(r, runs.length); };

  if (ex.random !== undefined) {
    const horizon = base.steps.length;
    for (let i = 0; i < ex.random; i++) {
      const rng = mulberry32((ex.seed + Math.imul(i + 1, 0x9E3779B1)) | 0);
      const r = runOnce(program, checked, ex, pctChooser(rng, horizon, 3), []);
      r.schedule = r.cps.map(c => c.chosen);
      runs.push(r); note(r);
    }
  } else {
    // Depth-first over choice sequences. A run reached through `prefix` owns the choice points past it; each gets
    // one new prefix per alternative, unless the alternative's next step is independent of what ran instead.
    const stack: number[][] = [];
    const expand = (r: Run, from: number) => {
      const adds: number[][] = [];
      for (let k = from; k < r.cps.length; k++) {
        const cp = r.cps[k]!;
        for (let alt = 1; alt < cp.ready.length; alt++) {
          if (alt === cp.chosen) continue;
          if (independent(r, cp, cp.ready[alt]!) === true) { pruned++; continue; }
          adds.push([...r.cps.slice(0, k).map(c => c.chosen), alt]);
        }
      }
      for (let i = adds.length - 1; i >= 0; i--) stack.push(adds[i]!);
    };
    expand(base, 0);
    while (stack.length && runs.length < ex.maxSchedules) {
      const prefix = stack.pop()!;
      const r = runOnce(program, checked, ex, prefixChooser(prefix), prefix);
      r.schedule = r.cps.map(c => c.chosen);
      runs.push(r); note(r);
      expand(r, prefix.length);
    }
    leftover = stack.length;
  }

  const out: string[] = [];
  const mode = ex.random !== undefined ? `random, seed ${ex.seed}` : `exhaustive DFS up to ${ex.maxSchedules}`;
  out.push(`explore: ${runs.length} schedule${runs.length === 1 ? "" : "s"} (${mode}), ${outcomes.size} distinct outcome${outcomes.size === 1 ? "" : "s"}`
    + (ex.random === undefined ? `, ${pruned} choice${pruned === 1 ? "" : "s"} skipped as independent` : ""));
  if (leftover > 0) out.push(`explore: stopped at --max-schedules with ${leftover} schedule${leftover === 1 ? "" : "s"} left unexplored`);
  if (truncated) out.push(`explore: ${truncated} run${truncated === 1 ? " was" : "s were"} cut (over ${MAX_STEPS} scheduling steps, or one step making over ${MAX_ACCESSES} shared accesses: a spin-wait)`);
  let failures = 0;
  const order: FailureKind[] = ["deadlock", "panic", "assert", "contract", "stuck", "nondeterministic-output"];
  const shown: Finding[] = [];
  for (const kind of order) {
    const f = findings.get(kind);
    if (!f) continue;
    if (kind === "nondeterministic-output" && ex.allowNondeterministicOutput) { out.push("explore: stdout differs between schedules (allowed by --allow-nondeterministic-output)"); continue; }
    failures++;
    shown.push(f);
    const sched = trimmed(f.run.schedule);
    out.push("");
    out.push(`FAIL ${kind}${f.index === 1 ? " (in the default schedule)" : ""}: ${kind === "nondeterministic-output" ? "stdout differs from the default schedule (not always a bug)" : f.run.detail}`);
    if (kind === "nondeterministic-output") {
      out.push(`  default stdout: ${JSON.stringify(base.stdout)}`);
      out.push(`  this stdout:    ${JSON.stringify(f.run.stdout)}`);
    }
    out.push(`  schedule: ${sched.length ? sched.join(",") : "(default)"}`);
    out.push("  trace (task, where it stopped; * = choice point, chosen of ready):");
    const steps = f.run.steps;
    const CAP = 40;
    steps.slice(0, CAP).forEach((s, i) => {
      const cp = s.cp >= 0 ? f.run.cps[s.cp]! : null;
      out.push(`    ${String(i + 1).padStart(3)}  task ${s.task}${cp ? `  * ${cp.chosen} of [${cp.ready.join(",")}]` : ""}${s.stop ? `  stopped at ${s.stop}` : ""}`);
    });
    if (steps.length > CAP) out.push(`    ... ${steps.length - CAP} more steps`);
    out.push(`  replay: milo interp ${file}${sched.length ? ` --schedule ${sched.join(",")}` : ""}`);
  }
  if (failures === 0) out.push("explore: no deadlock, panic, assertion failure or output difference found");
  return { text: out.join("\n"), failures, findings: shown, schedules: runs.length };
}
