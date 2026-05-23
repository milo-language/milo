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
import { generateVerificationConditions, formatVerifyReport } from "./verify";
import { parseSafetyLevel, checkSafetyCompliance, formatSafetyReport, listSafetyLevels } from "./safety";

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

function compile(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig, debugOverflow = false): string {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  return new Codegen(target, filePath, debugOverflow).generate(hirModule);
}

function compileToJS(source: string, target: TargetInfo, filePath?: string, warningConfig?: WarningConfig): string {
  const hirModule = frontendToHIR(source, target, filePath, warningConfig);
  return new CodegenJS().generate(hirModule);
}

function compileToIr(sourcePath: string, outputPath: string | null, target: TargetInfo, warningConfig?: WarningConfig, debugOverflow = false) {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig, debugOverflow);
  if (outputPath) {
    writeFileSync(outputPath, ir);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(ir);
  }
}

// detect clang: prefer /usr/bin/clang (Apple) which is more stable, then PATH clang, then llc+cc
type Toolchain = { kind: "clang"; path: string } | { kind: "llc+cc" };
let cachedToolchain: Toolchain | null = null;
function detectToolchain(): Toolchain {
  if (cachedToolchain) return cachedToolchain;
  const candidates = ["/usr/bin/clang", "clang"];
  for (const cc of candidates) {
    try {
      execSync(`${cc} --version`, { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
      cachedToolchain = { kind: "clang", path: cc };
      return cachedToolchain;
    } catch {}
  }
  try {
    execSync("llc --version", { stdio: ["pipe", "pipe", "pipe"] });
    execSync("cc --version", { stdio: ["pipe", "pipe", "pipe"] });
    cachedToolchain = { kind: "llc+cc" };
  } catch {
    throw new Error("no C compiler found: need either 'clang' or 'llc'+'cc' on PATH");
  }
  return cachedToolchain;
}

function linkIR(llFile: string, outFile: string, optFlag: string, libs: string, extra: string = "") {
  const tc = detectToolchain();
  if (tc.kind === "clang") {
    const opt = optFlag ? ` ${optFlag}` : "";
    execSync(`${tc.path}${opt} ${llFile} -o ${outFile} -Wno-override-module${libs}${extra}`, { stdio: ["pipe", "pipe", "pipe"] });
  } else {
    const tmpObj = llFile.replace(/\.ll$/, ".o");
    const opt = optFlag || "-O2";
    try {
      execSync(`llc -filetype=obj ${opt} ${llFile} -o ${tmpObj}`, { stdio: ["pipe", "pipe", "pipe"] });
      execSync(`cc ${tmpObj} -o ${outFile}${libs}${extra} -lm`, { stdio: ["pipe", "pipe", "pipe"] });
    } finally {
      try { unlinkSync(tmpObj); } catch {}
    }
  }
}

function compileToObj(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, noEntry = false): string {
  const source = readFileSync(sourcePath, "utf-8");
  const ir = compile(source, target, sourcePath, warningConfig);

  const base = basename(sourcePath).replace(/\.milo$/, "");
  const out = outputPath ?? base + ".o";
  const id = crypto.randomUUID().slice(0, 8);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  let irText = ir;
  if (noEntry) {
    // Remove main function definition — keep only non-main functions
    // Replace `define ... @main(...)` with internal linkage so it doesn't conflict
    irText = irText.replace(
      /^define (.*) @main\(/m,
      "define internal $1 @_milo_unused_main("
    );
  }

  try {
    writeFileSync(tmpLl, irText);
    const tc = detectToolchain();
    const opt = optFlag || "-O2";
    if (tc.kind === "clang") {
      execSync(`${tc.path} -c ${opt} ${tmpLl} -o ${out} -Wno-override-module`, { stdio: ["pipe", "pipe", "pipe"] });
    } else {
      execSync(`llc -filetype=obj ${opt} ${tmpLl} -o ${out}`, { stdio: ["pipe", "pipe", "pipe"] });
    }
  } catch (e: any) {
    console.error(`error[emit-obj]: compilation failed:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpLl); } catch {}
  }
  return out;
}

function buildLib(sourcePaths: string[], outputPath: string, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig) {
  const objFiles: string[] = [];
  try {
    for (const src of sourcePaths) {
      const id = crypto.randomUUID().slice(0, 8);
      const tmpObj = join(tmpdir(), `milo_${id}.o`);
      compileToObj(src, tmpObj, target, optFlag, warningConfig, true);
      objFiles.push(tmpObj);
    }
    const objs = objFiles.map(f => `"${f}"`).join(" ");
    execSync(`ar rcs "${outputPath}" ${objs}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    console.error(`error[build-lib]: ${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  } finally {
    for (const f of objFiles) { try { unlinkSync(f); } catch {} }
  }
}

function detectLibs(ir: string, target: TargetInfo): string {
  let libs = "";
  if (ir.includes("@SSL_") || ir.includes("@TLS_client_method")) {
    libs += target.os === "darwin"
      ? " -L/opt/homebrew/opt/openssl@3/lib -lssl -lcrypto"
      : " -lssl -lcrypto";
  }
  if (!libs.includes("-lcrypto") && (ir.includes("@SHA256") || ir.includes("@MD5"))) {
    libs += " -lcrypto";
  }
  if (ir.includes("@sqlite3_")) {
    libs += target.os === "darwin"
      ? " -L/opt/homebrew/opt/sqlite/lib -lsqlite3"
      : " -lsqlite3";
  }
  return libs;
}

function compileToBinary(sourcePath: string, outputPath: string | null, target: TargetInfo, optFlag: string = "", warningConfig?: WarningConfig, extraLinkFlags: string[] = []): string {
  const source = readFileSync(sourcePath, "utf-8");
  const debugOverflow = optFlag === "-O0";
  const ir = compile(source, target, sourcePath, warningConfig, debugOverflow);
  const base = basename(sourcePath).replace(/\.milo$/, "");
  const id = crypto.randomUUID().slice(0, 8);
  const out = outputPath ?? join(tmpdir(), `milo_${base}_${id}`);
  const tmpLl = join(tmpdir(), `milo_${id}.ll`);

  try {
    writeFileSync(tmpLl, ir);
    const libs = detectLibs(ir, target);
    const extra = extraLinkFlags.length ? " " + extraLinkFlags.join(" ") : "";
    linkIR(tmpLl, out, optFlag, libs, extra);
  } catch (e: any) {
    console.error(`error[link]: compilation failed:\n${e.stderr?.toString() ?? e.message}`);
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
    const libs = detectLibs(ir, target);
    linkIR(tmpLl, out, optFlag, libs);
  } catch (e: any) {
    throw new Error(`compilation failed:\n${e.stderr?.toString() ?? e.message}`);
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

function parseArgs(args: string[]): { output: string | null; source: string | null; rest: string[]; optFlag: string; warningConfig: WarningConfig; noEntry: boolean; safetyLevel: string | null } {
  let output: string | null = null;
  let source: string | null = null;
  let optFlag = "-O2";
  let noEntry = false;
  let safetyLevel: string | null = null;
  const rest: string[] = [];
  const denied = new Set<string>();
  const allowed = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) { output = args[++i]; }
    else if (args[i] === "--release") { optFlag = "-O3"; }
    else if (args[i] === "--debug") { optFlag = "-O0"; }
    else if (args[i] === "--no-entry") { noEntry = true; }
    else if (args[i] === "-O" && i + 1 < args.length) { optFlag = `-O${args[++i]}`; }
    else if (/^-O[0-3sz]$/.test(args[i])) { optFlag = args[i]; }
    else if (args[i] === "--deny-all") { denied.add("*"); }
    else if (args[i].startsWith("--deny=")) { denied.add(args[i].slice(7)); }
    else if (args[i] === "--deny" && i + 1 < args.length) { denied.add(args[++i]); }
    else if (args[i].startsWith("--allow=")) { allowed.add(args[i].slice(8)); }
    else if (args[i] === "--allow" && i + 1 < args.length) { allowed.add(args[++i]); }
    else if (args[i].startsWith("--safety=")) { safetyLevel = args[i].slice(9); }
    else if (args[i] === "--safety" && i + 1 < args.length) { safetyLevel = args[++i]; }
    else if (args[i] === "--") { rest.push(...args.slice(i + 1)); break; }
    else if (!source) { source = args[i]; }
    else { rest.push(args[i]); }
  }
  return { output, source, rest, optFlag, warningConfig: { denied, allowed }, noEntry, safetyLevel };
}

const SKILL_TEXT = `# Milo Language Guide

Milo is a memory-safe systems language that compiles to native binaries via LLVM.
It uses move semantics and second-class references — no GC, no RC, no lifetime annotations.

## Compile & Run

\`\`\`bash
bun run src/main.ts run file.milo              # compile + run (no artifacts)
bun run src/main.ts build file.milo -o myapp   # compile to binary
bun run src/main.ts emit-ir file.milo          # emit LLVM IR
bun run src/main.ts build file.milo --release  # -O3 optimized
\`\`\`

## Language Basics

\`\`\`milo
fn main(): i32 {
    print("hello")
    return 0
}
\`\`\`

### Variables
- \`let x = 42\` — immutable binding (cannot reassign)
- \`var x = 42\` — mutable binding
- Type inference works: \`let name = "milo"\` infers \`string\`

### Types
- Integers: \`i8\`, \`i16\`, \`i32\`, \`i64\`, \`u8\`, \`u16\`, \`u32\`, \`u64\`
- Float: \`f64\`
- \`bool\`, \`string\`, \`void\`
- \`Vec<T>\`, \`HashMap<K, V>\`, \`Array<T, N>\`
- \`Option<T>\` (shorthand: \`T?\`), \`Result<T, E>\`

### Functions
\`\`\`milo
fn add(a: i32, b: i32): i32 {
    return a + b
}

fn greet(name: &string): void {    // & = immutable reference (borrow)
    print($"hello, {name}!")
}

fn increment(x: &mut i64): void {  // &mut = mutable reference
    x = x + 1
}

// generics
fn first<T>(items: &Vec<T>): &T {
    return items[0]
}
\`\`\`

### Structs & Impl
\`\`\`milo
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64): Point {
        return Point { x: x, y: y }
    }

    fn distance(self: &Self, other: &Point): f64 {
        let dx = self.x - other.x
        let dy = self.y - other.y
        return sqrt(dx * dx + dy * dy)
    }
}
\`\`\`

### Enums & Match
\`\`\`milo
enum Shape {
    Circle(f64),
    Rect(f64, f64),
    Empty,
}

fn area(s: &Shape): f64 {
    match s {
        Shape.Circle(r) => return 3.14159 * r * r
        Shape.Rect(w, h) => return w * h
        Shape.Empty => return 0.0
    }
}
\`\`\`

### Option & Result
\`\`\`milo
fn find(items: &Vec<string>, target: &string): string? {
    var i: i64 = 0
    while i < items.len {
        if items[i] == target {
            return Option.Some(items[i].clone())
        }
        i = i + 1
    }
    return null   // sugar for Option.None
}

// unwrap: expr!   propagate: expr?   default: expr ?? fallback
let val = find(items, "key") ?? "default"
\`\`\`

### Closures
\`\`\`milo
let double = (x: i32) => x * 2
let result = double(21)

var items: Vec<i32> = Vec.new()
items.push(3)
items.push(1)
items.push(2)
items.sort((a: &i32, b: &i32) => a - b)
\`\`\`

### Traits
\`\`\`milo
trait Display {
    fn display(self: &Self): string
}

impl Display for Point {
    fn display(self: &Self): string {
        return $"({self.x}, {self.y})"
    }
}

@derive(Eq)    // auto-derive equality
struct Id { value: i64 }
\`\`\`

### Imports
\`\`\`milo
from "std/io" import { readFile, writeFile }
from "std/json" import { jsonParse, jsonStringify }
from "std/fs" import { isFile, isDir, readDir }
import "other_file.milo"
\`\`\`

### Key Rules
- Move semantics: values have a single owner. After \`let y = x\`, using \`x\` is a compile error. Use \`.clone()\` for explicit copies.
- References (\`&T\`, \`&mut T\`) are second-class: only allowed in function parameters, never stored in structs or returned.
- No null — use \`Option<T>\` (\`T?\`).
- No exceptions — use \`Result<T, E>\` for fallible operations.
- No implicit conversions — use \`expr as Type\` for casts.
- Strings are owned UTF-8 buffers. Pass as \`&string\` to borrow.
- \`unsafe { ... }\` required for FFI calls, raw memory, and exit().
- String interpolation: \`$"hello {name}, count={count}"\`
- No semicolons (statements are newline-delimited).
- camelCase for functions/variables, PascalCase for types.

## Standard Library

Import with \`from "std/<name>" import { ... }\`. Key modules:

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| \`std/io\` | File & stream I/O | \`readFile\`, \`writeFile\`, \`readStdin\`, \`writeStdout\`, \`appendFile\` |
| \`std/fs\` | Filesystem ops | \`isFile\`, \`isDir\`, \`readDir\`, \`mkdir\`, \`remove\`, \`rename\`, \`chmod\`, \`symlink\` |
| \`std/path\` | Path manipulation | \`pathJoin\`, \`pathDir\`, \`pathBase\`, \`pathExt\`, \`pathResolve\` |
| \`std/args\` | Raw CLI arguments | \`args()\` → \`Vec<string>\`, \`getFlag(name)\`, \`hasFlag(name)\` |
| \`std/argparse\` | Declarative arg parser | \`newParser\`, \`ArgParser\`, \`ParsedArgs\` (see detailed section below) |
| \`std/env\` | Environment vars | \`getEnv\`, \`setEnv\`, \`allEnv\` |
| \`std/json\` | JSON parse/serialize | \`jsonParse\`, \`jsonStringify\`, \`JsonValue\` |
| \`std/toml\` | TOML parser | \`tomlParse\`, \`TomlValue\` |
| \`std/csv\` | CSV parser | \`csvParse\`, \`csvStringify\` |
| \`std/http\` | HTTP client | \`httpGet\`, \`httpPost\`, \`httpRequest\`, \`HttpResponse\` |
| \`std/net\` | TCP networking | \`tcpConnect\`, \`tcpListen\`, \`TcpStream\`, \`TcpListener\` |
| \`std/crypto\` | Cryptographic hashes | \`sha256\`, \`md5\` |
| \`std/base64\` | Base64 encoding | \`base64Encode\`, \`base64Decode\` |
| \`std/hex\` | Hex encoding | \`hexEncode\`, \`hexDecode\` |
| \`std/regex\` | Regular expressions | \`regexMatch\`, \`regexFind\`, \`regexReplace\` |
| \`std/datetime\` | Date and time | \`now\`, \`formatTime\`, \`DateTime\` |
| \`std/time\` | Timing | \`sleep\`, \`clockMs\` |
| \`std/random\` | Random numbers | \`randomI64\`, \`randomF64\`, \`randomRange\` |
| \`std/uuid\` | UUID generation | \`uuidV4\` |
| \`std/math\` | Math functions | \`sqrt\`, \`abs\`, \`min\`, \`max\`, \`pow\`, \`floor\`, \`ceil\` |
| \`std/string\` | String utilities | \`split\`, \`join\`, \`trim\`, \`padLeft\`, \`padRight\`, \`repeat\` |
| \`std/strconv\` | String conversions | \`parseInt\`, \`parseFloat\` |
| \`std/fmt\` | String formatting | \`fmt\`, \`fmtFloat\` |
| \`std/color\` | Terminal colors | \`red\`, \`green\`, \`blue\`, \`bold\`, \`dim\`, \`reset\` |
| \`std/sort\` | Sorting | \`sort\` for Vec with comparator |
| \`std/set\` | Hash set | \`Set<T>\` |
| \`std/url\` | URL parsing | \`parseUrl\`, \`Url\` |
| \`std/log\` | Logging | \`logInfo\`, \`logWarn\`, \`logError\`, \`logDebug\` |
| \`std/signal\` | OS signal handling | \`onSignal\` |
| \`std/process\` | Process management | \`exec\`, \`spawn\`, \`ProcessResult\` |
| \`std/thread\` | Threading | \`spawn\` (thread), \`Thread\` |
| \`std/sync\` | Concurrency primitives | \`Mutex\`, \`Channel\`, \`WaitGroup\` |
| \`std/arena\` | Arena allocator | \`Arena\`, \`ArenaRef\` |
| \`std/mem\` | Memory utilities | \`sizeOf\`, \`alignOf\` |
| \`std/cstr\` | C string interop | \`toCStr\`, \`fromCStr\` |
| \`std/sqlite\` | SQLite database | \`sqliteOpen\`, \`sqliteExec\`, \`sqliteQuery\` |
| \`std/unicode\` | Unicode utilities | \`isAlpha\`, \`isDigit\`, \`toUpper\`, \`toLower\` |
| \`std/os\` | OS information | \`platform\`, \`arch\`, \`hostname\` |
| \`std/runtime\` | Runtime internals | (internal use) |
| \`std/testing\` | Test assertions | \`assert\`, \`assertEqual\`, \`assertNe\` |
| \`std/prelude\` | Auto-imported types | \`Vec\`, \`HashMap\`, \`Option\`, \`Result\`, \`Heap\`, \`print\`, \`eprint\` |
| \`std/event\` | Event loop (kqueue/epoll) | \`EventLoop\`, \`EventHandler\` |
| \`std/platform\` | Platform detection | \`platform\`, \`arch\` |

Prelude types (\`Vec\`, \`HashMap\`, \`Option\`, \`Result\`, \`Heap\`, \`print\`, \`eprint\`) are available without import.

## Argument Parsing (std/argparse)

This is the recommended way to build CLI tools. Full working example:

\`\`\`milo
from "std/argparse" import { newParser }
from "std/io" import { readFile }

fn main(): i32 {
    // 1. Create parser
    var parser = newParser("mytool", "process text files")

    // 2. Define arguments
    parser.addPositional("file", "input file to process")
    parser.addOptionalPositional("output", "output path (default: stdout)")
    parser.addString("format", "f", "output format", "text")   // flag with default
    parser.addBool("verbose", "v", "enable verbose output")     // boolean flag
    parser.addI64("count", "n", "max items to process", 100)   // integer flag
    parser.addRequired("token", "t", "API token")              // required flag

    // 3. Parse (auto-handles --help, exits on error)
    let args = parser.parse()

    // 4. Read values
    let file = args.getString("file")       // positional or flag by name
    let fmt = args.getString("format")      // "text" if not provided
    let verbose = args.getBool("verbose")   // false if not provided
    let count = args.getI64("count")        // 100 if not provided
    let token = args.getString("token")     // guaranteed present (required)

    if args.has("output") {
        let out = args.getString("output")
        // write to file...
    }

    match readFile(file) {
        Result.Ok(content) => {
            if verbose {
                print($"processing {file} ({content.len} bytes)")
            }
            print(content)
        }
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

Running this program:
\`\`\`bash
mytool input.txt --format json -v --token abc123
mytool --help    # prints auto-generated usage
\`\`\`

### ArgParser Builder Methods
- \`addString(long, short, help, default)\` — optional string flag
- \`addRequired(long, short, help)\` — required string flag (exits if missing)
- \`addBool(long, short, help)\` — boolean flag (present = true)
- \`addI64(long, short, help, default)\` — integer flag, validated at parse time
- \`addPositional(name, help)\` — required positional argument
- \`addOptionalPositional(name, help)\` — optional positional
- \`enableTrailingArgs()\` — stop flag parsing after first positional, collect rest as-is

### Parsing Methods
- \`parse()\` — parse from process arguments
- \`parseFrom(argv: Vec<string>)\` — parse from a provided arg list (argv[0] = program name, skipped)

### ParsedArgs Query Methods
- \`getString(name)\` — get string value by long name
- \`getI64(name)\` — get integer value
- \`getU16(name)\` — get u16 value (validated 0..65535)
- \`getBool(name)\` — check boolean flag
- \`has(name)\` — check if flag/positional was provided
- \`.positional\` — \`Vec<string>\` of remaining positional args

### Trailing Args and -- Separator
\`\`\`milo
parser.enableTrailingArgs()
// mytool build -- --extra-flag    →  args.positional contains ["--extra-flag"]
\`\`\`

## Common Patterns

### Error Handling with Result
\`\`\`milo
from "std/io" import { readFile }

fn processFile(path: &string): Result<string, string> {
    let content = readFile(path)?   // ? propagates error
    // process content...
    return Result.Ok(content)
}

fn main(): i32 {
    match processFile("data.txt") {
        Result.Ok(data) => print(data)
        Result.Err(e) => {
            print($"error: {e}")
            return 1
        }
    }
    return 0
}
\`\`\`

### Vec Operations
\`\`\`milo
var items: Vec<string> = Vec.new()
items.push("one")
items.push("two")
items.push("three")
print($"count: {items.len}")   // 3
let first = items[0]           // "one"
items.sort((a: &string, b: &string) => a.len - b.len)
\`\`\`

### HashMap
\`\`\`milo
var counts: HashMap<string, i64> = HashMap.new()
counts.set("apples", 5)
counts.set("oranges", 3)
if counts.has("apples") {
    let n = counts.get("apples")!
    print($"apples: {n}")
}
\`\`\`

### String Interpolation
\`\`\`milo
let name = "world"
let count = 42
print($"hello {name}, count={count}")
print($"hex: {count}")
print($"result: {1 + 2}")
\`\`\`

### Threads and Channels
\`\`\`milo
from "std/thread" import { greenSpawn }
from "std/sync" import { newChannel }

fn main(): i32 {
    var ch = newChannel<i64>()
    greenSpawn(() => {
        ch.send(42)
    })
    let val = ch.recv()
    print($"got: {val}")
    return 0
}
\`\`\`

### JSON
\`\`\`milo
from "std/json" import { jsonParse, jsonStringify }

struct Config {
    name: string,
    port: i64,
    debug: bool,
}

let config = Config { name: "app", port: 8080, debug: false }
let json = jsonStringify(config)
print(json)   // {"name":"app","port":8080,"debug":false}
\`\`\`

## What NOT to Do
- No garbage collector or reference counting — values are moved or cloned explicitly.
- No storing references in structs — \`&T\` is only valid in function params.
- No raw pointers in safe code — use \`unsafe { ... }\` for FFI.
- No implicit type conversions — cast with \`as\`.
- No exceptions or try/catch — use \`Result<T, E>\` and \`?\` propagation.
- No null — use \`Option<T>\` (\`T?\`) and pattern match or \`??\` for defaults.
- No semicolons — statements are newline-separated.
- No class inheritance — use traits and composition.
`;

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("usage: milo <command> [options] <file>");
    console.log("commands:");
    console.log("  run <file> [args]      compile and run (no artifacts left behind)");
    console.log("  build <file> [-o out]  compile to executable");
    console.log("  test [file...]         run tests (*_test.milo files)");
    console.log("  emit-ir <file>         emit LLVM IR");
    console.log("  emit-obj <file>        compile to object file (.o)");
    console.log("  build-lib <files...>   compile to static library (.a)");
    console.log("  emit-js <file>         emit JavaScript (playground target)");
    console.log("  fmt <file...>          format source files (-w to write in place)");
    console.log("  verify <file>          generate SMT-LIB2 verification conditions");
    console.log("  safety <file>          check safety profile compliance");
    console.log("  safety --list          list available safety profiles");
    console.log("  skill                  print language guide for LLMs");
    console.log("options:");
    console.log("  --release              optimize (-O3)");
    console.log("  --debug                no optimization (-O0)");
    console.log("  -O<level>              clang opt level: 0,1,2,3,s,z (default: -O2)");
    console.log("  --deny=<warning>       treat warning as error (e.g. --deny=unused-variable)");
    console.log("  --allow=<warning>      suppress warning (e.g. --allow=unused-result)");
    console.log("  --deny-all             treat all warnings as errors");
    console.log("  --safety=<level>       enforce safety profile (e.g. --safety=do178c-a)");
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === "skill") {
    process.stdout.write(SKILL_TEXT);
    return;
  }

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

  const { output, source, rest, optFlag, warningConfig, noEntry, safetyLevel } = parseArgs(args.slice(1));
  const target = getHostTarget();

  if (cmd === "build-lib") {
    const libArgs = args.slice(1);
    const sources = libArgs.filter(a => a.endsWith(".milo"));
    const libOutput = output ?? "lib.a";
    if (sources.length === 0) { console.error("error: no .milo source files"); process.exit(1); }
    buildLib(sources, libOutput, target, optFlag, warningConfig);
    console.log(`compiled ${sources.length} file(s) -> ${libOutput}`);
    return;
  }

  if (cmd === "safety" && args.slice(1).includes("--list")) {
    console.log(listSafetyLevels());
    return;
  }

  if (!source && cmd !== "--help") { console.error("error: no source file"); process.exit(1); }

  if (cmd === "verify") {
    const src = readFileSync(source!, "utf-8");
    const sourceDir = dirname(resolve(source!));
    const tokens = new Lexer(src).tokenize();
    let program = new Parser(tokens, src).parse();
    program = resolveImports(program, sourceDir, target);
    new TypeChecker(warningConfig).check(program);
    const result = generateVerificationConditions(program);
    console.log(formatVerifyReport(result));
    return;
  }

  if (cmd === "safety") {
    const level = parseSafetyLevel(safetyLevel ?? args[2] ?? "");
    if (!level) {
      console.error(`unknown safety level: ${safetyLevel ?? args[2] ?? "(none)"}`);
      console.error("use 'milo safety --list' to see available profiles");
      process.exit(1);
    }
    const src = readFileSync(source!, "utf-8");
    const sourceDir = dirname(resolve(source!));
    const tokens = new Lexer(src).tokenize();
    let program = new Parser(tokens, src).parse();
    program = resolveImports(program, sourceDir, target);
    new TypeChecker(warningConfig).check(program);
    const violations = checkSafetyCompliance(program, level);
    console.log(formatSafetyReport(violations, level));
    if (violations.some(v => v.severity === "error")) process.exit(1);
    return;
  }

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
    const bin = compileToBinary(source!, output, target, optFlag, warningConfig, rest);
    console.log(`compiled ${source} -> ${bin}`);
  } else if (cmd === "emit-ir") {
    compileToIr(source!, output, target, warningConfig, optFlag === "-O0");
  } else if (cmd === "emit-obj") {
    const obj = compileToObj(source!, output, target, optFlag, warningConfig, noEntry);
    console.log(`compiled ${source} -> ${obj}`);
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
