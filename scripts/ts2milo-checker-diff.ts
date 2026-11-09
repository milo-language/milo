// Correctness gate for the GENERATED Milo type checker: run it and the TypeScript checker on the
// same programs and compare the diagnostics.
//   bun scripts/ts2milo-checker-diff.ts [--only <substr>] [--limit N] [--no-build] [--diffs N] [--census N] [--files a.milo,b.milo]
// Builds the generated frontend once (ts2milo-frontend.ts --stub-errors --run), then per program in
// tests/errors/*.milo (must fail) and tests/fixtures/*.milo runs `frontend <file> --check` (lex,
// parse, resolve imports, TypeChecker) and `milo check <file> --json` (TS) and compares the
// diagnostic lists. Compared per diagnostic: severity, message, line, col, in order. NOT compared:
// file (the driver does not print it; a diagnostic in an imported file is therefore compared by
// line/col only), hint, code, notes, fix, len (the generated Diagnostic carries them, the driver does
// not print them yet). Requirements diagnostics (`requirementsDiagnostics`, no span) are kept on the
// TS side, so a program with one differs. A program the generated frontend cannot finish because
// it hit a stub counts as "stub" (reasons tallied), not as a diff. The TS side runs only when the
// generated side finished.
// --census N also tallies the stub reasons over ALL generated checker/resolver functions (static
// scan of out/ts2milo-all), because while the entry points stub every program shows one reason.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const only = opt("--only");
const limit = Number(opt("--limit") ?? 0);
const showDiffs = Number(opt("--diffs") ?? 8);
const census = Number(opt("--census") ?? 10);
const OUT = join(ROOT, "out/ts2milo-all");
const BIN = join(OUT, "frontend");

if (!argv.includes("--no-build")) {
  const b = Bun.spawnSync(["bun", join(ROOT, "scripts/ts2milo-frontend.ts"), "--stub-errors", "--run", "examples/hello.milo"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = b.stdout.toString() + b.stderr.toString();
  if (b.exitCode) { console.error("frontend build failed:\n" + out.split("\n").filter((l) => /error|build failed|backend gap/.test(l) && !/warning/.test(l)).slice(0, 10).join("\n")); process.exit(1); }
  for (const l of out.split("\n")) if (/backend gap/.test(l)) console.log(l);
}

const list = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".milo")).sort().map((f) => join(dir, f));
let programs: string[] = opt("--files")?.split(",") ?? [...list("tests/errors"), ...list("tests/fixtures")];
if (only) programs = programs.filter((p) => p.includes(only));
if (limit) programs = programs.slice(0, limit);

type D = { severity: string; message: string; line?: number; col?: number };
const key = (d: D) => `${d.severity} ${d.line ?? "-"}:${d.col ?? "-"} ${d.message}`;

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o, err: e };
};

let same = 0, stubbed = 0, bothParseReject = 0;
const stubs = new Map<string, number>();
const failures: string[] = [];
const kinds = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
let next = 0;
const one = async (prog: string) => {
  const gen = await run([BIN, prog, "--check"]);
  if (gen.code === 70 || /ts2milo stub:/.test(gen.out + gen.err)) {
    stubbed++;
    const m = /ts2milo stub: ([^\n]*)/.exec(gen.out + gen.err);
    bump(stubs, (m?.[1] ?? "?").replace(/:\d+/g, "").slice(0, 120));
    return;
  }
  const text = gen.out.trim();
  if (text === "PARSE_ERROR" || text === "lex error") {
    // The driver prints no parse-error text; agreement is "TS also rejects the program at parse" (emit-ast fails).
    const ast = await run(["bun", "src/main.ts", "emit-ast", prog]);
    if (ast.code !== 0) { same++; bothParseReject++; return; }
  }
  if (!text.startsWith("{")) { bump(kinds, `generated printed ${text.slice(0, 20) || "nothing"} (exit ${gen.code})`); failures.push(`${prog}: generated printed ${text.slice(0, 40) || gen.err.slice(0, 80)} (exit ${gen.code})`); return; }
  const ts = await run(["bun", "src/main.ts", "check", prog, "--json"]);
  let a: D[], b: D[];
  try {
    a = (JSON.parse(ts.out).diagnostics as D[]).map((d) => ({ severity: d.severity, message: d.message, line: d.line, col: d.col }));
    b = (JSON.parse(text).diagnostics as D[]).map((d) => ({ severity: d.severity, message: d.message, line: d.line, col: d.col }));
  } catch { bump(kinds, "unparseable output"); failures.push(`${prog}: unparseable output: ${(ts.out + gen.out).slice(0, 80)}`); return; }
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] && b[i] && key(a[i]) === key(b[i])) continue;
    bump(kinds, !a[i] ? "generated reports extra" : !b[i] ? "generated misses one" : a[i].message === b[i].message ? "same message, other position/severity" : "different message");
    failures.push(`${prog}: #${i} ts=${a[i] ? key(a[i]).slice(0, 90) : "(none)"} | gen=${b[i] ? key(b[i]).slice(0, 90) : "(none)"}`);
    return;
  }
  same++;
};
await Promise.all(Array.from({ length: 8 }, async () => { while (next < programs.length) await one(programs[next++]); }));

console.log(`same ${same} / ${programs.length}   (${bothParseReject} of them both reject at parse, message not compared; ${stubbed} hit a stub; ${failures.length} differ)`);
for (const f of failures.slice(0, showDiffs)) console.log("  " + f);
if (stubs.size) { console.log("top stubs (first stub each program hits):"); for (const [w, n] of [...stubs].sort((x, y) => y[1] - x[1]).slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${w}`); }
if (kinds.size) { console.log("diff kinds:"); for (const [w, n] of [...kinds].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`  ${String(n).padStart(5)}  ${w}`); }

if (census) {
  // Static: every stub body in the generated resolver and checker files, by reason.
  const reasons = new Map<string, number>();
  for (const f of readdirSync(OUT).filter((f) => /^(resolver|checker.*)\.milo$/.test(f))) {
    for (const m of readFileSync(join(OUT, f), "utf8").matchAll(/eprint\("ts2milo stub: ([^"\n]*(?:\\"[^"\n]*)*)"\)/g)) bump(reasons, m[1].replace(/^src\/[\w.-]+:\d+: /, "").replace(/\\"/g, '"').replace(/\b(a value of type) \w+/, "$1 T").slice(0, 120));
  }
  // The entry chain the driver calls; while any of these stubs, no program reaches a diagnostic.
  const entries = [["resolver.milo", "fn resolveImports("], ["checker.milo", "fn new(): TypeChecker"], ["checker.milo", "fn check("], ["checker.milo", "fn checkProgram("]];
  console.log("entry chain (first stub reason each):");
  for (const [file, head] of entries) {
    const t = readFileSync(join(OUT, file), "utf8"), i = t.indexOf(head);
    const m = i < 0 ? null : /eprint\("ts2milo stub: ([^"\n]*)"\)/.exec(t.slice(i, i + 600));
    console.log(`  ${head.replace(/^fn /, "").replace(/\($/, "")}: ${m ? m[1] : "translated"}`);
  }
  const total =[...reasons.values()].reduce((x, y) => x + y, 0);
  console.log(`census: ${total} stubbed fns in generated resolver + checker files; top reasons:`);
  for (const [w, n] of [...reasons].sort((x, y) => y[1] - x[1]).slice(0, census)) console.log(`  ${String(n).padStart(5)}  ${w}`);
}
