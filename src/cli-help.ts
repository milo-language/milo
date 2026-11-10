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
  /** A package verb typed as `milo <verb>` rather than `milo pkg <verb>` (pkgcli's PKG_TOP_LEVEL). */
  topLevel?: true;
}

export const COMPILER_COMMANDS: CliCommand[] = [
  {
    name: "run", usage: "run <file> [args]", summary: "compile and run (no artifacts left behind)",
    flags: [
      { flag: "--record <trace>", help: "record this run to <trace> so it can be replayed exactly, e.g. to debug a failure after the fact (also MILO_RECORD=<trace>)" },
      { flag: "--replay <trace>", help: "replay a recorded run: identical to the original, even if its files, servers or clock have changed since (also MILO_REPLAY=<trace>)" },
    ],
  },
  { name: "build", usage: "build <file> [-o out]", summary: "compile to executable" },
  {
    name: "hot", usage: "hot <file> [-- args]", summary: "run and patch function bodies on every save",
    details: [
      "a body-only edit is swapped into the running program; a layout, signature",
      "or global change restarts it",
    ],
  },
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
      { flag: "--coverage <dir>", help: "build -O0 with gcov counters; every test process adds to the .gcda files under <dir> (read by milo trace --coverage)" },
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
    name: "harden", usage: "harden <file|dir>",
    summary: "rewrite into stricter Milo (index loop to for-in, match to ?, isSome to if let, last-use clone to move); prints a diff",
    details: ["an edit is kept only if the result type-checks, `milo interp` output is unchanged, and a second run finds nothing"],
    flags: [{ flag: "--write", help: "apply the rewrites in place" }],
  },
  {
    name: "emit-ast", usage: "emit-ast <file>", summary: "emit the parsed AST as JSON",
    flags: [{ flag: "--all", help: "include imported modules" }, { flag: "--spans", help: "keep source spans" }],
  },
  {
    name: "emit-mlir", usage: "emit-mlir <file>", summary: "emit the milo dialect module before milo-opt (the source-faithful top layer)",
    flags: [{ flag: "--all", help: "the whole module: imported functions, glue, scaffold" }, { flag: "--from-checked <json>", help: "skip the frontend, lower that emit-checked dump" }],
  },
  {
    name: "emit-checked", usage: "emit-checked <file>", summary: "emit the checked program (AST plus the checker's facts) as JSON",
  },
  {
    name: "interp", usage: "interp <file>", summary: "run the program in the reference interpreter (no codegen); exit 3 = unsupported, 4 = stuck",
    flags: [{ flag: "--live", help: "report live heap blocks at exit on stderr" }],
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
    summary: "prove contracts hold, via z3 (a runtime requirement: brew install z3 / apt install z3)",
    flags: [
      { flag: "--rte", help: "also prove no overflow, no out-of-bounds index, no division by zero" },
      { flag: "--dead", help: "list branches and loop bodies the solver proves can never run (unknown is not reported)" },
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
    name: "verify", usage: "verify --profile <level> <file.milo | binary>",
    summary: "check against a safety profile: a .milo source gets the profile's rules, the strict requirements matrix and prove --rte; a built binary gets its pinned build record, no allocation, no call cycles and the runtime-symbol allowlist",
    flags: [
      { flag: "--profile <level>", help: "the safety profile (milo safety --list); do178 profiles make the requirements matrix strict" },
      { flag: "--json", help: "binary: machine-readable findings" },
      { flag: "--all", help: "binary: list every finding (default: first 8 per check)" },
    ],
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
    name: "trace", usage: "trace <file>",
    summary: "a .milo entry: the requirements matrix (@req, milo prove verdicts, tests); any other file: list a record/replay trace's records",
    flags: [
      { flag: "--strict", help: "(.milo) fail on an untraced fn, a requirement with no implementation or test, an UNKNOWN or FAILED clause" },
      { flag: "--safety=<do178 profile>", help: "(.milo) same as --strict" },
      { flag: "--baseline <file>", help: "(.milo) gaps listed in <file> stay warnings under --strict; new gaps fail (write one with --write-baseline <file>)" },
      { flag: "--spec-base <git-ref>", help: "(.milo) with --strict: fail on any unsigned spec weakening since <ref> (see milo spec)" },
      { flag: "--requirements <file>", help: "(.milo) requirements.json elsewhere than next to the entry" },
      { flag: "--tests <file|dir>", help: "(.milo) where the @req tests live (default: *_test.milo beside the entry)" },
      { flag: "--json", help: "(.milo) the matrix as data; (trace file) {version, total, records: [{seq, kind, arg, payloadLen, offset}]}" },
      { flag: "--kind <prefix>", help: "only records whose kind starts with <prefix> (net., sched.)" },
      { flag: "--payload <seq>", help: "write one record's payload bytes to stdout" },
      { flag: "--coverage", help: "(.milo) run the @req tests with line counters and report covered/total lines of each fn body; with --strict an uncovered line fails (statement coverage only; needs llvm-cov)" },
      { flag: "--refinement", help: "(.milo) z3 checks the requirements' own clauses, no fn bodies: each parent ensures clause against its descendants' clauses on the same fn (REFINED, NOT REFINED with a counterexample, UNKNOWN, NOT COMPARABLE), and each fn's contract for satisfiability; with --strict, NOT REFINED and UNSAT fail (baseline keys refinement:<id>:<hash>, unsat:<fn>)" },
      { flag: "--object <binary>", help: "(.milo) add the address ranges of a binary built with -g that implement each requirement" },
    ],
  },
  {
    name: "spec", usage: "spec [--diff <git-ref> | --packet <outdir>] <entry.milo>",
    summary: "the spec lock: print the intent surface (requirements, contract clauses, invariants); --diff <ref> classifies changes since a git ref and asks z3 whether a changed clause only strengthens; --packet <outdir> writes a clean-room packet for an independent test author",
    flags: [
      { flag: "--packet <outdir>", help: "write requirements.json plus one stub .milo per source file (declarations and contracts verbatim, pub fn bodies replaced by a panic, private code and comments dropped); refuses a non-empty <outdir>" },
      { flag: "--diff <git-ref>", help: "compare with the spec at <ref>: additions and strengthenings are ok; removals, text changes, weakenings (with a z3 counterexample) and undecided changes need an entry in spec-signoff.json (id, hash, who, why); exit 1 if any is unsigned" },
      { flag: "--json", help: "the surface or the changes as data" },
    ],
  },
  {
    name: "evidence", usage: "evidence add|run|list <entry.milo> [<REQ>]",
    summary: "evidence records that satisfy a requirement's verification claims the tool cannot check (inspection, review, demonstration, a test outside the unit env); records are JSON files committed beside requirements.json, pinned to the requirement text and the implementing code",
    flags: [
      { flag: "add <entry.milo> <REQ> --method <m> --result pass|fail", help: "attest a result by hand: the tool cannot check it (recorded as attested)" },
      { flag: "run <entry.milo> <REQ> --method <m> -- <cmd> [args...]", help: "run the command, keep its output as an artifact, and set the result from its exit code (recorded as run); exits with the command's code. It captures what ran, not whether the command measures the right thing" },
      { flag: "list <entry.milo>", help: "one line per record with its state (PASS, FAILED, STALE)" },
      { flag: "--env <e>", help: "the environment of the claim (load, hil, target, ...); matched exactly against the requirement's verification entry" },
      { flag: "--measured \"<text>\"", help: "what was measured, shown in the trace (e.g. \"p95 212 ms\")" },
      { flag: "--artifact <path>", help: "(add) a file that backs the claim; its sha256 is recorded and a change makes the record stale" },
      { flag: "--note \"<text>\"", help: "free text" },
    ],
  },
  {
    name: "trace-object", usage: "trace-object <binary>",
    summary: "per function of a binary built with -g: address range -> source line -> @req, plus a MILO-O rule ID on bounds checks, overflow traps, contract checks and drops; the percentage of code that traces",
    flags: [
      { flag: "--strict", help: "fail on object code with no source line and no rule (untraced object code)" },
      { flag: "--safety=<do178 profile>", help: "same as --strict" },
      { flag: "--entry <file.milo>", help: "the source, when the binary's DWARF does not name it" },
      { flag: "--fn <name>", help: "list only this function (repeatable); the totals still cover the whole binary" },
      { flag: "--json", help: "the trace as data" },
    ],
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
  { name: "pkg", usage: "pkg <verb>", summary: "", hidden: "its verbs are listed one per row in the package section" },
  {
    name: "upgrade", usage: "upgrade | update", summary: "replace this milo binary with the newest release (deps: `pkg update`)",
    flags: [
      { flag: "--check", help: "report the newest release, change nothing" },
      { flag: "--nightly", help: "install the rolling build of main" },
      { flag: "--tag <vX.Y.Z>", help: "install a specific release" },
    ],
  },
  { name: "update", usage: "", summary: "", hidden: "synonym for `upgrade`, shares its banner row" },
  { name: "lex", usage: "lex <file>", summary: "dump the token stream as JSON", hidden: "compiler-debug output, not a user-facing command" },
];

export const PACKAGE_COMMANDS: CliCommand[] = [
  { name: "init", usage: "init | new <name>", summary: "create milo.json here / scaffold a new project", topLevel: true },
  { name: "new", usage: "", summary: "", hidden: "shares the `init | new <name>` banner row", topLevel: true },
  {
    name: "add", usage: "pkg add <pkg>", summary: "add a library dependency (milo.json + milo.lock)",
    flags: [{ flag: "--dev", help: "record it under devDeps" }],
  },
  { name: "remove", usage: "pkg remove <pkg>", summary: "drop a dependency and prune the lock" },
  {
    name: "install", usage: "pkg install", summary: "sync this project from milo.lock",
    flags: [{ flag: "--frozen", help: "fail if the lock is stale" }],
  },
  { name: "update", usage: "pkg update [pkg]", summary: "re-resolve dependency tags and rewrite the lock" },
  { name: "tree", usage: "pkg tree | pkg why <pkg>", summary: "dependency graph / who pulls a package in" },
  { name: "why", usage: "", summary: "", hidden: "shares the `pkg tree | pkg why <pkg>` banner row" },
  { name: "vendor", usage: "pkg vendor", summary: "copy deps into ./vendor and rewrite to local paths" },
  { name: "publish", usage: "pkg publish", summary: "validate, tag, push" },
  {
    name: "tool", usage: "pkg tool install <pkg>",
    summary: "build and install a global executable (~/.local/bin)",
    extraRows: [
      { usage: "pkg tool uninstall <name>", help: "remove an installed executable" },
      { usage: "pkg tool list [--repair]", help: "list installed executables (--repair: rebuild the index)" },
      { usage: "pkg tool run <pkg> [args]", help: "build and run a package's binary without installing" },
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
  { flag: "--sanitize=thread", help: ["link with ThreadSanitizer instead (requires clang)"] },
  { flag: "--static-deps", help: ["static-link native deps (openssl/sqlite) for a portable binary"] },
  { flag: "--overflow-checks", help: ["trap on +/-/* overflow at any -O (on by default in every mode)"] },
  { flag: "--no-overflow-checks", help: ["wrap on +/-/* overflow at any -O (opt out of the default traps)"] },
  { flag: "--contract-checks", help: ["assert loop invariants too at any -O (default: requires/ensures at every -O, loop invariants only at --debug)"] },
  { flag: "--no-contract-checks", help: ["drop every contract assert at any -O"] },
  { flag: "--strip-panic-locations", help: ["blank source paths out of runtime panic messages (-g still embeds them)"] },
  { flag: "--noalias", help: ["emit LLVM noalias on &mut parameters where no alias is reachable (the default)"] },
  { flag: "--no-noalias", help: ["omit LLVM noalias on &mut parameters (on by default; for ruling it out of a miscompile)"] },
  { flag: "--hot", help: ["build a hot-reload host: -O0, patchable functions, writes <out>.hot.json"] },
  { flag: "--fast", help: ["quick edit-loop build: -O0, wrapping, no contract asserts (~2x faster compile)"] },
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
  { flag: "--replay-holes", help: ["List every extern call record/replay cannot capture (warning replay-hole)"] },
  { flag: "--max-stack-array=<N>", help: ["large-stack-array warning threshold, bytes or k/m (default: 512k)"] },
  { flag: "--no-entry", help: ["omit the C entry point, for a freestanding image with its own reset vector"] },
  { flag: "--emit-header", help: ["with emit-obj, also write a C header for the exported symbols"] },
  { flag: "--version", help: ["print the compiler version and exit"] },
  { flag: "--help", help: ["print this help and exit (also -h)"] },
];

/** Every command the CLI accepts, hidden ones included — a typo must still be rejected. */
// Top-level tokens only: package verbs other than init/new are reached through `pkg`.
export function knownCommandNames(): string[] {
  return [...COMPILER_COMMANDS.map(c => c.name), ...PACKAGE_COMMANDS.filter(c => c.topLevel).map(c => c.name)];
}

const USAGE_COL = 29;

// A left column longer than the description column still gets two spaces after it,
// rather than running into the text — `--strip-panic-locations` is wider on its own.
function row(usage: string, help: string): string {
  return `  ${usage.padEnd(Math.max(USAGE_COL - 2, usage.length + 2))}${help}`.trimEnd();
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
