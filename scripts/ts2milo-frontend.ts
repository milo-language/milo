// The self-host meter: generate the whole Milo frontend from src/*.ts (ts2milo --lenient, so
// what does not translate yet becomes a stub that names itself), compile-check every generated
// file, and print one number: compile errors left. Stubs compile, so this reaches 0 before
// everything is translated; after that the number that matters is which stub a real program
// hits first (--run).
//   bun scripts/ts2milo-frontend.ts            regenerate + check: errors per file and total
//   bun scripts/ts2milo-frontend.ts --top 15   also the most common error messages
//   bun scripts/ts2milo-frontend.ts --run <file.milo>   build the generated frontend and run it
//                                                        on one program (needs 0 errors)
import { readdirSync } from "fs";
import { join } from "path";
import { frontendFiles } from "./ts-portable";
import { transpile } from "./ts2milo";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "out", "ts2milo-all");
const argv = process.argv.slice(2);
const top = argv.includes("--top") ? Number(argv[argv.indexOf("--top") + 1]) : 0;

const files = ["src/ast.ts", ...frontendFiles().filter((f) => f !== "src/ast.ts")];
const r = transpile(files, { astRoots: ["Program"], lenient: true });
await Bun.$`rm -rf ${OUT}`.quiet();
for (const [name, text] of r.files) await Bun.write(join(OUT, name), text);
const stubbed = new Set(r.stubs.map((s) => s.file + "::" + s.name));
const translated = r.functions.filter((f) => !stubbed.has(f.file + "::" + f.name) && !stubbed.has(f.file + "::" + f.name.split(".").pop())).length;

// `milo check` on one file follows its imports, so an error in a shared file shows up under
// every importer: errors are counted by (file, line, message) across all runs.
const seen = new Map<string, string>();
const firstOf = new Map<string, string>();
const gen = readdirSync(OUT).filter((f) => f.endsWith(".milo")).sort();
await Promise.all(gen.map(async (f) => {
  const p = Bun.spawn(["bun", join(ROOT, "src/main.ts"), "check", join(OUT, f), "--json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  try {
    const j = JSON.parse(text) as { diagnostics: { severity: string; message: string; file?: string; line?: number }[] };
    for (const d of j.diagnostics) if (d.severity === "error") {
      const where = (d.file ?? f).replace(/.*\//, "");
      seen.set(`${where}:${d.line}:${d.message}`, d.message);
      if (!firstOf.has(where)) firstOf.set(where, `${d.line}: ${d.message.slice(0, 100)}`);
    }
  } catch {
    seen.set(`${f}:?:no json`, "check produced no JSON (crash?)");
  }
}));
const perFile = new Map<string, number>();
for (const k of seen.keys()) { const f = k.split(":")[0]; perFile.set(f, (perFile.get(f) ?? 0) + 1); }
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${f}   first: ${firstOf.get(f) ?? ""}`);
console.log(`translated ${translated} of ${r.functions.length} functions, ${r.stubs.length} stubs`);
console.log(`COMPILE ERRORS: ${seen.size}`);
if (top) {
  const byMsg = new Map<string, number>();
  for (const m of seen.values()) { const k = m.replace(/'[^']*'/g, "_").slice(0, 90); byMsg.set(k, (byMsg.get(k) ?? 0) + 1); }
  for (const [m, n] of [...byMsg].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(n).padStart(5)}  ${m}`);
}
if (argv.includes("--run")) {
  // Builds only what the driver imports, so a stage that compiles can run before the whole tree does.
  const prog = argv[argv.indexOf("--run") + 1];
  await Bun.write(join(OUT, "frontend-driver.milo"), Bun.file(join(ROOT, "scripts/ts2milo/frontend-driver.milo")));
  const bin = join(OUT, "frontend");
  const b = Bun.spawnSync(["bun", join(ROOT, "src/main.ts"), "build", join(OUT, "frontend-driver.milo"), "-o", bin], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode) { console.error("build failed:\n" + b.stderr.toString().split("\n").filter((l) => /error/.test(l)).slice(0, 8).join("\n")); process.exit(1); }
  const run = Bun.spawnSync([bin, prog], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  process.exit(run.exitCode ?? 1);
}
