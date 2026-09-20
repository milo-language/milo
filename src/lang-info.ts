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
import { writeStdout } from "./stdout";

export const LANG_JSON_SCHEMA = 1;

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
    warnings: WARNINGS.map(w => ({ name: w.name, offByDefault: !!w.offByDefault })),
    // The attribute vocabulary. Absent until 2026-08-22, which is how `@thread` and
    // `@synchronized` — both safety-critical — shipped invisible to every tool outside
    // this repo, and to the language's own author.
    attributes: ATTRIBUTES.map(a => ({
      name: a.name,
      targets: a.targets,
      takesArgs: !!a.takesArgs,
      doc: a.doc,
    })),
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
    `\nfor tooling: milo lang --json\n`,
  );
  return 0;
}
