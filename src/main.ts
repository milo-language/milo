import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { basename, resolve, dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker } from "./checker";
import { Codegen } from "./codegen";
import { lower } from "./lower";
import { resolveImports } from "./resolver";
import { formatDiagnostic } from "./diagnostics";
import { type TargetInfo, getHostTarget } from "./target";
import { format, formatFile } from "./formatter";

function compile(source: string, target: TargetInfo, filePath?: string): string {
  const sourceDir = filePath ? dirname(resolve(filePath)) : process.cwd();
  let tokens, program;
  try {
    tokens = new Lexer(source).tokenize();
    program = new Parser(tokens).parse();
    program = resolveImports(program, sourceDir, target);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  const warnings = result.diagnostics.filter(d => d.severity !== "error");
  for (const d of warnings) console.error(formatDiagnostic(d, source, filePath));
  if (errors.length > 0) {
    for (const d of errors) console.error(formatDiagnostic(d, source, filePath));
    process.exit(1);
  }

  const hirModule = lower(program, result, sourceDir);
  return new Codegen(target).generate(hirModule);
}

function compileToIr(sourcePath: string, outputPath: string | null, target: TargetInfo) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath);
  if (outputPath) {
    writeFileSync(outputPath, ir);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(ir);
  }
}

function detectLibs(ir: string, target: TargetInfo): string {
  let libs = "";
  if (ir.includes("@SSL_") || ir.includes("@TLS_client_method")) {
    libs += target.os === "darwin"
      ? " -L/opt/homebrew/opt/openssl@3/lib -lssl -lcrypto"
      : " -lssl -lcrypto";
  }
  if (ir.includes("@sqlite3_")) {
    libs += target.os === "darwin"
      ? " -L/opt/homebrew/opt/sqlite/lib -lsqlite3"
      : " -lsqlite3";
  }
  return libs;
}

function compileToBinary(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = ""): string {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = outputPath ?? join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  try {
    writeFileSync(tmpLl, ir);
    const opt = optFlag ? ` ${optFlag}` : "";
    let libs = detectLibs(ir, target);
    execSync(`clang${opt} ${tmpLl} -o ${out} -Wno-override-module${libs}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    console.error(`error[link]: clang failed:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

function compileSourceToBinary(source: string, sourcePath: string, target: TargetInfo, optFlag: string = ""): string {
  const ir = compile(source, target, sourcePath);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);
  try {
    writeFileSync(tmpLl, ir);
    const opt = optFlag ? ` ${optFlag}` : "";
    const libs = detectLibs(ir, target);
    execSync(`clang${opt} ${tmpLl} -o ${out} -Wno-override-module${libs}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    throw new Error(`clang failed:\n${e.stderr?.toString() ?? e.message}`);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

function runTests(testFiles: string[], target: TargetInfo, optFlag: string) {
  let totalPassed = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  for (const file of testFiles) {
    const source = readFileSync(file, "utf-8");
    const testFnRegex = /^fn\s+(test\w+)\s*\(/gm;
    const testFns: string[] = [];
    let m;
    while ((m = testFnRegex.exec(source)) !== null) testFns.push(m[1]);
    if (testFns.length === 0) continue;

    console.log(`\n${file}`);

    // generate main that calls each test, one at a time
    let mainSrc = "\nfn main(): i32 {\n";
    for (const name of testFns) {
      mainSrc += `    eprint("  ${name} ... ")\n`;
      mainSrc += `    ${name}()\n`;
      mainSrc += `    eprint("ok")\n`;
    }
    mainSrc += "    return 0\n}\n";

    const fullSource = source + mainSrc;
    let bin: string;
    try {
      bin = compileSourceToBinary(fullSource, file, target, optFlag);
    } catch (e: any) {
      console.error(`  compile error: ${e.message}`);
      totalFailed += testFns.length;
      continue;
    }

    try {
      const result = spawnSync(bin, [], { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status === 0) {
        totalPassed += testFns.length;
      } else {
        totalFailed++;
        totalPassed += Math.max(0, testFns.length - 1);
        failures.push(file);
      }
    } finally {
      try { unlinkSync(bin); } catch {}
    }
  }

  console.log(`\nresults: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
  if (totalFailed > 0) {
    console.log("failures:");
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

function runFile(sourcePath: string, extraArgs: string[], target: TargetInfo, optFlag: string = "") {
  const bin = compileToBinary(sourcePath, null, target, optFlag);
  try {
    const result = execSync([bin, ...extraArgs].map(a => `"${a}"`).join(" "), {
      stdio: "inherit",
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
  } finally {
    try { unlinkSync(bin); } catch {}
  }
}

function parseArgs(args: string[]): { output: string | null; source: string | null; rest: string[]; optFlag: string } {
  let output: string | null = null;
  let source: string | null = null;
  let optFlag = "-O2";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
    else if (args[i] === "--debug") { optFlag = "-O0"; }
    else if (args[i] === "-O" && i + 1 < args.length) { optFlag = `-O${args[++i]}`; }
    else if (/^-O[0-3sz]$/.test(args[i])) { optFlag = args[i]; }
    else if (args[i] === "--") { rest.push(...args.slice(i + 1)); break; }
    else if (!source) { source = args[i]; }
    else { rest.push(args[i]); }
  }
  return { output, source, rest, optFlag };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("usage: milo <command> [options] <file>");
    console.log("commands:");
    console.log("  run <file> [args]      compile and run (no artifacts left behind)");
    console.log("  build <file> [-o out]  compile to executable");
    console.log("  test [file...]         run tests (*_test.milo files)");
    console.log("  emit-ir <file>         emit LLVM IR");
    console.log("  fmt <file...>          format source files (-w to write in place)");
    console.log("options:");
    console.log("  --release              optimize (-O3)");
    console.log("  --debug                no optimization (-O0)");
    console.log("  -O<level>              clang opt level: 0,1,2,3,s,z (default: -O2)");
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === "lsp") {
    import("./lsp");
    return;
  }

  if (cmd === "fmt") {
    const fmtArgs = args.slice(1);
    const write = fmtArgs.includes("-w");
    const files = fmtArgs.filter(a => a !== "-w");
    if (files.length === 0) { console.error("error: no files to format"); process.exit(1); }
    const fmtBin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "milo-fmt");
    const useMiloFmt = existsSync(fmtBin);
    let changed = 0;
    for (const f of files) {
      if (useMiloFmt) {
        const result = spawnSync(fmtBin, write ? ["-w", f] : [f], { encoding: "utf-8", timeout: 5000 });
        if (result.status !== 0) { console.error(result.stderr || `error formatting ${f}`); process.exit(1); }
        if (!write) process.stdout.write(result.stdout);
        else if (result.stdout) { console.log(result.stdout.trim()); changed++; }
      } else if (write) {
        const result = formatFile(f, true);
        if (result) { console.log(result); changed++; }
      } else {
        process.stdout.write(format(readFileSync(f, "utf-8")));
      }
    }
    if (write && changed === 0) console.log("all files already formatted");
    return;
  }

  const { output, source, rest, optFlag } = parseArgs(args.slice(1));
  const target = getHostTarget();

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

  if (cmd === "test") {
    const testArgs = args.slice(1);
    const { optFlag: testOpt } = parseArgs(testArgs);
    let files: string[];
    const explicitFiles = testArgs.filter(a => a.endsWith(".milo"));
    if (explicitFiles.length > 0) {
      files = explicitFiles;
    } else {
      const dir = process.cwd();
      files = readdirSync(dir).filter(f => f.endsWith("_test.milo")).map(f => join(dir, f));
    }
    if (files.length === 0) { console.error("no test files found"); process.exit(1); }
    runTests(files, target, testOpt);
    return;
  }

  if (cmd === "run") {
    runFile(source!, rest, target, optFlag);
  } else if (cmd === "build") {
    const bin = compileToBinary(source!, output, target, optFlag);
    console.log(`compiled ${source} -> ${bin}`);
  } else if (cmd === "emit-ir") {
    compileToIr(source!, output, target);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main();
