import { test, describe, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
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
import { readdirSync } from "fs";

// Every page of the docs site, minus the ones whose snippets do not compile yet.
//
// This list is a RATCHET, dated 2026-08-15: a page may only be REMOVED from it. A new
// site page is snippet-checked from the moment it lands, and "the page still fails"
// below fails the build if a listed page starts passing, so the list cannot quietly
// keep a page excluded after someone fixes it.
//
// Before the harness learned to read signature listings, carry a page's imports
// forward, and reconstruct `fn Type.method` / bare-`self` heads, 471 of 859 site
// snippets failed; those three rules account for the difference. What is left is real:
// snippets with elided `...` bodies, undeclared variables, and APIs the page describes
// but the stdlib does not have.
const SNIPPETS_NOT_YET_CHECKED = new Set([
  "docs/site/features/ffi.md",
  "docs/site/language/ownership.md",
  "docs/site/language/variables.md",
  "docs/site/language/warnings-and-errors.md",
  "docs/site/packages.md",
  "docs/site/stdlib/arena.md",
  "docs/site/stdlib/argparse.md",
  "docs/site/stdlib/args.md",
  "docs/site/stdlib/binary.md",
  "docs/site/stdlib/crypto.md",
  "docs/site/stdlib/csv.md",
  "docs/site/stdlib/env.md",
  "docs/site/stdlib/fmt.md",
  "docs/site/stdlib/hkdf.md",
  "docs/site/stdlib/http.md",
  "docs/site/stdlib/inflate.md",
  "docs/site/stdlib/json.md",
  "docs/site/stdlib/jwt.md",
  "docs/site/stdlib/log.md",
  "docs/site/stdlib/mime.md",
  "docs/site/stdlib/multipart.md",
  "docs/site/stdlib/pbkdf2.md",
  "docs/site/stdlib/process.md",
  "docs/site/stdlib/regex.md",
  "docs/site/stdlib/set.md",
  "docs/site/stdlib/signal.md",
  "docs/site/stdlib/subtle.md",
  "docs/site/stdlib/sync.md",
  "docs/site/stdlib/time.md",
  "docs/site/stdlib/timer.md",
  "docs/site/stdlib/totp.md",
  "docs/site/stdlib/url.md",
]);

const siteDocs: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".vitepress") continue;
    const p2 = join(d, e.name);
    if (e.isDirectory()) walk(p2);
    else if (e.name.endsWith(".md")) siteDocs.push(p2.slice(REPO_ROOT.length + 1));
  }
})(join(REPO_ROOT, "docs/site"));

const DOCS = [
  "docs/language-reference.md", "docs/design.md", "README.md",
  ...siteDocs.filter(d => !SNIPPETS_NOT_YET_CHECKED.has(d)).sort(),
];

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
    // A trailing `[Label]` is VitePress code-group tab text, not a doc-test mode. Without
    // this the label made the fence stop matching, and a labelled snippet silently left the
    // gate — the page would look checked and not be.
    const m = lines[i].match(/^```milo(?:\s+(\w+))?(?:\s+\[[^\]]+\])?\s*$/);
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
  // trimEnd() before the comment strip: `.` does not match a line terminator, so on a
  // CRLF checkout `//.*$` matches nothing and a trailing comment survives — and a `{`
  // inside one would then be counted as a real brace.
  return line
    .trimEnd()
    .replace(/\$?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "' '")
    .replace(/\/\/.*$/, "");
}

const ITEM_START = /^(pub )?(from |import |extern |fn |struct |enum |impl |unsafe impl |trait |interface |type |derive |@)/;
// item kinds that always have a `{...}` body — their opening brace may be on a
// later line (e.g. fn signatures with requires/ensures clauses)
const NEEDS_BODY = /^(pub )?(fn |struct |enum |impl |unsafe impl |trait |interface |derive )/;

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
      // A struct's `invariant` clauses sit AFTER its closing brace, so the brace-depth
      // loop above has already stopped. Without this they read as loose statements and get
      // wrapped into a synthetic main, where they are a parse error — the snippet would
      // have to be marked `skip`, i.e. never checked at all.
      while (i < lines.length && /^\s*(invariant|decreases)\b/.test(lines[i])) {
        items.push(lines[i]);
        i++;
      }
      // keep a blank line between items for readability in error output
      items.push("");
    } else if (line.trim().startsWith("//")) {
      // A top-level comment is not a loose statement. Left in `body` it made the snippet
      // look like it had statements to wrap, so a fence that already declared `fn main`
      // got a second one synthesised around it and failed with "defined twice". Comments
      // carry no semantics, so hoisting them beside the items is always safe.
      items.push(line);
      i++;
    } else {
      body.push(line);
      i++;
    }
  }
  if (body.every(l => l.trim() === "")) return items.join("\n");
  return items.join("\n") + "\nfn main(): i32 {\n" + body.map(l => "    " + l).join("\n") + "\n    return 0\n}\n";
}

// A reference listing: bodyless declaration heads, one per line, as every stdlib page
// prints its API. `fn eventPoll(el: &EventLoop, fd: i32): i32` is not a program and can
// never type-check, but it is also the most drift-prone text on the site — a renamed
// parameter or a changed return type shows up here first. Detected rather than marked
// so no markdown had to be edited: a fence qualifies only if EVERY line is a head.
const DECL_HEAD = /^\s*(pub\s+)?(fn|struct|enum|trait|interface|type|extern)\b/;

function isSignatureListing(code: string): boolean {
  const lines = code.split("\n").filter(l => l.trim() !== "" && !l.trim().startsWith("//"));
  if (lines.length === 0) return false;
  return lines.every(l => DECL_HEAD.test(l) && !l.includes("{") && !l.includes("}"));
}

// Each head must parse. A body is appended so the parser sees a complete item; the
// point is the signature's syntax, not what it would do.
function checkSignatureListing(code: string): string[] {
  const errs: string[] = [];
  for (const raw of code.split("\n")) {
    // A trailing `// also Be` annotates the signature; leaving it on would swallow the
    // synthetic body that follows. trim() runs FIRST: on a CRLF checkout the line ends
    // in `\r`, and `.` does not match a line terminator, so `//.*$` matched nothing and
    // the comment survived — a Windows-only parse failure.
    const line = raw.trim().replace(/\s*\/\/.*$/, "").trim();
    if (line === "" || raw.trim().startsWith("//")) continue;
    // `extern fn`/`extern type` and `type` aliases are complete as written; giving
    // them a body is itself a parse error.
    const bodyless = /^(pub\s+)?(extern\b|type\b)/.test(line);
    // `fn Uuid.v4(): Uuid` is how every stdlib page prints a method or namespace
    // static — the same form `milo api` emits. The language declares it inside an
    // `impl`, so reconstruct that rather than rejecting the whole convention.
    const method = /^(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\./.exec(line);
    // A bare `self` receiver — `fn asBool(self): Option<bool>` under a type's Methods
    // heading — names no type, because the heading already did. Give it a stand-in so
    // the parameters and return type still get parsed; only the receiver goes
    // unchecked, which is precisely what the page chose to abbreviate.
    const SELF = "_DocReceiver";
    const selfTyped = line.replace(/\(\s*self\s*([,)])/, `(self: &${SELF}$1`);
    const owner = method?.[1] ?? (selfTyped !== line ? SELF : null);
    const withBody = bodyless ? line
      : owner ? `struct ${SELF} { }\nimpl ${owner} {\n  ${selfTyped.replace(/^(pub\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*\./, "fn ")} { }\n}`
      : `${selfTyped} { }`;
    try {
      const tokens = new Lexer(withBody).tokenize();
      new Parser(tokens, withBody).parse();
    } catch (e: any) {
      errs.push(`${e.diagnostic?.message ?? e.message ?? String(e)} — in signature line: ${line}`);
    }
  }
  return errs;
}

// Whole `from "x" import { .. }` statements, flattened to one line each. The block form
// spans lines, so a line-wise scan would carry only its first line.
function importStatements(code: string): string[] {
  const out: string[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*from\s+"[^"]+"\s+import\b/.test(lines[i]!)) continue;
    let stmt = lines[i]!.trim();
    while (!stmt.includes("}") && !/import\s+\w+\s*$/.test(stmt) && i + 1 < lines.length) {
      stmt += " " + lines[++i]!.trim();
    }
    out.push(stmt.replace(/\s+/g, " "));
  }
  return out;
}

function checkSnippet(code: string): string[] {
  if (isSignatureListing(code)) return checkSignatureListing(code);
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

// A stdlib page opens with its import fence and every later example assumes it, the
// way a reader does. Each fence is checked on its own, so without this the whole page
// reads as undefined-function errors. Imports accumulate down the page in order; a
// snippet that imports the same module itself wins, and nothing is prepended to a
// fence that is only a signature listing.
const IMPORT_LINE = /^\s*from\s+"([^"]+)"\s+import\b/;

function modulesImportedBy(code: string): Set<string> {
  const mods = new Set<string>();
  for (const line of code.split("\n")) {
    const m = IMPORT_LINE.exec(line);
    if (m) mods.add(m[1]!);
  }
  return mods;
}

// Only a real module is carried. docs/site/language/modules.md teaches with an
// invented `from "lib/math" import ..`, and carrying that made every later fence on the
// page fail to resolve — 58 snippets reported as broken by one illustrative line.
function moduleExists(mod: string): boolean {
  if (!mod.startsWith("std/")) return false;
  const stem = mod.slice("std/".length);
  return ["", ".darwin", ".linux", ".windows"].some(arm =>
    existsSync(join(REPO_ROOT, "std", `${stem}${arm}.milo`)));
}

function withPageImports(code: string, carried: string[]): string {
  if (isSignatureListing(code)) return code;
  const own = modulesImportedBy(code);
  const add = carried.filter(l => !own.has(IMPORT_LINE.exec(l)![1]!));
  return add.length === 0 ? code : add.join("\n") + "\n" + code;
}

interface Checked { snippet: Snippet; wrapped: string; errors: string[] }

// One pass over a page, carrying its imports forward in document order. Both the gate
// and the ratchet below go through here, so they cannot disagree about whether a page
// compiles — the ratchet skipping the import carry made 33 pages look already-fixed.
function checkDoc(doc: string): Checked[] {
  // Only the site pages carry imports. A site page opens with its import fence and every
  // later example assumes it; docs/language-reference.md and docs/design.md are the
  // opposite — independent examples, where carrying `std/net` into an FFI snippet made
  // its illustrative `extern struct SockAddrIn` collide with std/platform's real one.
  const carriesImports = doc.startsWith("docs/site/");
  const carried: string[] = [];
  const out: Checked[] = [];
  for (const snippet of extractSnippets(doc)) {
    const carriedNow = [...carried];
    // Multi-line import blocks are joined so a carried import is one self-contained line.
    if (carriesImports) {
      for (const stmt of importStatements(snippet.code)) {
        const mod = IMPORT_LINE.exec(stmt)![1]!;
        if (!moduleExists(mod)) continue;
        if (!carried.some(c => IMPORT_LINE.exec(c)![1] === mod)) carried.push(stmt);
      }
    }
    if (snippet.mode === "skip") { out.push({ snippet, wrapped: "", errors: [] }); continue; }
    const wrapped = wrapSnippet(withPageImports(snippet.code, carriedNow));
    out.push({ snippet, wrapped, errors: checkSnippet(wrapped) });
  }
  return out;
}

function docFails(doc: string): boolean {
  return checkDoc(doc).some(c =>
    c.snippet.mode === "skip" ? false
    : c.snippet.mode === "error" ? c.errors.length === 0
    : c.errors.length > 0);
}

for (const doc of DOCS) {
  describe(doc, () => {
    for (const c of checkDoc(doc)) {
      const name = `${doc}:${c.snippet.line}`;
      // Reported as skipped rather than omitted so the count stays visible.
      if (c.snippet.mode === "skip") { test.skip(name, () => {}); continue; } // fence says ```milo skip: pseudo-code, elided body, or platform-specific
      test(name, () => {
        if (c.snippet.mode === "error") {
          if (c.errors.length === 0) {
            throw new Error(`expected a compile error, but snippet type-checked:\n${c.wrapped}`);
          }
        } else if (c.errors.length > 0) {
          throw new Error(`doc snippet failed to compile:\n${c.errors.join("\n")}\n--- wrapped source ---\n${c.wrapped}`);
        }
      });
    }
  });
}

// The ratchet may only shrink. A page that starts compiling must come off the list, or
// the exclusion silently outlives the problem it was added for.
describe("snippet ratchet", () => {
  test("the site walk actually found pages to check", () => {
    // Without this the suite passes with DOCS holding only the three original files:
    // a broken directory walk would read as "every site page compiles".
    expect(siteDocs.length).toBeGreaterThan(80);
    expect(DOCS.filter(d => d.startsWith("docs/site/")).length).toBeGreaterThan(20);
  });

  test("every excluded page exists", () => {
    for (const doc of SNIPPETS_NOT_YET_CHECKED) {
      expect(`${doc}: ${existsSync(join(REPO_ROOT, doc)) ? "found" : "missing"}`).toBe(`${doc}: found`);
    }
  });

  for (const doc of [...SNIPPETS_NOT_YET_CHECKED].sort()) {
    test(`${doc} still fails — remove it from the ratchet if not`, () => {
      expect(`${doc}: ${docFails(doc) ? "still failing" : "PASSES NOW"}`).toBe(`${doc}: still failing`);
    });
  }
});
