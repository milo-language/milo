// The CLI surface: every subcommand and top-level option, in one table.
//
// This existed three times in main.ts — the usage banner, the KNOWN_COMMANDS set that
// rejects a typo, and the `if (cmd === ...)` dispatch chain — and they disagreed:
// `lsp`, `lex` and `verify` were dispatched but absent from the banner, and five
// implemented flags (--emit-header, --max-stack-array, --no-entry and --cycles)
// were undocumented. The banner and the known-command set are now rendered
// from here, and tests/cliHelp.test.ts holds the dispatch chain to it. `milo lang --json`
// projects the same table as `commands`/`cliOptions`, which docs/site/cli.md is generated from.
//
// Package-manager verbs live in pkgcli.ts's PKG_COMMANDS; their help text is here so
// the banner is one document, and the test checks the two agree.

import { OFF_BY_DEFAULT } from "./warnings";

/** A flag only one subcommand reads, listed under that subcommand. */
interface CliFlag {
  /** As typed, e.g. "--solver=z3" or "-t <pattern>". */
  flag: string;
  help: string;
}

interface CliCommand {
  /** The dispatch token, e.g. "emit-ir". */
  name: string;
  /** Full left column of the banner, e.g. "build <file> [-o out]". */
  usage: string;
  /** One line: what the command does. */
  summary: string;
  /** Prose continuation lines shown indented under the summary. */
  details?: string[];
  /** Flags this command reads that the global options block does not cover. */
  flags?: CliFlag[];
  /** Dispatched but deliberately absent from the banner; the string says why. */
  hidden?: string;
  /** Extra banner rows for sub-verbs and alternate forms that deserve their own left column. */
  extraRows?: { usage: string; help: string }[];
}

export const COMPILER_COMMANDS: CliCommand[] = [
  { name: "run", usage: "run <file> [args]", summary: "compile and run (no artifacts left behind)" },
  { name: "build", usage: "build <file> [-o out]", summary: "compile to executable" },
  {
    name: "test", usage: "test [file|dir...]",
    summary: "run tests (*_test.milo, recursive in a dir; cwd by default)",
    details: [
      "a test is a top-level `fn test*()` with no parameters;",
      "each runs in its own process, so a trap fails only that test",
    ],
    flags: [
      { flag: "--contracts", help: "instead, test every fn's requires/ensures on drawn inputs (any .milo)" },
      { flag: "-t <pattern>", help: "run only tests matching (substring or regex)" },
      { flag: "--test-name-pattern <pattern>", help: "long form of -t" },
      { flag: "--json", help: "machine-readable results" },
    ],
  },
  {
    name: "check", usage: "check <file>", summary: "type-check only, no codegen",
    flags: [{ flag: "--json", help: "machine-readable diagnostics, each with its fix when one is mechanical" }],
  },
  {
    name: "fix", usage: "fix <file>",
    summary: "apply every machine-applicable fix the check reports (&mut markers, imports, @ sigils, unused unsafe), in every file it reaches",
  },
  {
    name: "emit-ast", usage: "emit-ast <file>", summary: "emit the parsed AST as JSON",
    flags: [{ flag: "--all", help: "include imported modules" }, { flag: "--spans", help: "keep source spans" }],
  },
  {
    name: "emit-hir", usage: "emit-hir <file>", summary: "emit the typed HIR as JSON",
    flags: [{ flag: "--all", help: "the full module, imports included" }, { flag: "--spans", help: "keep source spans" }],
  },
  { name: "emit-ir", usage: "emit-ir <file>", summary: "emit LLVM IR" },
  { name: "emit-obj", usage: "emit-obj <file>", summary: "compile to object file (.o)" },
  { name: "build-lib", usage: "build-lib <files...>", summary: "compile to static library (.a)" },
  {
    name: "fmt", usage: "fmt <file...>", summary: "format source files (to stdout unless -w)",
    flags: [{ flag: "-w", help: "write in place, printing each file that changed" }],
  },
  {
    name: "prove", usage: "prove <file>",
    summary: "prove contracts hold, via std/smt, the milo-native prover",
    flags: [
      { flag: "--solver=z3", help: "use z3 instead (adds non-linear arithmetic)" },
      { flag: "--emit-smt", help: "print the SMT-LIB2 obligations instead of solving them" },
      { flag: "--all", help: "include imported stdlib" },
      { flag: "--json", help: "machine-readable report" },
    ],
  },
  {
    name: "safety", usage: "safety <file> --safety=<level>", summary: "check safety profile compliance",
    flags: [{ flag: "--json", help: "machine-readable violations" }],
    extraRows: [{ usage: "safety --list", help: "list available safety profiles" }],
  },
  {
    name: "wcet", usage: "wcet <file> [-o out]", summary: "emit OTAWA flow facts (loop bounds) for WCET analysis",
    flags: [{ flag: "--cycles", help: "a Cortex-M cycle bound from the linked ELF (bare-metal ARM --target only)" }],
  },
  { name: "lsp", usage: "lsp", summary: "run the language server on stdio (what an editor launches)" },
  { name: "skill", usage: "skill", summary: "print language guide for LLMs" },
  { name: "help", usage: "help", summary: "print this help (also --help, -h)" },
  {
    name: "lang", usage: "lang",
    summary: "the language's vocabulary as data: keywords, types, operators, builtins, warnings, attributes, commands",
    flags: [{ flag: "--json", help: "the full payload, for tooling" }],
  },
  {
    name: "explain", usage: "explain <name>",
    summary: "what one warning, @attribute or keyword means, with an example and how to silence it",
    flags: [{ flag: "--json", help: "the raw entry" }],
  },
  {
    name: "api", usage: "api <terms>", summary: "search std signatures by name/doc",
    flags: [
      { flag: "--module std/x", help: "dump one module's full API" },
      { flag: "--markdown", help: "emit reference docs" },
      { flag: "--json", help: "every std symbol" },
    ],
  },
  {
    name: "doc", usage: "doc <file|dir>", summary: "reference markdown from doc-comments",
    flags: [{ flag: "-o <dir>", help: "write one .md per module" }],
  },
  { name: "lex", usage: "lex <file>", summary: "dump the token stream as JSON", hidden: "compiler-debug output, not a user-facing command" },
];

export const PACKAGE_COMMANDS: CliCommand[] = [
  { name: "init", usage: "init | new <name>", summary: "create milo.json here / scaffold a new project" },
  { name: "new", usage: "", summary: "", hidden: "shares the `init | new <name>` banner row" },
  {
    name: "add", usage: "add <pkg>", summary: "add a library dependency (milo.json + milo.lock)",
    flags: [{ flag: "--dev", help: "record it under devDeps" }],
  },
  { name: "remove", usage: "remove <pkg>", summary: "drop a dependency and prune the lock" },
  {
    name: "install", usage: "install", summary: "sync this project from milo.lock",
    flags: [{ flag: "--frozen", help: "fail if the lock is stale" }],
  },
  { name: "update", usage: "update [pkg]", summary: "re-resolve tags and rewrite the lock" },
  { name: "tree", usage: "tree | why <pkg>", summary: "dependency graph / who pulls a package in" },
  { name: "why", usage: "", summary: "", hidden: "shares the `tree | why <pkg>` banner row" },
  { name: "vendor", usage: "vendor", summary: "copy deps into ./vendor and rewrite to local paths" },
  { name: "publish", usage: "publish", summary: "validate, tag, push" },
  {
    name: "tool", usage: "tool install <pkg>",
    summary: "build and install a global executable (~/.local/bin)",
    extraRows: [
      { usage: "tool uninstall <name>", help: "remove an installed executable" },
      { usage: "tool list [--repair]", help: "list installed executables (--repair: rebuild the index)" },
      { usage: "tool run <pkg> [args]", help: "build and run a package's binary without installing" },
    ],
  },
];

interface CliOption {
  /** The flag as written, e.g. "--target=<name>". Its name for matching is the leading `--word`. */
  flag: string;
  help: string[];
}

export const OPTIONS: CliOption[] = [
  { flag: "--release", help: ["optimize (-O3)"] },
  { flag: "--debug", help: ["no optimization (-O0)"] },
  { flag: "-g", help: ["emit DWARF line info (source-level lldb/hades); composes with any -O / --debug"] },
  { flag: "-O<level>", help: ["clang opt level: 0,1,2,3,s,z (default: -O2)"] },
  { flag: "--sanitize", help: ["link with AddressSanitizer (requires clang)"] },
  { flag: "--static-deps", help: ["static-link native deps (openssl/sqlite) for a portable binary"] },
  { flag: "--overflow-checks", help: ["trap on +/-/* overflow at any -O (on by default in every mode)"] },
  { flag: "--no-overflow-checks", help: ["wrap on +/-/* overflow at any -O (opt out of the default traps)"] },
  { flag: "--contract-checks", help: ["assert requires/ensures/invariant at any -O (default: only --debug)"] },
  { flag: "--no-contract-checks", help: ["drop those asserts at any -O (e.g. fast -O0 builds)"] },
  { flag: "--strip-panic-locations", help: ["blank source paths out of runtime panic messages (-g still embeds them)"] },
  { flag: "--fast", help: ["quick edit-loop build: -O0, wrapping (~2x faster compile)"] },
  { flag: "--cgus=<n>", help: ["codegen units compiled in parallel (default: auto, 1 for --release/-g)"] },
  { flag: "--deny=<warning>", help: ["treat warning as error (e.g. --deny=unused-variable)"] },
  { flag: "--allow=<warning>", help: ["suppress warning (e.g. --allow=unused-result)"] },
  { flag: "--expect=<warning>", help: ["suppress it, and report if it stops occurring (e.g. --expect=index-clone)"] },
  {
    flag: "--deny-all",
    help: [
      "treat all warnings as errors",
      // Rendered from src/warnings.ts: this line used to be prose and had to be edited by
      // hand every time a warning landed, which is how it fell behind the checker.
      `(off-by-default warnings: ${OFF_BY_DEFAULT.join(", ")})`,
    ],
  },
  {
    flag: "--json",
    help: [
      "machine-readable output, for tooling instead of a human",
      "(api, lang, explain, check, prove, safety, test; see docs/json-api.md)",
    ],
  },
  { flag: "--safety=<level>", help: ["enforce safety profile (e.g. --safety=do178)"] },
  { flag: "--target=<name>", help: ["cross-compile target (e.g. cortex-m3)"] },
  { flag: "--heap-size=<N>", help: ["bare-metal heap cap in bytes or k/m (e.g. 64k); default: all free RAM"] },
  { flag: "--max-stack-array=<N>", help: ["large-stack-array warning threshold, bytes or k/m (default: 512k)"] },
  { flag: "--no-entry", help: ["omit the C entry point, for a freestanding image with its own reset vector"] },
  { flag: "--emit-header", help: ["with emit-obj, also write a C header for the exported symbols"] },
  { flag: "--version", help: ["print the compiler version and exit"] },
  { flag: "--help", help: ["print this help and exit (also -h)"] },
];

/** Every command the CLI accepts, hidden ones included — a typo must still be rejected. */
export function knownCommandNames(): string[] {
  return [...COMPILER_COMMANDS, ...PACKAGE_COMMANDS].map(c => c.name);
}

const USAGE_COL = 25;

// A left column longer than the description column still gets two spaces after it,
// rather than running into the text — `--strip-panic-locations` is wider on its own.
function row(usage: string, help: string): string {
  return `  ${usage.length >= USAGE_COL - 2 ? usage + "  " : usage.padEnd(USAGE_COL - 2)}${help}`.trimEnd();
}

function renderRows(cmds: CliCommand[]): string[] {
  const out: string[] = [];
  for (const c of cmds) {
    if (c.hidden) continue;
    out.push(row(c.usage, c.summary));
    const indent = " ".repeat(USAGE_COL);
    for (const line of c.details ?? []) out.push(`${indent}${line}`.trimEnd());
    // Aligned per command, so each command's flag block reads as its own small table.
    const width = Math.max(0, ...(c.flags ?? []).map(f => f.flag.length));
    for (const f of c.flags ?? []) out.push(`${indent}  ${f.flag.padEnd(width)}  ${f.help}`);
    for (const e of c.extraRows ?? []) out.push(row(e.usage, e.help));
  }
  return out;
}

export function renderHelp(): string {
  const lines = [
    "usage: milo <command> [options] <file>",
    "commands:",
    ...renderRows(COMPILER_COMMANDS),
    "packages:",
    ...renderRows(PACKAGE_COMMANDS),
    "options:",
  ];
  for (const o of OPTIONS) {
    const [first, ...rest] = o.help;
    lines.push(row(o.flag, first ?? ""));
    for (const line of rest) lines.push(`${" ".repeat(USAGE_COL)}${line}`.trimEnd());
  }
  return lines.join("\n");
}
