// `milo lang [--json]` — the language's own vocabulary, as data.
//
// Keywords, primitive type names, operator tokens, the builtin method surface and the
// warning names all live in exactly one place in src/ each. Anything OUTSIDE this repo
// that needs them — a tree-sitter grammar, a Neovim or Zed plugin, a Pygments lexer, the
// docs site's syntax highlighting, a third-party linter — cannot import TypeScript from
// the compiler, so historically it copied the list by hand and the copy rotted. The
// docs-site grammar shipped `char`, `String` and `Box` (none exist) and missed `unsafe`,
// `trait` and `from` for months, because copying was the only option available to it.
//
// This is a PUBLIC surface: bump `schema` on a breaking change. tests/langInfo.test.ts
// pins the shape and holds every list to the compiler data it is derived from.
import { KEYWORDS, SOFT_KEYWORDS, TokenKind } from "./tokens";
import { KEYWORD_DOCS } from "./keyword-docs";
import { PRIMITIVE_TYPE_NAMES } from "./types";
import { BUILTIN_MEMBERS } from "./builtin-members";
import { WARNINGS } from "./warnings";
import { ATTRIBUTES } from "./attributes";
import { COMPILER_COMMANDS, PACKAGE_COMMANDS, OPTIONS } from "./cli-help";
import { writeStdout } from "./stdout";

// 2: each warning carries `doc`/`fix`/`example` — the published reference is rendered
// from this payload instead of being retyped on the site.
export const LANG_JSON_SCHEMA = 2;

export function langInfo() {
  // TokenKind's members are keywords, literal classes (INT, IDENT, …) and symbols. Only
  // the symbols are interesting here: the keywords are already listed, and a literal
  // class is a lexer concept with no spelling.
  const symbols: Record<string, string> = {};
  for (const [member, value] of Object.entries(TokenKind)) {
    if (/^[A-Za-z_]/.test(value) || value === "EOF") continue;
    symbols[member] = value;
  }

  const builtinMembers: Record<string, { name: string; signature: string; note?: string }[]> = {};
  for (const [receiver, members] of Object.entries(BUILTIN_MEMBERS)) {
    builtinMembers[receiver] = members.map(m => ({
      name: m.name,
      // `sig` is what follows the name: "(needle: string): bool", or ": i64" for a
      // property-shaped member like `len`.
      signature: m.sig,
      ...(m.note ? { note: m.note } : {}),
    }));
  }

  return {
    schema: LANG_JSON_SCHEMA,
    keywords: [...KEYWORDS].sort(),
    // Reserved only where the grammar expects them; legal identifiers everywhere else,
    // which a highlighter has to know or it paints every `from` in a program.
    softKeywords: [...SOFT_KEYWORDS].sort(),
    // Markdown help for each keyword, so an editor plugin outside this repo can show
    // the same hover the bundled LSP does instead of writing its own from the guide.
    keywordDocs: Object.fromEntries([...KEYWORDS, ...SOFT_KEYWORDS].sort().map(k => [k, KEYWORD_DOCS[k]])),
    primitiveTypes: [...PRIMITIVE_TYPE_NAMES].sort(),
    symbols,
    builtinMembers,
    // `doc`/`fix`/`example` are present once a warning's reference entry is written; the
    // site page is generated from them, so a consumer gets the same text the docs publish.
    warnings: WARNINGS.map(w => ({
      name: w.name,
      offByDefault: !!w.offByDefault,
      ...(w.doc ? { doc: w.doc } : {}),
      ...(w.fix ? { fix: w.fix } : {}),
      ...(w.example ? { example: w.example } : {}),
    })),
    // The attribute vocabulary. Absent until 2026-08-22, which is how `@thread` and
    // `@synchronized` — both safety-critical — shipped invisible to every tool outside
    // this repo, and to the language's own author.
    attributes: ATTRIBUTES.map(a => ({
      name: a.name,
      targets: a.targets,
      takesArgs: !!a.takesArgs,
      doc: a.doc,
    })),
    // The CLI surface, projected from the table `milo --help` renders, so the site's
    // command reference and the banner are one list. Hidden commands are included (with
    // the reason) because they are still accepted: a wrapper must not reject `lex`.
    commands: [
      ...COMPILER_COMMANDS.map(c => ({ c, group: "compiler" })),
      ...PACKAGE_COMMANDS.map(c => ({ c, group: "package" })),
    ].map(({ c, group }) => ({
      name: c.name,
      group,
      usage: c.usage,
      summary: c.summary,
      ...(c.details ? { details: c.details.join(" ") } : {}),
      ...(c.flags ? { flags: c.flags.map(f => ({ flag: f.flag, help: f.help })) } : {}),
      ...(c.extraRows ? { forms: c.extraRows.map(e => ({ usage: e.usage, summary: e.help })) } : {}),
      ...(c.hidden ? { hidden: c.hidden } : {}),
    })),
    // Options every compiling command accepts; per-command flags are on `commands[].flags`.
    cliOptions: OPTIONS.map(o => ({ flag: o.flag, help: o.help.join(" ") })),
  };
}

export function runLangInfo(args: string[]): number {
  const info = langInfo();
  if (args.includes("--json")) {
    writeStdout(JSON.stringify(info, null, 2) + "\n");
    return 0;
  }
  const receivers = Object.entries(info.builtinMembers).map(([r, m]) => `${r} (${m.length})`);
  writeStdout(
    `keywords        ${info.keywords.join(" ")}\n` +
    `soft keywords   ${info.softKeywords.join(" ")}\n` +
    `keyword docs    ${Object.keys(info.keywordDocs).length} entries (markdown; --json only)\n` +
    `primitive types ${info.primitiveTypes.join(" ")}\n` +
    `symbols         ${Object.values(info.symbols).join(" ")}\n` +
    `builtin methods ${receivers.join(", ")}\n` +
    `warnings        ${info.warnings.map(w => w.name + (w.offByDefault ? "*" : "")).join(" ")}   (* off by default)\n` +
    `commands        ${info.commands.filter(c => !c.hidden).map(c => c.name).join(" ")}\n` +
    `\nfor tooling: milo lang --json\n`,
  );
  return 0;
}

/** Levenshtein distance, for "did you mean" on a misspelled name. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * `milo explain <name>` — the reference entry for one warning, attribute or keyword,
 * rendered to the terminal from the same data the docs site and the LSP are rendered from.
 *
 * A warning the compiler reports names nothing a user can look up: the diagnostic prints a
 * message, not a code, so "what is index-clone and how do I silence it" had no answer at
 * the terminal even though the text exists in three other places.
 */
export function explainText(query: string, json = false): string | undefined {
  const info = langInfo();
  const name = query.replace(/^@/, "");
  const warning = info.warnings.find(w => w.name === name);
  const attribute = info.attributes.find(a => a.name === name);
  const keywordDoc = info.keywordDocs[name];
  if (!warning && !attribute && !keywordDoc) return undefined;
  if (json) return JSON.stringify(warning ?? attribute ?? { name, doc: keywordDoc }, null, 2) + "\n";
  if (warning) {
    return `warning: ${warning.name}${warning.offByDefault ? "   (off by default)" : ""}\n\n` +
      (warning.doc ? `${warning.doc}\n\n` : "no reference entry yet\n\n") +
      (warning.example ? `example:\n${warning.example.replace(/^(?!$)/gm, "  ")}\n` : "") +
      (warning.fix ? `fix: ${warning.fix}\n\n` : "") +
      `silence it: --allow=${warning.name}   enforce it: --deny=${warning.name}\n`;
  }
  if (attribute) {
    return `attribute: @${attribute.name}${attribute.takesArgs ? "(…)" : ""}\n` +
      `goes on: ${attribute.targets.join(", ")}\n\n${attribute.doc}\n`;
  }
  return `keyword: ${name}\n\n${keywordDoc}\n`;
}

/** Names `explain` answers to, for the "did you mean" list and for tests. */
export function explainableNames(): string[] {
  const info = langInfo();
  return [...info.warnings.map(w => w.name), ...info.attributes.map(a => `@${a.name}`), ...Object.keys(info.keywordDocs)];
}

export function runExplain(args: string[]): number {
  const query = args.find(a => !a.startsWith("-"));
  if (!query) {
    writeStdout("usage: milo explain <warning|@attribute|keyword>   (milo lang lists them all)\n");
    return 1;
  }
  const text = explainText(query, args.includes("--json"));
  if (text) {
    writeStdout(text);
    return 0;
  }
  // A near-miss is the common case (`--deny=unused-varibale` was the bug that started all
  // of this), so spend the extra line on candidates rather than a bare refusal. Edit
  // distance, not substring: that typo shares no useful substring with `unused-variable`,
  // and substring matching answered it with `var`.
  const name = query.replace(/^@/, "");
  const near = explainableNames()
    .map(n => ({ n, d: distance(name, n.replace(/^@/, "")) }))
    .filter(c => c.d <= Math.max(2, Math.floor(name.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map(c => c.n);
  writeStdout(`no warning, attribute or keyword named '${query}'\n` +
    (near.length ? `did you mean: ${near.join(", ")}?\n` : "run 'milo lang' to see every name\n"));
  return 1;
}
