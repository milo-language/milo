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

export async function runPassDiff<I, F extends PassFinding>(spec: PassDiffSpec<I, F>): Promise<never> {
  const argv = process.argv.slice(2);
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
  const reuse = argv.includes("--reuse");
  const neuter = argv.includes("--neuter");
  const OUT = join(ROOT, "out", `ts2milo-${spec.name}`);
  const DUMPS = join(OUT, "dumps");
  const driver = `${spec.name}-driver`;

  mkdirSync(DUMPS, { recursive: true });
  const gen = run(["bun", "scripts/ts2milo.ts", ...COMMON_INPUTS, ...spec.inputs, "--ast-root", spec.astRoot, "-o", OUT]);
  if (gen.code) { console.error(gen.out); process.exit(1); }
  console.log(gen.out.split("\n").slice(0, 1).join("\n"));
  writeFileSync(join(OUT, `${driver}.milo`), readFileSync(join(ROOT, "scripts/ts2milo", `${driver}.milo`)));
  if (neuter) {
    const f = join(OUT, `checker-${spec.name}.milo`);
    const text = readFileSync(f, "utf8");
    if (!text.includes(spec.neuter.find)) { console.error(`neuter: the ${spec.neuter.what} is not in the generated pass`); process.exit(2); }
    writeFileSync(f, text.replace(spec.neuter.find, () => spec.neuter.put));
  }
  const bin = join(OUT, driver);
  const b = run(["bun", "src/main.ts", "build", join(OUT, `${driver}.milo`), "-o", bin]);
  if (b.code) { console.error(b.out); process.exit(1); }

  // Dumps are run through the compiled Milo pass a chunk at a time and deleted, one process per
  // chunk so a crash is one program.
  const all = corpus();
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]! : "";
  const files = all.filter((f) => f.includes(only)).slice(0, limit);
  const keys = decoderKeys(join(OUT, "ast_decode.milo"));
  const skips = new Map<string, number>();
  type Item = { file: string; dump: string; ts: string };
  let pending: Item[] = [];
  let ranN = 0, same = 0, withFindings = 0, tsFindings = 0, miloFindings = 0, tsMs = 0, miloNs = 0, work = 0;
  const diffs: string[] = [];
  const crashed: string[] = [];
  const CHUNK = 100;

  const runList = (items: Item[]): { out: string; ok: boolean } => {
    const list = join(OUT, "files.txt");
    writeFileSync(list, items.map((x) => x.dump).join("\n") + "\n");
    const m = run([bin, list]);
    return { out: m.out, ok: m.code === 0 };
  };
  const compare = (items: Item[], out: string) => {
    const miloOf = new Map<string, string>();
    let name = "", cur: string[] = [];
    const flushBlock = () => { if (name) miloOf.set(name, cur.join("\n")); };
    for (const line of out.split("\n")) {
      if (line.startsWith("#pass-ns ")) miloNs += Number(line.slice(9));
      else if (line.startsWith("== ")) { flushBlock(); name = line.slice(3); cur = []; } else if (line.length) cur.push(line);
    }
    flushBlock();
    for (const r of items) {
      const m = miloOf.get(r.dump);
      if (r.ts) { withFindings++; tsFindings += r.ts.split("\n").length; }
      if (m !== undefined && m) miloFindings += m.split("\n").length;
      if (m !== undefined && m === r.ts) same++;
      else {
        diffs.push(r.file);
        if (diffs.length <= 6) {
          const a = r.ts.split("\n"), c = (m ?? "<no output>").split("\n");
          let i = 0;
          while (i < a.length && a[i] === c[i]) i++;
          console.log(`DIFF ${r.file} line ${i + 1}\n  ts:   ${a[i]}\n  milo: ${c[i]}`);
        }
      }
    }
  };
  const flush = () => {
    if (!pending.length) return;
    const first = runList(pending);
    if (first.ok) compare(pending, first.out);
    else for (const one of pending) {
      const o = runList([one]);
      if (o.ok) compare([one], o.out); else { crashed.push(one.file); diffs.push(one.file); }
    }
    if (!reuse) for (const p of pending) rmSync(p.dump, { force: true });
    pending = [];
  };

  const t0 = performance.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const dump = join(DUMPS, `${i}.json`);
    const inputs: I[] = [];
    spec.setCapture((x) => inputs.push(x));
    let r: ReturnType<typeof checkProgramFile>;
    try { r = checkProgramFile(f); } finally { spec.setCapture(undefined); }
    if ("skip" in r) {
      const why = r.skip.replace(/:.*/, "");
      skips.set(why, (skips.get(why) ?? 0) + 1);
      continue;
    }
    // The whole-program pass runs once per check; the last input is the one for this program.
    const input = inputs[inputs.length - 1];
    if (!input) { skips.set("pass input not captured", (skips.get("pass input not captured") ?? 0) + 1); continue; }
    work += spec.size(input);
    const t1 = performance.now();
    const found = spec.findings(input);
    tsMs += performance.now() - t1;
    if (!reuse || !existsSync(dump)) writeFileSync(dump, stringifyKeyed(input, keys));
    pending.push({ file: f, dump, ts: found.map(findingLine).join("\n") });
    ranN++;
    if (pending.length >= CHUNK) flush();
    if (i % 200 === 199) process.stderr.write(`  ${i + 1} / ${files.length} programs\n`);
  }
  flush();
  console.log(`ran ${files.length} programs in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${ranN} reach the pass, ${files.length - ranN} skipped`);
  if (crashed.length) console.log(`milo pass crashed on ${crashed.length} program(s): ${crashed.slice(0, 5).join(", ")}`);
  console.log(`findings: ts ${tsFindings}, milo ${miloFindings}; programs with at least one finding: ${withFindings}`);
  console.log(`skipped ${files.length - ranN}: ${[...skips].map(([why, n]) => `${n} ${why}`).join("; ")}`);
  console.log(`same ${same} / ${ranN}`);
  console.log(`speed: ts pass ${tsMs.toFixed(0)} ms over ${work} ${spec.unit}, milo pass ${(miloNs / 1e6).toFixed(0)} ms`);
  // A run where no program reached the pass proves nothing, so it is red.
  process.exit(same === ranN && !crashed.length && ranN > 0 ? 0 : 1);
}
