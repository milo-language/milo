// Shared doc-snippet checker: wraps a ```milo fence into a program and type-checks it.
// Used by tests/docs.test.ts (the docs pages) and tests/skillText.test.ts (`milo skill`).
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";

const REPO_ROOT = join(import.meta.dir, "..");

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
export function wrapSnippet(code: string): string {
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

export function isSignatureListing(code: string): boolean {
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
export function importStatements(code: string): string[] {
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

export function checkSnippet(code: string): string[] {
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
