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
import { CodegenJS } from "./codegen-js";
import { lower } from "./lower";
import { resolveImports } from "./resolver";
import { formatDiagnostic, type WarningConfig } from "./diagnostics";
import { type TargetInfo, getHostTarget } from "./target";
import { format, formatFile } from "./formatter";

function frontendToHIR(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig) {
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

  const result = new TypeChecker(warningConfig).check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  const warnings = result.diagnostics.filter(d => d.severity !== "error");
  for (const d of warnings) console.error(formatDiagnostic(d, source, filePath));
  if (errors.length > 0) {
    for (const d of errors) console.error(formatDiagnostic(d, source, filePath));
    process.exit(1);
  }

  return lower(program, result, sourceDir);
}

function compile(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig): string {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  return new Codegen(target, filePath).generate(hirModule);
}

function compileToJS(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig): string {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  return new CodegenJS().generate(hirModule);
}

function compileToIr(sourcePath: string, outputPath: string | null, target: TargetInfo, warningConfig?: WarningConfig) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig);
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

function compileToBinary(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig): string {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig);
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

function compileSourceToBinary(source: string, sourcePath: string, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig): string {
  const ir = compile(source, target, sourcePath, warningConfig);
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

function runTests(testFiles: string[], target: TargetInfo, optFlag: string, warningConfig?: WarningConfig) {
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
      bin = compileSourceToBinary(fullSource, file, target, optFlag, warningConfig);
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

function runFile(sourcePath: string, extraArgs: string[], target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig) {
  const bin = compileToBinary(sourcePath, null, target, optFlag, warningConfig);
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

function parseArgs(args: string[]): { output: string | null; source: string | null; rest: string[]; optFlag: string; warningConfig: WarningConfig } {
  let output: string | null = null;
  let source: string | null = null;
  let optFlag = "-O2";
  const rest: string[] = [];
  const denied = new Set<string>();
  const allowed = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
    else if (args[i] === "--debug") { optFlag = "-O0"; }
    else if (args[i] === "-O" && i + 1 < args.length) { optFlag = `-O${args[++i]}`; }
    else if (/^-O[0-3sz]$/.test(args[i])) { optFlag = args[i]; }
    else if (args[i] === "--deny-all") { denied.add("*"); }
    else if (args[i].startsWith("--deny=")) { denied.add(args[i].slice(7)); }
    else if (args[i] === "--deny" && i + 1 < args.length) { denied.add(args[++i]); }
    else if (args[i].startsWith("--allow=")) { allowed.add(args[i].slice(8)); }
    else if (args[i] === "--allow" && i + 1 < args.length) { allowed.add(args[++i]); }
    else if (args[i] === "--") { rest.push(...args.slice(i + 1)); break; }
    else if (!source) { source = args[i]; }
    else { rest.push(args[i]); }
  }
  return { output, source, rest, optFlag, warningConfig: { denied, allowed } };
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
    console.log("  emit-js <file>         emit JavaScript (playground target)");
    console.log("  fmt <file...>          format source files (-w to write in place)");
    console.log("options:");
    console.log("  --release              optimize (-O3)");
    console.log("  --debug                no optimization (-O0)");
    console.log("  -O<level>              clang opt level: 0,1,2,3,s,z (default: -O2)");
    console.log("  --deny=<warning>       treat warning as error (e.g. --deny=unused-variable)");
    console.log("  --allow=<warning>      suppress warning (e.g. --allow=unused-result)");
    console.log("  --deny-all             treat all warnings as errors");
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === "lsp") {
    import("./lsp");
    return;
  }

  if (cmd === "lex") {
    const file = args[1];
    if (!file) { console.error("error: no source file"); process.exit(1); }
    const source = readFileSync(file, "utf-8");
    const tokens = new Lexer(source).tokenize();
    function escapeValue(s: string): string {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 10) out += "\\n";
        else if (c === 9) out += "\\t";
        else if (c === 13) out += "\\r";
        else if (c === 0) out += "\\0";
        else if (c < 32 || c === 127) out += `\\x${c.toString(16).padStart(2, "0")}`;
        else out += s[i];
      }
      return out;
    }
    for (const tok of tokens) {
      if (tok.leadingTrivia) {
        for (const t of tok.leadingTrivia) {
          if (t.kind === "blank") console.log(`L_BLANK\t\t${t.line}`);
          else console.log(`L_COMMENT\t${escapeValue(t.text)}\t${t.line}`);
        }
      }
      console.log(`${tok.kind}\t${escapeValue(tok.value)}\t${tok.line}:${tok.col}`);
      if (tok.trailingTrivia) {
        for (const t of tok.trailingTrivia) {
          console.log(`T_COMMENT\t${escapeValue(t.text)}\t${t.line}`);
        }
      }
    }
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

  const { output, source, rest, optFlag, warningConfig } = parseArgs(args.slice(1));
  const target = getHostTarget();

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

  if (cmd === "test") {
    const testArgs = args.slice(1);
    const { optFlag: testOpt, warningConfig: testWc } = parseArgs(testArgs);
    let files: string[];
    const explicitFiles = testArgs.filter(a => a.endsWith(".milo"));
    if (explicitFiles.length > 0) {
      files = explicitFiles;
    } else {
      const dir = process.cwd();
      files = readdirSync(dir).filter(f => f.endsWith("_test.milo")).map(f => join(dir, f));
    }
    if (files.length === 0) { console.error("no test files found"); process.exit(1); }
    runTests(files, target, testOpt, testWc);
    return;
  }

  if (cmd === "run") {
    runFile(source!, rest, target, optFlag, warningConfig);
  } else if (cmd === "build") {
    const bin = compileToBinary(source!, output, target, optFlag, warningConfig);
    console.log(`compiled ${source} -> ${bin}`);
  } else if (cmd === "emit-ir") {
    compileToIr(source!, output, target, warningConfig);
  } else if (cmd === "emit-js") {
    const src = readFileSync(source!, "utf-8");
    const js = compileToJS(src, target, source!, warningConfig);
    if (output) {
      writeFileSync(output, js);
      console.log(`wrote ${output}`);
    } else {
      process.stdout.write(js);
    }
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main();
