// Correctness gate for the GENERATED Milo parser: run it and the TypeScript parser on the same
// programs and compare the ASTs.
//   bun scripts/ts2milo-parser-diff.ts [--only <substr>] [--limit N] [--no-build] [--diffs N] [--files a.milo,b.milo]
// Builds the generated frontend once (ts2milo-frontend.ts --stub-errors --run), then per program runs
// `emit-ast` (TS) and `frontend-driver <file> --ast` (generated) and compares normalized JSON:
// null/absent keys are the same, a key one side lacks is ignored when the other side's value is
// empty (a Set/Map the generated AST does not carry), keys sorted, bigint literals ("5n") as decimal
// strings. Spans are dropped on both sides. A program the generated parser cannot finish because it
// hit a stub counts as "stub" (reasons tallied), not as a diff.
import { readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const only = opt("--only");
const limit = Number(opt("--limit") ?? 0);
const showDiffs = Number(opt("--diffs") ?? 8);
const BIN = join(ROOT, "out/ts2milo-all/frontend");

if (!argv.includes("--no-build")) {
  const b = Bun.spawnSync(["bun", join(ROOT, "scripts/ts2milo-frontend.ts"), "--stub-errors", "--run", "examples/hello.milo"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = b.stdout.toString() + b.stderr.toString();
  if (b.exitCode) { console.error("frontend build failed:\n" + out.split("\n").filter((l) => /error|build failed|backend gap/.test(l)).slice(0, 10).join("\n")); process.exit(1); }
  for (const l of out.split("\n")) if (/backend gap/.test(l)) console.log(l);
}

let programs: string[] = opt("--files")?.split(",") ?? readdirSync(join(ROOT, "tests/fixtures")).filter((f) => f.endsWith(".milo")).sort().map((f) => join("tests/fixtures", f));
if (only) programs = programs.filter((p) => p.includes(only));
if (limit) programs = programs.slice(0, limit);

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const norm = (v: any): any => {
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      // The encoder skips every Span-typed field (ast-model.ts), so drop the same set here.
      if (k === "span" || k.endsWith("Span") || k === "id" || v[k] === null || v[k] === undefined) continue;
      o[k] = norm(v[k]);
    }
    return o;
  }
  if (typeof v === "string" && /^-?\d+n$/.test(v)) return v.slice(0, -1);
  return v;
};

type Diff = { path: string; ts: unknown; gen: unknown };
const compare = (a: any, b: any, path: string, out: Diff[]) => {
  if (out.length >= 3) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push({ path: path + ".length", ts: a.length, gen: b.length }); return; }
    a.forEach((x, i) => compare(x, b[i], `${path}[${i}]`, out));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) { if (!isEmpty(b[k])) out.push({ path: `${path}.${k}`, ts: undefined, gen: b[k] }); }
      else if (!(k in b)) { if (!isEmpty(a[k]) && a[k] !== false && k !== "kind") out.push({ path: `${path}.${k}`, ts: a[k], gen: undefined }); }
      else compare(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push({ path, ts: a, gen: b });
};

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o, err: e };
};

let same = 0, tsFail = 0;
const stubs = new Map<string, number>();
let stubbed = 0;
const failures: string[] = [];
const kinds = new Map<string, number>();
let next = 0;
const one = async (prog: string) => {
  const [ts, gen] = await Promise.all([run(["bun", "src/main.ts", "emit-ast", prog]), run([BIN, prog, "--ast"])]);
  const genText = gen.out.trim();
  if (gen.code === 70 || /ts2milo stub:/.test(gen.out + gen.err)) {
    stubbed++;
    const m = /ts2milo stub: ([^\n]*)/.exec(gen.out + gen.err);
    const why = (m?.[1] ?? "?").replace(/:\d+/g, "").slice(0, 110);
    stubs.set(why, (stubs.get(why) ?? 0) + 1);
    return;
  }
  const tsErr = ts.code !== 0;
  const genErr = genText === "PARSE_ERROR";
  if (tsErr || genErr) {
    if (tsErr && genErr) { same++; tsFail++; return; }
    failures.push(`${prog}: ${tsErr ? "TS rejects, generated parses" : "generated rejects, TS parses"}`);
    kinds.set(tsErr ? "gen accepts what TS rejects" : "gen rejects what TS accepts", (kinds.get(tsErr ? "gen accepts what TS rejects" : "gen rejects what TS accepts") ?? 0) + 1);
    return;
  }
  let a: any, b: any;
  try { a = norm(JSON.parse(ts.out)); b = norm(JSON.parse(genText)); } catch (e: any) {
    failures.push(`${prog}: unparseable output (${gen.code}): ${(gen.err || genText).slice(0, 120)}`);
    kinds.set("driver crash/bad json", (kinds.get("driver crash/bad json") ?? 0) + 1);
    return;
  }
  const d: Diff[] = [];
  compare(a, b, "$", d);
  if (!d.length) { same++; return; }
  const k = d[0].path.replace(/\[\d+\]/g, "[]").replace(/^\$\./, "").split(".").slice(-2).join(".");
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
  failures.push(`${prog}: ${d.map((x) => `${x.path}: ts=${JSON.stringify(x.ts)?.slice(0, 60)} gen=${JSON.stringify(x.gen)?.slice(0, 60)}`).join(" | ")}`);
};
await Promise.all(Array.from({ length: 8 }, async () => { while (next < programs.length) await one(programs[next++]); }));

console.log(`same ${same} / ${programs.length}   (${tsFail} of them both reject; ${stubbed} hit a stub; ${failures.length} differ)`);
for (const f of failures.slice(0, showDiffs)) console.log("  " + f);
if (stubs.size) { console.log("top stubs:"); for (const [w, n] of [...stubs].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  ${String(n).padStart(4)}  ${w}`); }
if (kinds.size) { console.log("diff kinds:"); for (const [w, n] of [...kinds].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  ${String(n).padStart(4)}  ${w}`); }
