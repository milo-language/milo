// Gate on src/cli-help.ts, the single source for the CLI surface.
//
// The banner, the KNOWN_COMMANDS typo guard, and the `if (cmd === ...)` dispatch chain
// were three hand-maintained lists in main.ts. They disagreed: `lsp`, `lex` and
// `verify` were dispatched with no banner row, and four implemented flags had no help
// line at all. The banner and the known-command set are rendered from the table now;
// what these tests cover is the two things that still cannot be: the dispatch chain in
// main.ts, and PKG_COMMANDS in pkgcli.ts.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { COMPILER_COMMANDS, PACKAGE_COMMANDS, OPTIONS, knownCommandNames, renderHelp } from "../src/cli-help";
import { PKG_COMMANDS } from "../src/pkgcli";

const ROOT = join(import.meta.dir, "..");
const MAIN = readFileSync(join(ROOT, "src", "main.ts"), "utf-8");

test("every dispatched subcommand has a table entry, and every entry is dispatched", () => {
  const dispatched = new Set<string>();
  // A subcommand starts with a letter; `cmd === "--help"` is a flag handled before the
  // dispatch chain and is not a table row.
  for (const m of MAIN.matchAll(/cmd === "([a-z][a-z-]*)"/g)) dispatched.add(m[1]!);
  expect(dispatched.size).toBeGreaterThan(10); // the scan must actually find the chain

  const tabled = new Set(COMPILER_COMMANDS.map(c => c.name));
  expect([...dispatched].filter(c => !tabled.has(c)).sort()).toEqual([]);
  // The reverse: a table row for a command main.ts no longer handles would print a
  // banner line for something that errors as an unknown command.
  expect([...tabled].filter(c => !dispatched.has(c)).sort()).toEqual([]);
});

test("the package verbs in the table are exactly PKG_COMMANDS", () => {
  expect(PACKAGE_COMMANDS.map(c => c.name).sort()).toEqual([...PKG_COMMANDS].sort());
});

test("knownCommandNames covers both groups, hidden commands included", () => {
  // `lex` is hidden from the banner but must still be accepted, or the
  // unknown-command guard would reject a command the dispatch chain handles.
  const known = knownCommandNames();
  for (const name of ["lex", "lsp", "run", "install", "tool"]) expect(known).toContain(name);
});

test("every flag main.ts parses is documented, and no documented flag is unparsed", () => {
  const parsed = new Set<string>();
  // parseArgs matches flags as whole strings or as `--name=` prefixes.
  for (const m of MAIN.matchAll(/args\[i\] === "(--[a-z-]+)"/g)) parsed.add(m[1]!);
  for (const m of MAIN.matchAll(/startsWith\("(--[a-z-]+)="\)/g)) parsed.add(m[1]!);
  // Subcommand-scoped flags are read off the residual arg list instead.
  for (const m of MAIN.matchAll(/rest\.includes\("(--[a-z-]+)"\)/g)) parsed.add(m[1]!);
  expect(parsed.size).toBeGreaterThan(10);

  // A table flag is written as it is typed (`--target=<name>`); match on the name.
  const documented = new Set(OPTIONS.map(o => /^(--[a-z-]+)/.exec(o.flag)?.[1]).filter(Boolean) as string[]);
  const undocumented = [...parsed].filter(f => !documented.has(f)).sort();
  expect(undocumented).toEqual([]);
});

test("--help and -h print the banner and exit 0", () => {
  for (const flag of ["--help", "-h"]) {
    const out = execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), flag], { cwd: ROOT, encoding: "utf-8" });
    expect(out).toContain("usage: milo <command>");
    expect(out).toContain("run <file> [args]");
  }
}, 60000);

test("the rendered banner lists every non-hidden command exactly once", () => {
  const help = renderHelp();
  for (const c of [...COMPILER_COMMANDS, ...PACKAGE_COMMANDS]) {
    if (c.hidden) {
      expect(c.usage === "" || !help.includes(`  ${c.usage} `)).toBe(true);
      continue;
    }
    const occurrences = help.split("\n").filter(l => l.startsWith(`  ${c.usage}`)).length;
    expect(`${c.name}: ${occurrences}`).toBe(`${c.name}: 1`);
  }
});

test("no banner row runs its description into the left column", () => {
  // `--strip-panic-locations` is exactly as wide as the description column; a padEnd
  // that stops at the column width leaves zero spaces and glues the two together.
  const help = renderHelp();
  const rows = [
    ...[...COMPILER_COMMANDS, ...PACKAGE_COMMANDS].flatMap(c =>
      c.hidden ? [] : [{ left: c.usage, described: c.help.length > 0 }, ...(c.extraRows ?? []).map(e => ({ left: e.usage, described: true }))]),
    ...OPTIONS.filter(o => !o.subcommandOnly).map(o => ({ left: o.flag, described: o.help.length > 0 })),
  ];
  expect(rows.length).toBeGreaterThan(30);
  for (const r of rows) {
    if (!r.described) continue;
    const line = help.split("\n").find(l => l.startsWith(`  ${r.left}`));
    expect(`${r.left}: ${line === undefined ? "missing" : "present"}`).toBe(`${r.left}: present`);
    expect(`${r.left}: ${line!.startsWith(`  ${r.left}  `) ? "gapped" : "glued"}`).toBe(`${r.left}: gapped`);
  }
});
