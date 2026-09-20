<!-- doc-meta
system: tooling-api
purpose: the compiler's machine-readable surfaces — what tooling reads instead of importing TypeScript
key-files: src/api-search.ts, src/lang-info.ts, src/warnings.ts, src/main.ts (runCheck), tests/apiJson.test.ts, tests/langInfo.test.ts
update-when: a JSON payload gains or loses a field, or a new machine-readable command lands
last-verified: 2026-09-20 (warnings gain errorByDefault)
-->

# Machine-readable compiler API

Everything the compiler knows about the language and the standard library is available as
JSON on stdout. Tooling reads *that* — never `import { … } from "../src/…"`.

```bash
milo api --json                      # every public std symbol: signature, params, return, doc, struct fields
milo api --module std/json --json    # one module
milo api "parse json" --json         # ranked search results
milo lang --json                     # keywords (+ hover docs), primitive types, operators, builtin methods, warning names
milo check <file> --json             # diagnostics as data (exit 1 if any error)
milo prove <file> --json             # per-obligation proof verdicts
milo safety <file> --safety=X --json # safety-profile compliance
milo test <dir> --json               # per-test records
milo emit-ast <file> [--all --spans] # parsed AST
milo emit-hir <file> [--all --spans] # typed HIR — every expression carries its type
milo lex <file>                      # token stream
```

## Why this exists

**Nothing may depend on the host language.** The compiler is TypeScript today; the
roadmap has it in Rust or in Milo eventually. Every tool that reaches into `src/*.ts` is a
tool that has to be rewritten on that day — and a tool nobody outside this repository could
have written in the first place. A JSON payload is a contract that survives the rewrite:
whatever language the compiler is written in next has to produce the same bytes, which
turns the existing tooling into a conformance suite for it.

**Copying is the alternative, and copies rot silently.** Before `milo lang --json`, anyone
outside `src/` who needed the keyword list had exactly one option: retype it. The docs
site did, and shipped a syntax grammar highlighting `char`, `String` and `Box` — none of
which exist in Milo — while missing `unsafe`, `trait`, `interface` and `from`, for months,
with no test able to notice. See **Generate it, don't restate it** in
[AGENTS.md](../AGENTS.md).

**It is the surface an agent should use.** `milo api --json` answers "does
`FetchResponse.header` exist and what does it return" with a fact. That question, asked
cheaply, is what would have prevented the 110 wrong signatures the stdlib doc pages
published.

## What each payload carries

### `milo api --json` (schema 1)

```json
{
  "schema": 1,
  "entries": [
    {
      "kind": "function",
      "module": "std/json",
      "name": "Json.get",
      "signature": "fn Json.get(self: &Json, key: &string): Option<Json>",
      "params": [{ "name": "self", "type": "&Json" }, { "name": "key", "type": "&string" }],
      "returns": "Option<Json>",
      "doc": "Look up an object key.",
      "docFull": "Look up an object key.\nReturns a view, not a copy."
    },
    {
      "kind": "type",
      "module": "std/json",
      "name": "Json",
      "signature": "pub struct Json",
      "fields": [{ "name": "source", "type": "string" }, { "name": "root", "type": "i64" }]
    }
  ]
}
```

`params` is split on **top-level** commas by the compiler, so a consumer never has to scan
`HashMap<string, i64>` or `(&Request, i64) => Response` itself. `returns` is `"void"` when
the signature has no return type. Struct `fields` mean a consumer never re-reads
`std/*.milo` to answer "does this type have that field".

Works on any package, not just std: the same extractor backs `milo doc <file|dir>`.

### `milo lang --json` (schema 1)

`keywords`, `softKeywords` (contextual — legal identifiers elsewhere, which a highlighter
must know), `keywordDocs` (keyword → markdown help: the form in a fenced `milo` block,
then what it means — the same text the bundled LSP shows on hover, so an editor plugin
need not rewrite it from the guide), `primitiveTypes`, `symbols` (operator token name →
spelling), `builtinMembers` (receiver → the methods the checker dispatches by hand, with
signatures and caveats), and `warnings` (name + `offByDefault` + `errorByDefault`, i.e. what `--deny=` and `--allow=` accept).

### `milo check <file> --json` (schema 1)

```json
{ "schema": 1, "file": "a.milo", "ok": false,
  "diagnostics": [{ "severity": "error", "message": "...", "hint": "...",
                    "file": "a.milo", "line": 14, "col": 16, "len": 1 }] }
```

A parse error is reported in the same shape as a type error — a consumer should not have
to distinguish "crashed" from "rejected". Exit code is 1 when any diagnostic is an error.
`code` is present only where the diagnostic carries one; most do not yet, so classify on
`code` when you can and treat its absence as "uncoded", not as a shape change.

### `milo prove --json` (schema 1)

`proven` / `failed` / `unknown` / `errors` counts, `ok` (no failures and no errors), and an
`obligations` array of `{ fn, kind, description, status, detail?, assumes?, assumesInvariants? }`.
**`unknown` is not `failed`** — the prover could not decide, which is a different fact
about the program, and a consumer that collapses the two reports an undecided proof as a
broken one. The SMT-LIB text is deliberately absent: it is large and it is a translator
detail; `prove --emit-smt` prints it for anyone who wants it.

### `milo safety --json` (schema 1)

`{ schema, level, file, ok, violations: [{ rule, severity, message, file, line, col }] }`.
This is the output a certification artifact quotes, so it is records, not a rendered report.

### `milo test --json` (schema 1)

`{ schema, ok, passed, failed, compileErrors, filteredOut, durationMs, tests: [{ file, name, ok, ms, output? }] }`.
`compileErrors` is separate from `failed` on purpose: a file that would not compile ran no
tests at all — counting it as one failed test understates it, and dropping it makes a
broken suite look green. In `--json` mode nothing but the document reaches stdout.

## Rules for these surfaces

- **Schema is versioned.** Bump `schema` on a breaking change; additive fields do not
  need one. Consumers should ignore unknown fields.
- **Gated, not asserted.** `tests/apiJson.test.ts` and `tests/langInfo.test.ts` pin the
  shape *and* hold every list to the compiler data it derives from — a payload that
  silently emptied would otherwise pass every subset check.
- **One source per fact.** The payload is projected from the same constant the compiler
  itself uses (`src/tokens.ts`, `src/builtin-members.ts`, `src/warnings.ts`). Never a
  second hand-written table.
- **Write to stdout synchronously.** Use `writeStdout` from `src/stdout.ts`.
  `process.stdout.write()` to a pipe is async and `process.exit()` does not drain it:
  `milo api --json` silently lost its last 6 KB that way — perfect on a terminal, invalid
  JSON through `execFileSync`.
- **Add a surface with a consumer, not before.** A speculative `--json` rots faster than
  a doc.

## Who consumes them

| consumer | reads | why not import |
|---|---|---|
| `scripts/check-api-docs.ts` | `api --json`, `lang --json` | the question ("do these docs match the language") is one any package should be able to ask |
| `scripts/gen-tmlanguage.ts` | `lang --json` | an editor grammar is the canonical out-of-repo consumer; using the same door keeps it working |
| editors / tree-sitter / highlighters | `lang --json` | cannot import TypeScript at all |
| package tooling, doc sites | `api --json` | works on any package, not just std |
| CI annotations, non-LSP editors | `check --json` | the alternative is parsing Elm-style terminal output |
| CI dashboards, flake trackers | `test --json` | the ✓/✗ log lines were never a contract |
| certification workflows | `prove --json`, `safety --json` | a proof verdict per obligation is the artifact, not a table |

Three things still import the compiler on purpose:

- **The fuzzers** (`scripts/fuzz-*.ts`) drive `Lexer`/`Parser`/`TypeChecker` in-process
  because they run millions of mutants; a subprocess per mutant is a thousand times
  slower. `milo check --json` is the out-of-repo equivalent for anyone who needs it.
- **`scripts/gen-std-docs.ts`** renders the compiler's own reference markdown. Moving the
  renderer into a script would give the repo two markdown renderers to keep in step, which
  is the drift this whole document exists to prevent. `milo api --module <m> --markdown`
  and `milo doc <file|dir> -o <dir>` are the public equivalents.
- **`scripts/playground/compiler.ts`** is bundled into a browser page, and a browser
  bundle cannot spawn a `milo` subprocess; the compiler itself has to be in the bundle.
