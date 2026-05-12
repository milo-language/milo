import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { basename, resolve } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker } from "./checker";
import { Codegen } from "./codegen";

function compile(source: string): string {
  const tokens = new Lexer(source).tokenize();
  const program = new Parser(tokens).parse();

  const errors = new TypeChecker().check(program);
  if (errors.length > 0) {
    for (const err of errors) console.error(`error[type]: ${err}`);
    process.exit(1);
  }

  return new Codegen().generate(program);
}

function compileFile(sourcePath: string, outputPath: string | null, emitIr: boolean) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source);

  if (emitIr) {
    if (outputPath) {
      writeFileSync(outputPath, ir);
      console.log(`wrote ${outputPath}`);
    } else {
      process.stdout.write(ir);
    }
    return;
  }

  const base = basename(sourcePath).replace(/\.milo$/, "");
  const out = outputPath ?? base;
  const tmpPath = join(tmpdir(), `milo_${Date.now()}.ll`);

  try {
    writeFileSync(tmpPath, ir);
    execSync(`clang ${tmpPath} -o ${out} -Wno-override-module`, { stdio: ["pipe", "pipe", "pipe"] });
    console.log(`compiled ${sourcePath} -> ${out}`);
  } catch (e: any) {
    console.error(`error[link]: clang failed:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("usage: milo <command> [options] <file>");
    console.log("commands:");
    console.log("  build <file>           compile to executable");
    console.log("  emit-ir <file>         emit LLVM IR");
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === "build") {
    let output: string | null = null;
    let source: string | null = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
      else { source = args[i]; }
    }
    if (!source) { console.error("error: no source file"); process.exit(1); }
    compileFile(source, output, false);
  } else if (cmd === "emit-ir") {
    let output: string | null = null;
    let source: string | null = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
      else { source = args[i]; }
    }
    if (!source) { console.error("error: no source file"); process.exit(1); }
    compileFile(source, output, true);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main();
