<!-- doc-meta
system: stdlib-design
purpose: normative API-shape and error conventions for a coherent, predictable Milo standard library
key-files: std/, src/main.ts, docs/breaking-changes.md
update-when: a public stdlib API is added or a convention proves insufficient in real use
last-verified: 2026-08-22
-->

# Standard Library Design

This is the design target for `std/`, not a claim that every existing module
already conforms. New APIs follow it immediately. Existing exceptions are the
migration inventory at the end of this document; do not copy an exception into
new code merely because it already shipped.

The goal is prediction: after learning one part of the standard library, a user
should usually be able to guess the name, shape, ownership, and failure behavior
of an unfamiliar API.

## The user model

1. The module says which domain owns a name.
2. A value's operation is a method on that value.
3. A constructor is an associated function on the type it returns.
4. A stateless conversion or algorithm is a module-level function.
5. `Option<T>` means a value may legitimately be absent.
6. `Result<T, E>` means an attempted operation may fail.
7. Ownership is visible: borrowed inputs use `&T`, consumed inputs use `T`, and
   returned values are owned.

Correctness includes readability. Use the least elaborate return type that
preserves information callers commonly act on; do not force every probe into a
multi-branch recovery protocol for rare distinctions.

These rules deliberately favor one unsurprising path over multiple equivalent
spellings.

## What earns a public entry

The bar is **ergonomic, capable, and sensible**, in that order of scrutiny; a lean
surface is the consequence of applying it, not the goal.

- A **capability gap** justifies new surface: if the thing cannot be done at all
  without it (or only at a cost that defeats the point, like copying a buffer to
  scan it), it belongs, even when it widens the API.
- A **duplicate never does**. A second way to ask a question the API already
  answers is clutter, however small (`freezable()` next to a `freeze()` whose
  refusal already hands the arena back was cut for exactly this).
- A **zero-use convenience waits for its consumer**. If it is trivially composable
  from what exists, land it the day a real program shows the pattern repeatedly,
  as a small diff. Pre-building it produces API whose only caller is its own test.
- Every public entry ships with a test and a doc comment, however obvious. An
  untested public API is a claim nobody checked.

## API shape

Use this table before naming an API:

| Operation | Shape | Example |
|---|---|---|
| Create an empty/default value | `Type.new(...)` | `Channel.new(capacity)` |
| Parse text into a value | `Type.parse(text)` | `Json.parse(source)` |
| Acquire an OS-backed value | `Type.open(...)`, `Type.connect(...)`, or `Type.bind(...)` | `File.openRead(path)` |
| Operate primarily on one value | instance method | `stream.send(data)` |
| Convert one represented value into another | instance `toX` or free `xFromY` when neither type owns the conversion | `duration.toMillis()` |
| Stateless domain algorithm | free function | `sortI64(values)` |
| Process-wide operation | free function | `currentDir()` |

### Methods and constructors

- Put an operation on the type when that type is its clear subject.
- Constructors live on the returned type. Do not add parallel `newThing()` and
  `Thing.new()` entry points.
- Use `new` for ordinary construction, `parse` for validated textual decoding,
  `open` for an external resource, and domain verbs such as `connect` or `bind`
  when those verbs carry useful semantics.
- Methods do not repeat the type name: `regex.find(input)`, not
  `regex.regexFind(input)`.
- A stateless domain with several related operations may use an empty namespace
  type (`Path.join`, `Base64.encode`) because Milo imports names selectively and
  has no module-qualified call syntax. Use this only for a cohesive family, not
  for a single function.

### Free functions

- Use a free function when there is no meaningful receiver or returned nominal
  type.
- A domain prefix is useful when a `pub` name would be generic or
  collision-prone: `parseCsv`, `getEnv`, `pathJoin`. Only `pub` names share the
  flat std namespace.
- A private helper needs no prefix. Every non-`pub` top-level name is scoped to
  its module by the compiler (`src/mangle.ts`, per-module namespaces), so
  `std/sha1` and `std/xxhash` may both define `fn rotl`, and a reader of either
  file sees the plain name everywhere (diagnostics, `print`, DWARF, the LSP).
  The `_xxRotl`/`_sha1Rotl` convention that predates this is gone; do not
  reintroduce it. The one exception is std/string's `str*` helpers, which the
  compiler calls by name (`COMPILER_KNOWN_STD_HELPERS` in `src/mangle.ts`).
- Keep one spelling. Aliases are temporary migration tools with an explicit
  removal point, not a permanent convenience layer.

## Names

- Use camelCase for values and functions, PascalCase for types, and established
  type spellings inside names (`i64`, `u16`, `f64`).
- Start commands with a verb: `readFile`, `removeDir`, `send`, `parse`.
- Start predicates with `is`, `has`, or `can`. A convenience predicate returns
  `bool`; use the underlying fallible operation when the failure reason matters.
- Reserve `tryX` for a non-blocking or intentionally lossy probe whose contract
  explicitly discards the reason it did not produce a value. Do not use `try`
  merely because a function returns `Result`.
- State units in names unless the type supplies them: `sleepMs`, `epochSecs`.
- State representation boundaries. An operation on ASCII bytes says `Ascii`;
  an operation on Unicode code points takes an `i32` code point or says
  `Codepoint`. Avoid calling a `u8` an unrestricted character.
- Use `raw` for an intentionally low-level representation and `unsafe` for an
  API whose caller must uphold memory or ABI invariants once unsafe functions
  are supported.

## Failure semantics

Choose the return shape from the meaning of failure, not implementation
convenience:

| Situation | Return shape |
|---|---|
| Cannot fail under its documented preconditions | `T` or `void` |
| Lookup or probe may produce no value | `Option<T>` |
| Work may fail | `Result<T, DomainError>` |
| Fallible command has no success data | `Result<Unit, DomainError>` |
| Non-blocking attempt cannot proceed now | `Option<T>` or `bool`, named `tryX` |

Rules:

- Library errors use a domain enum such as `IoError`, `NetError`, or
  `ParseError`; a bare error string is not a stable programmatic contract.
- Error variants retain actionable context: operation, path/input position, and
  the underlying OS code where relevant. Formatting belongs in display logic,
  not in place of structured fields.
- Do not collapse an operational failure into a plausible successful collection
  or data value when callers commonly need the distinction. A clearly documented
  convenience probe may use `bool` or `Option` when the reason is rarely useful.
- Use typed parse errors when callers need diagnostics such as a source offset;
  small conversions may return `Option` when invalid input simply means “no
  value.” Regex compilation and regex no-match remain distinct outcomes.
- A strict parser returns an error at the first invalid construct. A lenient
  parser advertises the accepted extension in its name, such as `parseJsonc`.
- Predicates that genuinely cannot distinguish “false” from “could not inspect”
  must document that limitation and should be paired with a fallible query.

### Two error tiers

Libraries use a domain enum when callers can realistically recover in different
ways, as with `IoError.NotFound` versus `IoError.PermissionDenied`. Small parsers
and applications use the default `Result<T>` (`string` error) when the useful
action is simply to add context and report the failure:

```milo
let config = loadConfig(path).mapErr((e) => "loading config: " + e)?
```

Do not introduce a domain enum with one generic `Other(string)` variant; it adds
ceremony without recovery value. An `anyhow`-style boxed report can be added once
`Heap<Interface>` can retain arbitrary typed causes. Until then, strings at the
application boundary and typed enums in recoverable libraries keep the common
case direct without pretending causal erasure already exists.

## Ownership and data

- Borrow read-only inputs by default. Take ownership only when storing the value,
  transferring it to another owner, or enabling a consuming builder chain.
- Mutable operations take `&mut Self` and normally return `void`; fluent builders
  may consume and return `Self` when that avoids aliases and matches move
  semantics.
- A returned string, collection, or domain value is owned. If a zero-copy view is
  introduced, its name and type must expose that distinction.
- Resource-owning types implement `Drop`; moved-from zero values must drop as a
  no-op. Provide `take`/`intoRaw` only when transferring cleanup responsibility is
  a supported use case.
- Byte offsets and code-point indexes are different concepts and must be named or
  typed accordingly.

## Supported surface

Milo currently has file-private and `pub` visibility, but no package-private
visibility. Consequently, some cross-file stdlib plumbing must be `pub` even
though it is not a supported user API.

The supported surface is therefore:

- declarations documented by `milo api` and the generated reference;
- methods on those documented public types; and
- behavior covered by public API fixtures or examples.

Raw `pub` remains a compiler visibility fact, not by itself a stability promise.
Internal cross-file declarations belong under `std/internal/` where practical
and are hidden from API discovery. Maintainers inspect those declarations in
source; the user-facing CLI does not grow a parallel internal mode.

Every supported declaration needs a concise contract covering:

- what it returns;
- ownership or resource transfer that is not obvious from the signature;
- units, indexing, and text representation;
- each meaningful failure outcome; and
- platform limitations.

Platform-split files export identical supported surfaces. A missing platform
capability fails loudly; it never returns a plausible success value.

## Compatibility

Milo is pre-1.0, so coherence fixes may break source compatibility. Each break
must:

1. ship as a complete domain-sized migration, including stdlib callers,
   examples, fixtures, and docs;
2. be recorded in `docs/breaking-changes.md` with before/after code;
3. avoid keeping permanent aliases unless two names represent genuinely
   different semantics; and
4. pass `bun test` and `bun run scripts/run-examples.ts`.

Do not mix a naming migration with unrelated behavior changes. The old and new
contracts must be independently testable.

## Migration inventory

This is the canonical list. `docs/roadmap.md` tracks the umbrella status and
`docs/backlog.md` ranks it; do not duplicate the detailed checklist there.

### S0: Make discovery truthful

**Problem:** `milo api` is lexical and currently includes private helpers while
not distinguishing supported API from cross-file plumbing.

**Work:**

- default to supported declarations and methods on supported public types;
- define how source comments mark cross-file declarations as internal until
  package-private visibility exists;
- add a snapshot test containing public, private, method, and internal cases;
- generate the surface snapshot inside the test harness without adding CLI flags.

**Done when:** a user dumping `std/http` or `std/json` sees the API they should
write against, not parser helpers.

### S1: Normalize filesystem failures

**Problem:** `std/fs` mixes typed results, zero/sentinel data, empty vectors, and
`Result<bool, IoError>` without a consistent distinction between probes and work.

**Work:**

- change command results such as `removeFile` and `setMode` to
  `Result<Unit, IoError>`;
- make metadata and size probes return `Option`, directory reads return typed
  errors, and convenience predicates return `bool`;
- preserve errno and operation/path context in `IoError`;
- migrate all callers together and record the break.

**Done when:** every filesystem signature follows the failure table and tests
distinguish failed directory reads from successful empty directories without
making ordinary existence and kind checks verbose.

### S2: Normalize parse outcomes

**Problem:** parsers alternate between `Option` and `Result` without consistently
distinguishing invalid syntax from ordinary absence.

**Work:**

- use `Option` for small conversions where invalid input means “no value”;
- use `Result<T>` with a useful message/offset for document and grammar parsers;
- keep lookup/no-match operations as `Option`;
- distinguish invalid regex from a valid regex that does not match;
- replace internal parser error flags where a typed result makes control flow
  clearer without harming the parser's allocation model.

**Done when:** each parser documents why it uses `Option` or `Result`, and regex
compilation cannot be confused with regex no-match.

### S3: Normalize constructors and receivers

**Problem:** constructors and receiver operations are sometimes exposed as
prefixed free functions even when a real value type clearly owns them.

**Work:**

- make regex construction associated with `Regex` and matching operations
  methods on `Regex`;
- retain consistent namespace types for cohesive stateless families such as
  `Path`, `Env`, `Csv`, `Base64`, and `Sha256`;
- audit `newX`/`xNew`, `parseX`, `openX`, and `X.new/parse/open` pairs;
- choose one spelling per operation and migrate examples/docs.

**Done when:** the API-shape table predicts constructors and receivers across
data, I/O, networking, and parsing modules.

### S4: Make text representation explicit

**Problem:** ASCII-byte classifiers use character or Unicode-looking names, and
some search APIs use numeric sentinels.

**Work:**

- rename ASCII-only classification and case conversion with `Ascii` in the name;
- reserve code-point terminology for `i32` Unicode values;
- return `Option<i64>` from `indexOf`, `indexOfFrom`, and `lastIndexOf` so a
  missing substring cannot become an invalid byte offset;
- document every returned offset as byte, code-point, or UTF-16-unit based.

**Done when:** signatures and names alone prevent confusing bytes with Unicode
characters or absence with a valid numeric result.

### S5: Curate high-level versus raw modules

**Problem:** high-level modules expose fixed-buffer parsers, raw descriptors,
pointer plumbing, and helper algorithms beside ordinary entry points.

**Work:**

- make same-file helpers private, starting with `std/http`;
- move necessary cross-file plumbing under `std/internal/` and hide it from
  default docs/API search;
- keep OS/FFI primitives in clearly low-level modules;
- name ownership-transfer escape hatches `intoRaw`/`fromRaw` consistently and
  document cleanup responsibility.

**Done when:** high-level module dumps are small enough to scan and unsafe/raw
boundaries are obvious before reading implementations.

### S6: Align remaining command and query APIs

**Problem:** time, process, networking, concurrency, compression, crypto, and
database modules contain smaller variations of the same inconsistencies.

**Work:** audit each remaining supported module against the decision tables,
landing one domain per change. Record intentional exceptions in this document
with the constraint that justifies them.

**Done when:** a generated conformance report has no unexplained exception.

### S7: Keep the design enforced

**Work:**

- add lightweight lint checks for meaningless command `Result<bool, E>`, undocumented
  public declarations, ASCII naming, and duplicate constructor spellings;
- review every new public API against the decision tables;
- run the public-surface snapshot in CI;
- update this document when real usage demonstrates that a rule is incomplete.

**Done when:** new inconsistencies fail locally or in CI instead of relying on a
future manual sweep.

## Implementation order

Ship `S0`, then `S1`, followed by `S2` and `S3`. `S4` and `S5` can proceed after
discovery has a trustworthy surface snapshot. Finish with the domain sweep in
`S6` and make its checks permanent in `S7`.

This ordering is intentional: truthful discovery gives every later migration a
measurable before/after surface, while filesystem errors exercise the full
failure policy on a small, heavily used domain.
