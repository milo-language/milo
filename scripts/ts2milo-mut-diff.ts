// Differential gate for the stage 3 probe (docs/plans/ts2milo.md): the mutability pass of
// src/checker-mutability.ts run from TypeScript and from the Milo that scripts/ts2milo.ts generates
// from it, over every corpus program that type-checks far enough to reach the pass.
//   bun scripts/ts2milo-mut-diff.ts                 full gate; prints `same N / total` and timings
//   bun scripts/ts2milo-mut-diff.ts --limit 200     the first 200 programs only
//   bun scripts/ts2milo-mut-diff.ts --only ts2milo-mut   the programs whose path contains the text
//   bun scripts/ts2milo-mut-diff.ts --reuse         keep the dumps from the last run
//   bun scripts/ts2milo-mut-diff.ts --neuter        break one rule in the generated Milo; must report differences
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { checkProgramFile, corpus } from "./ts2milo/mut-corpus";
import { decoderKeys, dumpInput, findingLine } from "./ts2milo/mut-dump";
import { mutInputOf } from "../src/checker-mutability-host";
import { mutabilityFindings } from "../src/checker-mutability";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "out", "ts2milo-mut");
const DUMPS = join(OUT, "dumps");
const INPUTS = ["src/ast.ts", "src/ast-walk-types.ts", "src/mutability-scan.ts", "src/ast-walk.ts", "src/checker-mutability.ts"];

function run(cmd: string[]): { out: string; code: number } {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 30 });
  return { out: p.stdout.toString() + (p.exitCode ? p.stderr.toString() : ""), code: p.exitCode ?? 1 };
}

async function main() {
  const argv = process.argv.slice(2);
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
  const reuse = argv.includes("--reuse");
  const neuter = argv.includes("--neuter");

  mkdirSync(DUMPS, { recursive: true });
  const gen = run(["bun", "scripts/ts2milo.ts", ...INPUTS, "--ast-root", "MutInput", "-o", OUT]);
  if (gen.code) { console.error(gen.out); process.exit(1); }
  console.log(gen.out.split("\n").slice(0, 1).join("\n"));
  writeFileSync(join(OUT, "mut-driver.milo"), readFileSync(join(ROOT, "scripts/ts2milo/mut-driver.milo")));
  if (neuter) {
    // Drop FieldAccess from the parents an identifier may sit under while only being read: a `&mut`
    // param read as `p.x` then counts as handed out, and its unwritten-mut-param finding disappears.
    const f = join(OUT, "mutability-scan.milo");
    const text = readFileSync(f, "utf8");
    const rule = "(k == NodeKind.FieldAccess)";
    if (!text.includes(rule)) { console.error("neuter: the read-parent rule is not in the generated pass"); process.exit(2); }
    writeFileSync(f, text.replace(rule, "(k == NodeKind.None)"));
  }
  const bin = join(OUT, "mut-driver");
  const b = run(["bun", "src/main.ts", "build", join(OUT, "mut-driver.milo"), "-o", bin]);
  if (b.code) { console.error(b.out); process.exit(1); }

  // Every program goes through the real front end; the pass input is dumped and the pass run in TypeScript.
  // Dumps are a few MB each (the whole merged program), so they are run through the compiled Milo
  // pass a chunk at a time and deleted, one process per chunk so a crash is one program.
  const all = corpus();
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1]! : "";
  const files = all.filter((f) => f.includes(only)).slice(0, limit);
  const keys = decoderKeys(join(OUT, "ast_decode.milo"));
  const skips = new Map<string, number>();
  type Item = { file: string; dump: string; ts: string };
  let pending: Item[] = [];
  let ranN = 0, same = 0, tsFindings = 0, miloFindings = 0, tsMs = 0, miloNs = 0, nodes = 0;
  const byCode = new Map<string, number>();
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
      for (const l of r.ts ? r.ts.split("\n") : []) { tsFindings++; const c = l.split("\t")[0]!; byCode.set(c, (byCode.get(c) ?? 0) + 1); }
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
    const r = checkProgramFile(f);
    if ("skip" in r) {
      const why = r.skip.replace(/:.*/, "");
      skips.set(why, (skips.get(why) ?? 0) + 1);
      continue;
    }
    const input = mutInputOf(r.ok.host, r.ok.program, r.ok.view);
    nodes += input.facts.total;
    const t1 = performance.now();
    const found = mutabilityFindings(input);
    tsMs += performance.now() - t1;
    if (!reuse || !existsSync(dump)) writeFileSync(dump, dumpInput(input, keys));
    pending.push({ file: f, dump, ts: found.map(findingLine).join("\n") });
    ranN++;
    if (pending.length >= CHUNK) flush();
    if (i % 200 === 199) process.stderr.write(`  ${i + 1} / ${files.length} programs\n`);
  }
  flush();
  console.log(`ran ${files.length} programs in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${ranN} reach the pass, ${files.length - ranN} skipped`);
  if (crashed.length) console.log(`milo pass crashed on ${crashed.length} program(s): ${crashed.slice(0, 5).join(", ")}`);
  console.log(`findings: ts ${tsFindings}, milo ${miloFindings} (${[...byCode].map(([c, n]) => `${c} ${n}`).join(", ")})`);
  console.log(`skipped ${files.length - ranN}: ${[...skips].map(([why, n]) => `${n} ${why}`).join("; ")}`);
  console.log(`same ${same} / ${ranN}`);
  // The pass only: inputs already built (TypeScript) or decoded (Milo, which times just the call).
  console.log(`speed: ts pass ${tsMs.toFixed(0)} ms over ${nodes} nodes, milo pass ${(miloNs / 1e6).toFixed(0)} ms`);
  process.exit(same === ranN && !crashed.length && ranN > 0 ? 0 : 1);
}

if (import.meta.main) await main();
