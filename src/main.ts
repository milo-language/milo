import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
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
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, filePath));
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
    let libs = "";
    if (ir.includes("@SSL_") || ir.includes("@TLS_client_method")) {
      libs = target.os === "darwin"
        ? " -L/opt/homebrew/opt/openssl@3/lib -lssl -lcrypto"
        : " -lssl -lcrypto";
    }
    execSync(`clang${opt} ${tmpLl} -o ${out} -Wno-override-module${libs}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    console.error(`error[link]: clang failed:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
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
  let optFlag = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
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
    console.log("  emit-ir <file>         emit LLVM IR");
    console.log("options:");
    console.log("  --release              optimize (-O3)");
    console.log("  -O<level>              clang opt level: 0,1,2,3,s,z");
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === "lsp") {
    // Launch language server — dynamically import to avoid loading LSP code in normal compilation
    import("./lsp");
    return;
  }

  const { output, source, rest, optFlag } = parseArgs(args.slice(1));
  const target = getHostTarget();

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

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
