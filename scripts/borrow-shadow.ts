// Shadow gate for src/borrow-flow.ts: the checker's borrow walk against the dataflow, per corpus program.
//
// Runs the checker over tests/errors and tests/fixtures (the programs scripts/checker-diag-snapshot.ts
// covers), then borrowFlow on the same CheckResult, and compares the (message, span) of the in-scope
// borrow errors. Each difference is judged by running the program in the interpreter: a program that
// gets stuck on E-BORROW has a real borrow bug, one that runs clean has none.
//   bun scripts/borrow-shadow.ts [--list] [--jobs N] [--only <substr>]
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { cpus, tmpdir } from "os";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const jobs = Number(opt("--jobs") ?? Math.max(1, cpus().length - 2));
const only = opt("--only");
const list = args.includes("--list");

// The in-scope message templates, in the order the table prints them.
const TEMPLATES: [string, RegExp][] = [
  ["call vs view", /^cannot call '.+' on '.+' while '[^']+' borrows .+$/],
  ["call vs loop", /^cannot call '.+' on '.+' while a loop iterates over .+$/],
  ["assign vs view", /^cannot assign to '.+' while '[^']+' borrows .+$/],
  ["assign vs loop", /^cannot assign to '.+' while a loop iterates over .+$/],
  ["elem assign vs loop", /^cannot assign to '.+' because '.+' is being iterated$/],
  ["pass/swap/replace vs view/loop", /^cannot (pass|swap|replace) '[^']+' while ('[^']+' borrows .+|a loop iterates over .+)$/],
  ["holder-less (it is borrowed)", /^cannot .+ because (it|'[^']+') is borrowed$/],
  ["move vs view", /^cannot move '[^']+' while '[^']+' borrows .+$/],
  ["move vs loop", /^cannot move '[^']+' while a loop iterates over .+$/],
  ["call vs pointer", /^'.+' may reallocate here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["assign vs pointer", /^'.+' is reassigned here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["closure write vs view/loop", /^cannot write to .[^.]+. by (calling|passing) .[^.]+. while (.[^.]+. borrows .+|a loop iterates over .+)$/],
  ["closure write vs pointer", /^.+. is written by (calling|passing) .[^.]+. while .[^.]+. still points into its buffer \\(from .+ on line \\d+\\)$/],
  ["elem write vs pointer", /^'.+' is written here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
];
const templateOf = (m: string): string | null => TEMPLATES.find(([, re]) => re.test(m))?.[0] ?? null;

interface Err { at: string; message: string }
interface Result { walk: Err[]; flow: Err[] }

async function load(path: string) {
  const { Lexer } = await import(join(ROOT, "src/lexer.ts"));
  const { Parser } = await import(join(ROOT, "src/parser.ts"));
  const { resolveImports } = await import(join(ROOT, "src/resolver.ts"));
  const { TypeChecker } = await import(join(ROOT, "src/checker.ts"));
  const { getHostTarget } = await import(join(ROOT, "src/target.ts"));
  const src = readFileSync(path, "utf-8");
  const program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dirname(path), getHostTarget(), path);
  const tc = new TypeChecker();
  const cr = tc.check(program);
  return { program, tc, cr };
}

const at = (s: { file?: string; line?: number; col?: number } | undefined) => `${(s?.file ?? "").replace(ROOT + "/", "")}:${s?.line}:${s?.col}`;

// Judge child: run one program in the interpreter, print the verdict on the last line.
if (args[0] === "--judge") {
  const { Interp } = await import(join(ROOT, "src/interp.ts"));
  const { InterpStuck } = await import(join(ROOT, "src/interp-values.ts"));
  let verdict = "ran";
  try {
    const { program, cr } = await load(args[1]!);
    try { new Interp(program, cr).run(); } catch (e) { verdict = e instanceof InterpStuck ? `stuck:${(e as { rule: string }).rule}` : `error:${(e as Error).message?.slice(0, 60)}`; }
  } catch (e) { verdict = `error:${(e as Error).message?.slice(0, 60)}`; }
  console.log(`\n@@verdict ${verdict}`);
  process.exit(0);
}

let files: string[] = [];
for (const dir of ["tests/errors", "tests/fixtures"]) {
  for (const f of readdirSync(join(ROOT, dir)).sort()) if (f.endsWith(".milo")) files.push(`${dir}/${f}`);
}
if (only) files = files.filter(f => f.includes(only));

const shard = opt("--shard");
if (shard) {
  const [k, n] = shard.split("/").map(Number) as [number, number];
  const { borrowFlow } = await import(join(ROOT, "src/borrow-flow.ts"));
  const out: Record<string, Result> = {};
  for (const f of files.filter((_, i) => i % n === k)) {
    try {
      const { program, tc, cr } = await load(join(ROOT, f));
      const walk = cr.diagnostics.filter((d: any) => d.severity === "error" && templateOf(d.message) !== null).map((d: any) => ({ at: at(d.span), message: d.message }));
      const flow = borrowFlow(program, cr, tc).diagnostics.filter((d: any) => templateOf(d.message) !== null).map((d: any) => ({ at: at(d.span), message: d.message }));
      out[f] = { walk, flow };
    } catch { /* a program the front end rejects has no CheckResult: nothing to compare */ }
  }
  writeFileSync(opt("--out")!, JSON.stringify(out));
  process.exit(0);
}

const merged: Record<string, Result> = {};
await Promise.all(Array.from({ length: jobs }, async (_, k) => {
  const tmp = join(tmpdir(), `borrow-shadow-${process.pid}-${k}.json`);
  const p = Bun.spawn(["bun", import.meta.path, ...(only ? ["--only", only] : []), "--shard", `${k}/${jobs}`, "--out", tmp], { stdout: "inherit", stderr: "inherit" });
  if (await p.exited !== 0) throw new Error(`shard ${k} failed`);
  Object.assign(merged, JSON.parse(readFileSync(tmp, "utf-8")));
  unlinkSync(tmp);
}));

const key = (e: Err) => `${e.at} ${e.message}`;
const rows = new Map<string, { both: number; walkOnly: number; flowOnly: number }>(TEMPLATES.map(([n]) => [n, { both: 0, walkOnly: 0, flowOnly: 0 }]));
const diffs: { file: string; side: "walk-only" | "flow-only"; err: Err }[] = [];
let agree = 0, walkOnly = 0, flowOnly = 0;
for (const f of files) {
  const r = merged[f];
  if (!r) continue;
  const w = new Set(r.walk.map(key)), fl = new Set(r.flow.map(key));
  for (const e of r.walk) {
    const row = rows.get(templateOf(e.message)!)!;
    if (fl.has(key(e))) { row.both++; agree++; } else { row.walkOnly++; walkOnly++; diffs.push({ file: f, side: "walk-only", err: e }); }
  }
  for (const e of r.flow) if (!w.has(key(e))) { rows.get(templateOf(e.message) ?? TEMPLATES[0]![0])!.flowOnly++; flowOnly++; diffs.push({ file: f, side: "flow-only", err: e }); }
}

console.log(`${"template".padEnd(22)} ${"both".padStart(5)} ${"walk-only".padStart(10)} ${"flow-only".padStart(10)}`);
for (const [name, r] of rows) console.log(`${name.padEnd(22)} ${String(r.both).padStart(5)} ${String(r.walkOnly).padStart(10)} ${String(r.flowOnly).padStart(10)}`);
console.log(`borrow-shadow: ${agree} agree, ${walkOnly} walk-only, ${flowOnly} flow-only (of ${files.length} programs)`);

if (list && diffs.length > 0) {
  // One interpreter run per differing program, in a child with a time limit (a fixture may loop or block).
  const verdicts = new Map<string, string>();
  for (const f of new Set(diffs.map(d => d.file))) {
    const p = Bun.spawn(["bun", import.meta.path, "--judge", join(ROOT, f)], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 30000);
    const text = await new Response(p.stdout).text();
    clearTimeout(timer);
    verdicts.set(f, /@@verdict (.*)$/m.exec(text)?.[1] ?? "timeout");
  }
  for (const d of diffs) {
    const v = verdicts.get(d.file)!;
    const stuck = v.startsWith("stuck:E-BORROW");
    const judged = v === "ran" || v.startsWith("stuck:");
    const verdict = !judged ? `unjudged (${v})`
      : d.side === "walk-only" ? (stuck ? "flow bug: run is stuck on E-BORROW" : `walk false positive? (${v})`)
      : (stuck ? "walk misses a real E-BORROW" : `flow bug: false positive (${v})`);
    console.log(`${d.side.padEnd(9)} ${d.err.at} ${d.err.message}  [${d.file}] => ${verdict}`);
  }
}
// A gate: any difference fails, and so does an agreement count below the floor, so a template regex
// that stops matching cannot pass as "0 differences". Raise MIN_AGREE as slices add templates.
const MIN_AGREE = 56;
if (!args.includes("--only") && (walkOnly + flowOnly > 0 || agree < MIN_AGREE)) {
  console.error(`borrow-shadow: FAIL (${walkOnly + flowOnly} differences, ${agree} agree, floor ${MIN_AGREE})`);
  process.exit(1);
}
