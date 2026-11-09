// Diagnostics oracle for behavior-preserving checker refactors: type-check every
// tests/errors/*.milo and tests/fixtures/*.milo in-process and write every diagnostic
// (severity, code, message, span, len, hint, notes) to one JSON file. Run it before and
// after a move; the two files must be byte-identical.
//   bun scripts/checker-diag-snapshot.ts . <out.json> [--only <substr>] [--limit N] [--jobs N]
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { cpus } from "os";

const args = process.argv.slice(2);
const ROOT = resolve(args[0]!);
const OUT = args[1]!;
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const only = opt("--only");
const limit = Number(opt("--limit") ?? 0);
const jobs = Number(opt("--jobs") ?? Math.max(1, cpus().length - 2));
const shard = opt("--shard"); // internal: "k/n"

let files: string[] = [];
for (const dir of ["tests/errors", "tests/fixtures"]) {
  for (const f of readdirSync(join(ROOT, dir)).sort()) if (f.endsWith(".milo")) files.push(`${dir}/${f}`);
}
if (only) files = files.filter(f => f.includes(only));
if (limit) files = files.slice(0, limit);

if (!shard && jobs > 1 && files.length > jobs) {
  const parts = await Promise.all(Array.from({ length: jobs }, async (_, k) => {
    const tmp = `${OUT}.${k}.part`;
    const p = Bun.spawn(["bun", import.meta.path, ROOT, tmp, "--shard", `${k}/${jobs}`, ...(only ? ["--only", only] : []), ...(limit ? ["--limit", String(limit)] : [])], { stdout: "inherit", stderr: "inherit" });
    if (await p.exited !== 0) throw new Error(`shard ${k} failed`);
    const part = JSON.parse(readFileSync(tmp, "utf-8")) as Record<string, unknown>;
    await Bun.file(tmp).delete();
    return part;
  }));
  const merged: Record<string, unknown> = {};
  for (const f of files) for (const part of parts) if (f in part) merged[f] = part[f];
  writeFileSync(OUT, JSON.stringify(merged, null, 1) + "\n");
  console.log(`${Object.keys(merged).length} programs, ${jobs} jobs -> ${OUT}`);
  process.exit(0);
}

if (shard) { const [k, n] = shard.split("/").map(Number) as [number, number]; files = files.filter((_, i) => i % n === k); }

const { Lexer } = await import(join(ROOT, "src/lexer.ts"));
const { Parser } = await import(join(ROOT, "src/parser.ts"));
const { resolveImports } = await import(join(ROOT, "src/resolver.ts"));
const { TypeChecker } = await import(join(ROOT, "src/checker.ts"));
const { getHostTarget } = await import(join(ROOT, "src/target.ts"));

// Absolute paths differ between two checkouts; everything else must match exactly.
const rel = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).split(ROOT + "/").join(""));
const out: Record<string, unknown> = {};
for (const f of files) {
  const path = join(ROOT, f);
  try {
    const src = readFileSync(path, "utf-8");
    let prog = new Parser(new Lexer(src).tokenize(), src, path).parse();
    prog = resolveImports(prog, dirname(path), getHostTarget(), path);
    out[f] = rel(new TypeChecker().check(prog).diagnostics);
  } catch (e: any) {
    out[f] = rel({ thrown: e?.diagnostic ?? e?.message ?? String(e) });
  }
}
writeFileSync(OUT, JSON.stringify(out, shard ? undefined : null, shard ? undefined : 1) + "\n");
if (!shard) console.log(`${files.length} programs -> ${OUT}`);
