// The CLI surface: every subcommand and top-level option, in one table.
//
// This existed three times in main.ts — the usage banner, the KNOWN_COMMANDS set that
// rejects a typo, and the `if (cmd === ...)` dispatch chain — and they disagreed:
// `lsp`, `lex` and `verify` were dispatched but absent from the banner, and five
// implemented flags (--emit-header, --max-stack-array, --no-entry and --cycles)
// were undocumented. The banner and the known-command set are now rendered
// from here, and tests/cliHelp.test.ts holds the dispatch chain to it.
//
// Package-manager verbs live in pkgcli.ts's PKG_COMMANDS; their help text is here so
// the banner is one document, and the test checks the two agree.

import { OFF_BY_DEFAULT } from "./warnings";
interface CliCommand {
  /** The dispatch token, e.g. "emit-ir". */
  name: string;
  /** Full left column of the banner, e.g. "build <file> [-o out]". */
  usage: string;
  /** Description, then any continuation lines shown indented under it. */
  help: string[];
  /** Dispatched but deliberately absent from the banner; the string says why. */
  hidden?: string;
  /** Extra banner rows for sub-verbs and alternate forms that deserve their own left column. */
  extraRows?: { usage: string; help: string }[];
}

export const COMPILER_COMMANDS: CliCommand[] = [
  { name: "run", usage: "run <file> [args]", help: ["compile and run (no artifacts left behind)"] },
  { name: "build", usage: "build <file> [-o out]", help: ["compile to executable"] },
  {
    name: "test", usage: "test [file|dir...] [--json]",
    help: [
      "run tests (*_test.milo, recursive in a dir; cwd by default)",
      "a test is a top-level `fn test*()` with no parameters;",
      "each runs in its own process, so a trap fails only that test",
      "-t <pattern>  run only tests matching (substring or regex)",
      "              long form: --test-name-pattern <pattern>",
    ],
  },
  {
    name: "check", usage: "check <file> [--json]",
    help: ["type-check only — no codegen (--json for machine-readable diagnostics)"],
  },
  { name: "emit-ast", usage: "emit-ast <file>", help: ["emit the parsed AST as JSON (--all imports, --spans keep spans)"] },
  { name: "emit-hir", usage: "emit-hir <file>", help: ["emit the typed HIR as JSON (--all full module, --spans keep spans)"] },
  { name: "emit-ir", usage: "emit-ir <file>", help: ["emit LLVM IR"] },
  { name: "emit-obj", usage: "emit-obj <file>", help: ["compile to object file (.o)"] },
  { name: "build-lib", usage: "build-lib <files...>", help: ["compile to static library (.a)"] },
  { name: "emit-js", usage: "emit-js <file>", help: ["emit JavaScript (playground target)"] },
  { name: "fmt", usage: "fmt <file...>", help: ["format source files (-w to write in place)"] },
  {
    name: "prove", usage: "prove <file> [--json]",
    help: [
      "prove contracts hold, via std/smt, the milo-native prover",
      "  --solver=z3   use z3 instead (adds non-linear arithmetic)",
      "  --emit-smt    print the SMT-LIB2 obligations instead of solving them",
      "  --all         include imported stdlib",
    ],
  },
  {
    name: "safety", usage: "safety <file>", help: ["check safety profile compliance"],
    extraRows: [{ usage: "safety --list", help: "list available safety profiles" }],
  },
  { name: "wcet", usage: "wcet <file>", help: ["emit OTAWA flow facts (loop bounds) for WCET analysis"] },
  { name: "lsp", usage: "lsp", help: ["run the language server on stdio (what an editor launches)"] },
  { name: "skill", usage: "skill", help: ["print language guide for LLMs"] },
  {
    name: "lang", usage: "lang [--json]",
    help: [
      "the language's own vocabulary as data: keywords, primitive types,",
      "operators, builtin methods, warning names (--json for tooling)",
    ],
  },
  { name: "api", usage: "api <terms>", help: ["search std signatures by name/doc (--module std/x to dump one, --markdown to emit reference docs)"] },
  { name: "doc", usage: "doc <file|dir>", help: ["reference markdown from doc-comments (-o <dir> to write one .md per module)"] },
  { name: "lex", usage: "lex <file>", help: ["dump the token stream as JSON"], hidden: "compiler-debug output, not a user-facing command" },
];

export const PACKAGE_COMMANDS: CliCommand[] = [
  { name: "init", usage: "init | new <name>", help: ["create milo.json here / scaffold a new project"] },
  { name: "new", usage: "", help: [], hidden: "shares the `init | new <name>` banner row" },
  { name: "add", usage: "add [--dev] <pkg>", help: ["add a library dependency (milo.json + milo.lock)"] },
  { name: "remove", usage: "remove <pkg>", help: ["drop a dependency and prune the lock"] },
  { name: "install", usage: "install [--frozen]", help: ["sync this project from milo.lock (--frozen: fail if stale)"] },
  { name: "update", usage: "update [pkg]", help: ["re-resolve tags and rewrite the lock"] },
  { name: "tree", usage: "tree | why <pkg>", help: ["dependency graph / who pulls a package in"] },
  { name: "why", usage: "", help: [], hidden: "shares the `tree | why <pkg>` banner row" },
  { name: "vendor", usage: "vendor", help: ["copy deps into ./vendor and rewrite to local paths"] },
  { name: "publish", usage: "publish", help: ["validate, tag, push"] },
  {
    name: "tool", usage: "tool install <pkg>",
    help: ["build and install a global executable (~/.local/bin)"],
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
  /** Only meaningful after a particular subcommand, so it is documented there instead. */
  subcommandOnly?: string;
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
      "(api, lang, check, prove, safety, test — see docs/json-api.md)",
    ],
  },
  { flag: "--safety=<level>", help: ["enforce safety profile (e.g. --safety=do178)"] },
  { flag: "--target=<name>", help: ["cross-compile target (e.g. cortex-m3)"] },
  { flag: "--heap-size=<N>", help: ["bare-metal heap cap in bytes or k/m (e.g. 64k); default: all free RAM"] },
  { flag: "--max-stack-array=<N>", help: ["large-stack-array warning threshold, bytes or k/m (default: 512k)"] },
  { flag: "--no-entry", help: ["omit the C entry point — for a freestanding image with its own reset vector"] },
  { flag: "--emit-header", help: ["with emit-obj, also write a C header for the exported symbols"] },
  { flag: "--version", help: ["print the compiler version and exit"] },

  // Documented under their subcommand in the banner above, not in the options block.
  { flag: "--all", help: [], subcommandOnly: "emit-ast / emit-hir / prove" },
  { flag: "--spans", help: [], subcommandOnly: "emit-ast / emit-hir" },
  { flag: "--emit-smt", help: [], subcommandOnly: "prove" },
  { flag: "--solver=z3", help: [], subcommandOnly: "prove" },
  { flag: "--list", help: [], subcommandOnly: "safety" },
  { flag: "--cycles", help: [], subcommandOnly: "wcet" },
  { flag: "--markdown", help: [], subcommandOnly: "api" },
  { flag: "--module", help: [], subcommandOnly: "api" },
  { flag: "--dev", help: [], subcommandOnly: "add" },
  { flag: "--frozen", help: [], subcommandOnly: "install" },
  { flag: "--repair", help: [], subcommandOnly: "tool list" },
  { flag: "--test-name-pattern", help: [], subcommandOnly: "test (long form of -t)" },
  { flag: "--help", help: [], subcommandOnly: "every command" },
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
    const [first, ...rest] = c.help;
    out.push(row(c.usage, first ?? ""));
    for (const line of rest) out.push(`${" ".repeat(USAGE_COL)}${line}`.trimEnd());
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
    if (o.subcommandOnly) continue;
    const [first, ...rest] = o.help;
    lines.push(row(o.flag, first ?? ""));
    for (const line of rest) lines.push(`${" ".repeat(USAGE_COL)}${line}`.trimEnd());
  }
  return lines.join("\n");
}
