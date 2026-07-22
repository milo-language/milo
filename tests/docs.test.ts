import { test, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";

// Doc-test harness: every ```milo fence in the docs below must type-check.
// Fence info-string modes:
//   ```milo        — must parse + type-check (fragments get wrapped in fn main)
//   ```milo error  — must FAIL to parse or type-check (demonstrates a compile error)
//   ```milo skip   — not tested (pseudo-code, elided bodies, platform-specific)

const REPO_ROOT = join(import.meta.dir, "..");
const DOCS = ["docs/language-reference.md", "docs/design.md", "README.md"];

interface Snippet {
  file: string;
  line: number; // 1-based line of the opening fence
  mode: "check" | "error" | "skip";
  code: string;
}

function extractSnippets(relPath: string): Snippet[] {
  const lines = readFileSync(join(REPO_ROOT, relPath), "utf8").split("\n");
  const snippets: Snippet[] = [];
  let cur: Snippet | null = null;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```milo(?:\s+(\w+))?\s*$/);
    if (!cur && m) {
      const mode = (m[1] ?? "check") as Snippet["mode"];
      if (mode !== "check" && mode !== "error" && mode !== "skip") {
        throw new Error(`${relPath}:${i + 1}: unknown doc-test mode '${m[1]}'`);
      }
      cur = { file: relPath, line: i + 1, mode, code: "" };
      buf = [];
    } else if (cur && lines[i].startsWith("```")) {
      cur.code = buf.join("\n");
      snippets.push(cur);
      cur = null;
    } else if (cur) {
      buf.push(lines[i]);
    }
  }
  if (cur) throw new Error(`${relPath}: unterminated \`\`\`milo fence at line ${cur.line}`);
  return snippets;
}

// Brace depth must ignore braces inside strings (incl. f-string {expr}), chars, comments.
function stripLiterals(line: string): string {
  return line
    .replace(/\$?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "' '")
    .replace(/\/\/.*$/, "");
}

const ITEM_START = /^(from |import |extern |fn |struct |enum |impl |unsafe impl |trait |interface |type |@)/;
// item kinds that always have a `{...}` body — their opening brace may be on a
// later line (e.g. fn signatures with requires/ensures clauses)
const NEEDS_BODY = /^(fn |struct |enum |impl |unsafe impl |trait |interface )/;

// Fragments (no fn main) are split into top-level items and loose statements;
// statements get wrapped in a synthetic main. Doc order is preserved within each group.
function wrapSnippet(code: string): string {
  if (/^\s*fn main\(/m.test(code)) return code;
  const lines = code.split("\n");
  const items: string[] = [];
  const body: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (ITEM_START.test(line)) {
      const needsBody = NEEDS_BODY.test(line);
      let depth = 0;
      let sawBrace = false;
      do {
        const stripped = stripLiterals(lines[i]);
        if (stripped.includes("{")) sawBrace = true;
        depth += (stripped.match(/{/g) ?? []).length - (stripped.match(/}/g) ?? []).length;
        items.push(lines[i]);
        i++;
      } while (i < lines.length && (depth > 0 || (needsBody && !sawBrace)));
      // keep a blank line between items for readability in error output
      items.push("");
    } else {
      body.push(line);
      i++;
    }
  }
  if (body.every(l => l.trim() === "")) return items.join("\n");
  return items.join("\n") + "\nfn main(): i32 {\n" + body.map(l => "    " + l).join("\n") + "\n    return 0\n}\n";
}

function checkSnippet(code: string): string[] {
  const target = getHostTarget();
  let program;
  try {
    const tokens = new Lexer(code).tokenize();
    program = new Parser(tokens, code).parse();
    program = resolveImports(program, REPO_ROOT, target);
  } catch (e: any) {
    return [e.diagnostic?.message ?? e.message ?? String(e)];
  }
  const result = new TypeChecker().check(program);
  return result.diagnostics.filter(d => d.severity === "error").map(d => `${d.message} (line ${d.span?.line})`);
}

for (const doc of DOCS) {
  describe(doc, () => {
    for (const s of extractSnippets(doc)) {
      const name = `${doc}:${s.line}`;
      if (s.mode === "skip") {
        test.skip(name, () => {});
        continue;
      }
      test(name, () => {
        const wrapped = wrapSnippet(s.code);
        const errors = checkSnippet(wrapped);
        if (s.mode === "error") {
          if (errors.length === 0) {
            throw new Error(`expected a compile error, but snippet type-checked:\n${wrapped}`);
          }
        } else if (errors.length > 0) {
          throw new Error(`doc snippet failed to compile:\n${errors.join("\n")}\n--- wrapped source ---\n${wrapped}`);
        }
      });
    }
  });
}
