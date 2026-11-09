// The shared body of the ts2milo-<pass>-diff.ts gates: generate one checker pass in Milo, build its
// driver, then run the pass from TypeScript and from the generated Milo over the input the checker
// builds for every corpus program that reaches it, and compare the findings line by line.
// Each gate script is a spec (which pass, how to capture its input, which rule --neuter breaks).
//   bun scripts/ts2milo-<pass>-diff.ts                 full gate; prints `same N / total` and timings
//   bun scripts/ts2milo-<pass>-diff.ts --limit 200     the first 200 programs only
//   bun scripts/ts2milo-<pass>-diff.ts --only tests/errors   the programs whose path contains the text
//   bun scripts/ts2milo-<pass>-diff.ts --reuse         keep the dumps from the last run
//   bun scripts/ts2milo-<pass>-diff.ts --neuter        break one rule in the generated Milo; must report differences
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Span } from "../../src/ast";
import { checkProgramFile, corpus } from "./mut-corpus";
import { decoderKeys, stringifyKeyed } from "./mut-dump";

const ROOT = resolve(import.meta.dir, "../..");
// Every pass is generated together with the AST, the walker types and the mutability scan.
const COMMON_INPUTS = ["src/ast.ts", "src/ast-walk-types.ts", "src/mutability-scan.ts"];

export interface PassFinding { span?: Span; message: string; hint: string }

export interface PassDiffSpec<I, F extends PassFinding> {
  // Names out/ts2milo-<name>, scripts/ts2milo/<name>-driver.milo and the generated checker-<name>.milo.
  name: string;
  // The pass's own sources, generated after COMMON_INPUTS.
  inputs: string[];
  astRoot: string;
  // The checker host's test hook: it calls back with each input the pass is about to run on.
  setCapture: (f: ((input: I) => void) | undefined) => void;
  findings: (input: I) => F[];
  // How much work one input is, for the speed line.
  size: (input: I) => number;
  unit: string;
  // --neuter: `find` in the generated pass becomes `put`, which must make findings differ.
  neuter: { what: string; find: string; put: string };
}

function run(cmd: string[]): { out: string; code: number } {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 30 });
  return { out: p.stdout.toString() + (p.exitCode ? p.stderr.toString() : ""), code: p.exitCode ?? 1 };
}

// One line per finding, identical on both sides: where, message, hint.
function findingLine(f: PassFinding): string {
  const s = f.span;
  return `${s?.file}:${s?.line}:${s?.col}\t${f.message}\t${f.hint}`;
}

// A spec with its input and finding types erased, so specs of different passes fit one list.
export type AnyPassDiffSpec = PassDiffSpec<any, any>;
export function passSpec<I, F extends PassFinding>(spec: PassDiffSpec<I, F>): AnyPassDiffSpec { return spec; }

type Item = { file: string; dump: string; ts: string };
const CHUNK = 100;

// One pass's side of a run: its built driver and what the comparison has counted so far.
class PassRun {
  out: string; dumps: string; bin = ""; keys = new Set<string>();
  pending: Item[] = [];
  skips = new Map<string, number>();
  diffs: string[] = [];
  crashed: string[] = [];
  ranN = 0; same = 0; withFindings = 0; tsFindings = 0; miloFindings = 0; tsMs = 0; miloNs = 0; work = 0;
  inputs: unknown[] = [];
  constructor(readonly spec: AnyPassDiffSpec, readonly reuse: boolean) {
    this.out = join(ROOT, "out", `ts2milo-${spec.name}`);
    this.dumps = join(this.out, "dumps");
  }

  // Generates the pass and builds its driver; false (after printing why) when either step fails.
  build(neuter: boolean): boolean {
    const { spec } = this;
    const driver = `${spec.name}-driver`;
    mkdirSync(this.dumps, { recursive: true });
    const gen = run(["bun", "scripts/ts2milo.ts", ...COMMON_INPUTS, ...spec.inputs, "--ast-root", spec.astRoot, "-o", this.out]);
    if (gen.code) { console.error(gen.out); return false; }
    console.log(gen.out.split("\n").slice(0, 1).join("\n"));
    writeFileSync(join(this.out, `${driver}.milo`), readFileSync(join(ROOT, "scripts/ts2milo", `${driver}.milo`)));
    if (neuter) {
      const f = join(this.out, `checker-${spec.name}.milo`);
      const text = readFileSync(f, "utf8");
      if (!text.includes(spec.neuter.find)) { console.error(`neuter: the ${spec.neuter.what} is not in the generated pass`); process.exit(2); }
      writeFileSync(f, text.replace(spec.neuter.find, () => spec.neuter.put));
    }
    this.bin = join(this.out, driver);
    const b = run(["bun", "src/main.ts", "build", join(this.out, `${driver}.milo`), "-o", this.bin]);
    if (b.code) { console.error(b.out); return false; }
    this.keys = decoderKeys(join(this.out, "ast_decode.milo"));
    return true;
  }

  skip(why: string): void { this.skips.set(why, (this.skips.get(why) ?? 0) + 1); }

  // The whole-program pass runs once per check; the last captured input is the one for this program.
  program(file: string, i: number): void {
    const input = this.inputs[this.inputs.length - 1];
    this.inputs = [];
    if (input === undefined) { this.skip("pass input not captured"); return; }
    const dump = join(this.dumps, `${i}.json`);
    this.work += this.spec.size(input);
    const t1 = performance.now();
    const found: PassFinding[] = this.spec.findings(input);
    this.tsMs += performance.now() - t1;
    if (!this.reuse || !existsSync(dump)) writeFileSync(dump, stringifyKeyed(input, this.keys));
    this.pending.push({ file, dump, ts: found.map(findingLine).join("\n") });
    this.ranN++;
    if (this.pending.length >= CHUNK) this.flush();
  }

  private runList(items: Item[]): { out: string; ok: boolean } {
    const list = join(this.out, "files.txt");
    writeFileSync(list, items.map((x) => x.dump).join("\n") + "\n");
    const m = run([this.bin, list]);
    return { out: m.out, ok: m.code === 0 };
  }

  private compare(items: Item[], out: string): void {
    const miloOf = new Map<string, string>();
    let name = "", cur: string[] = [];
    const flushBlock = () => { if (name) miloOf.set(name, cur.join("\n")); };
    for (const line of out.split("\n")) {
      if (line.startsWith("#pass-ns ")) this.miloNs += Number(line.slice(9));
      else if (line.startsWith("== ")) { flushBlock(); name = line.slice(3); cur = []; } else if (line.length) cur.push(line);
    }
    flushBlock();
    for (const r of items) {
      const m = miloOf.get(r.dump);
      if (r.ts) { this.withFindings++; this.tsFindings += r.ts.split("\n").length; }
      if (m !== undefined && m) this.miloFindings += m.split("\n").length;
      if (m !== undefined && m === r.ts) this.same++;
      else {
        this.diffs.push(r.file);
        if (this.diffs.length <= 6) {
          const a = r.ts.split("\n"), c = (m ?? "<no output>").split("\n");
          let i = 0;
          while (i < a.length && a[i] === c[i]) i++;
          console.log(`DIFF ${r.file} line ${i + 1}\n  ts:   ${a[i]}\n  milo: ${c[i]}`);
        }
      }
    }
  }

  // Dumps are run through the compiled Milo pass a chunk at a time and deleted, one process per
  // chunk so a crash is one program.
  flush(): void {
    if (!this.pending.length) return;
    const first = this.runList(this.pending);
    if (first.ok) this.compare(this.pending, first.out);
    else for (const one of this.pending) {
      const o = this.runList([one]);
      if (o.ok) this.compare([one], o.out); else { this.crashed.push(one.file); this.diffs.push(one.file); }
    }
    if (!this.reuse) for (const p of this.pending) rmSync(p.dump, { force: true });
    this.pending = [];
  }

  // A run where no program reached the pass proves nothing, so it is red.
  report(files: number, seconds: number): boolean {
    console.log(`ran ${files} programs in ${seconds.toFixed(0)} s: ${this.ranN} reach the pass, ${files - this.ranN} skipped`);
    if (this.crashed.length) console.log(`milo pass crashed on ${this.crashed.length} program(s): ${this.crashed.slice(0, 5).join(", ")}`);
    console.log(`findings: ts ${this.tsFindings}, milo ${this.miloFindings}; programs with at least one finding: ${this.withFindings}`);
    console.log(`skipped ${files - this.ranN}: ${[...this.skips].map(([why, n]) => `${n} ${why}`).join("; ")}`);
    console.log(`same ${this.same} / ${this.ranN}`);
    console.log(`speed: ts pass ${this.tsMs.toFixed(0)} ms over ${this.work} ${this.spec.unit}, milo pass ${(this.miloNs / 1e6).toFixed(0)} ms`);
    return this.same === this.ranN && !this.crashed.length && this.ranN > 0;
  }
}

export function runPassDiff(spec: AnyPassDiffSpec): never { return runPassDiffs([spec]); }

// Every given pass over one walk of the corpus: each program is parsed and checked once, and each
// pass compares the input it captured during that check. A pass that does not build is red and
// the others still run.
export function runPassDiffs(specs: AnyPassDiffSpec[]): never {
  const argv = process.argv.slice(2);
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]! : "";
  const many = specs.length > 1;
  const runs: PassRun[] = [];
  const unbuilt: string[] = [];
  for (const spec of specs) {
    if (many) console.log(`== ${spec.name}: build`);
    const r = new PassRun(spec, argv.includes("--reuse"));
    if (r.build(argv.includes("--neuter"))) runs.push(r); else unbuilt.push(spec.name);
  }

  const files = corpus().filter((f) => f.includes(only)).slice(0, limit);
  const t0 = performance.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    for (const r of runs) r.spec.setCapture((x: unknown) => r.inputs.push(x));
    let checked: ReturnType<typeof checkProgramFile>;
    try { checked = checkProgramFile(f); } finally { for (const r of runs) r.spec.setCapture(undefined); }
    if ("skip" in checked) {
      const why = checked.skip.replace(/:.*/, "");
      for (const r of runs) { r.inputs = []; r.skip(why); }
      continue;
    }
    for (const r of runs) r.program(f, i);
    if (i % 200 === 199) process.stderr.write(`  ${i + 1} / ${files.length} programs\n`);
  }
  const seconds = (performance.now() - t0) / 1000;
  const red = [...unbuilt];
  for (const r of runs) {
    r.flush();
    if (many) console.log(`== ${r.spec.name}`);
    if (!r.report(files.length, seconds)) red.push(r.spec.name);
  }
  if (many) console.log(red.length ? `RED ${red.length} / ${specs.length}: ${red.join(", ")}` : `all ${specs.length} passes agree`);
  process.exit(red.length ? 1 : 0);
}
