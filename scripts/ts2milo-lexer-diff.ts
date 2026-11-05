// Differential token gate for the ts2milo spike: lex every corpus file with src/lexer.ts and
// with the transpiled Milo lexer (compiled by `milo build`), compare the dumps byte for byte.
//   bun scripts/ts2milo-lexer-diff.ts            full gate; prints `same N / total` and timings
//   bun scripts/ts2milo-lexer-diff.ts --dump-ts  print the TS dump only (for refactor checks)
import { readFileSync, readdirSync, mkdirSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import { Lexer } from "../src/lexer";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "out", "ts2milo");

export function corpus(): string[] {
  const files: string[] = [];
  for (const d of ["tests/fixtures", "tests/errors", "std"]) {
    for (const f of readdirSync(join(ROOT, d)).sort()) if (f.endsWith(".milo")) files.push(`${d}/${f}`);
  }
  return files;
}

function trivia(ts: { kind: string; text: string; line: number }[] | undefined): string {
  return (ts ?? []).map((t) => `${t.kind}/${t.line}/${JSON.stringify(t.text)}`).join(",");
}

// One line per token: kind, value, line, col, raw, leading and trailing trivia.
export function dumpTs(files: string[]): string {
  let out = "";
  for (const f of files) {
    out += `== ${f}\n`;
    const src = readFileSync(join(ROOT, f), "utf8");
    try {
      for (const t of new Lexer(src).tokenize()) {
        const raw = t.raw === undefined ? "-" : JSON.stringify(t.raw);
        out += `${t.kind}\t${JSON.stringify(t.value)}\t${t.line}\t${t.col}\t${raw}\t${trivia(t.leadingTrivia)}\t${trivia(t.trailingTrivia)}\n`;
      }
    } catch (e) {
      out += `ERROR\t${(e as Error).message}\n`;
    }
  }
  return out;
}

function splitDump(d: string): Map<string, string> {
  const m = new Map<string, string>();
  let cur = "";
  let name = "";
  for (const line of d.split("\n")) {
    if (line.startsWith("== ")) {
      if (name) m.set(name, cur);
      name = line.slice(3);
      cur = "";
    } else cur += line + "\n";
  }
  if (name) m.set(name, cur);
  return m;
}

function run(cmd: string[], opts: { cwd?: string } = {}): { out: string; code: number } {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? ROOT, stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 30 });
  return { out: p.stdout.toString() + (p.exitCode ? p.stderr.toString() : ""), code: p.exitCode ?? 1 };
}

async function main() {
  const files = corpus();
  if (process.argv.includes("--dump-ts")) {
    process.stdout.write(dumpTs(files));
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const gen = run(["bun", "scripts/ts2milo.ts", "src/tokens.ts", "src/lexer.ts", "-o", OUT]);
  if (gen.code) { console.error(gen.out); process.exit(1); }
  console.log(gen.out.trim());
  copyFileSync(join(ROOT, "scripts/ts2milo/lexer-driver.milo"), join(OUT, "lexer-driver.milo"));
  const bin = join(OUT, "lexer-driver");
  const b = run(["bun", "src/main.ts", "build", join(OUT, "lexer-driver.milo"), "-o", bin]);
  if (b.code) { console.error(b.out); process.exit(1); }

  const tsDump = dumpTs(files);
  const list = join(OUT, "files.txt");
  await Bun.write(list, files.map((f) => join(ROOT, f)).join("\n") + "\n");
  const m = run([bin, list]);
  const miloDump = m.out.split(ROOT + "/").join("");
  const a = splitDump(tsDump), c = splitDump(miloDump);
  let same = 0;
  const diffs: string[] = [];
  for (const f of files) {
    if (a.get(f) === c.get(f)) same++;
    else diffs.push(f);
  }
  for (const f of diffs.slice(0, 8)) {
    const x = (a.get(f) ?? "<missing>").split("\n"), y = (c.get(f) ?? "<missing>").split("\n");
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    console.log(`DIFF ${f} line ${i + 1}\n  ts:   ${x[i]}\n  milo: ${y[i]}`);
  }
  console.log(`same ${same} / ${files.length}`);

  // Speed: one process each, lexing only (files already read, nothing printed).
  const srcs = files.map((f) => readFileSync(join(ROOT, f), "utf8"));
  const t0 = performance.now();
  let n = 0;
  for (const s of srcs) { try { n += new Lexer(s).tokenize().length; } catch {} }
  const tsMs = performance.now() - t0;
  const bm = run([bin, "--bench", list]);
  console.log(`speed: ts lexer ${tsMs.toFixed(0)} ms (${n} tokens), milo lexer ${bm.out.trim()}`);
  process.exit(same === files.length ? 0 : 1);
}

if (import.meta.main) await main();
