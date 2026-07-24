<!-- doc-meta
system: package-manager
purpose: design for milo package management — manifest, lockfile, git-as-registry, and the per-package namespacing it depends on
key-files: src/resolver.ts, src/parser.ts, src/checker.ts, src/ast.ts, docs/roadmap.md
update-when: the manifest/lock schema changes, or per-package mangling lands
last-verified: 2026-07-23
-->

# Package manager

Status: design, not started. Decisions below are locked unless marked open.

## Decisions

- **One binary: `milo`.** Not a separate `milo-pkg`, and no `miloc` compiler binary either. Every verb — `build`, `run`, `test`, `fmt`, `lsp`, `lint`, `add`, `install`, `publish` — hangs off the same entry point. Rust needs `cargo` *and* `rustc` for historical reasons; there is no reason to grow a second entry point for the same program. Supersedes `docs/roadmap.md:49` ("Package manager (`milo-pkg`) … written in Milo").
- **Written in TypeScript, in-tree.** The resolver already reads the manifest and sits in the compile path, so it stays TS regardless; splitting the fetcher into Milo would put a bootstrap dependency in front of `milo install` — the one command that must work before anything is built. Self-host dogfooding happens in `.selfhost`, where it belongs.
- **`milo.json`**, JSON only. No TOML — it would mean writing and maintaining a TOML parser in std for a config file. `jsonParseJsonc` already gives comments and trailing commas.
- **GitHub repos are the registry.** No server, no index, no hosting, no name squatting, no single point of failure. `milo publish` is a git tag.
- **std stays monolithic and compiler-versioned.** std is part of the language; it is never a package and has no version of its own.
- **Per-package name mangling in the resolver** — prerequisite, see below.
- **No `cLibs` manifest field.** `@link("SDL2")` on an extern already declares native libs and already propagates transitively through the merge (`src/checker.ts:1180`, `src/hir.ts:184`, `src/main.ts:566`). A manifest copy would be a second source of truth that drifts.

## What already exists

`src/resolver.ts:53-142` is half of this feature:

- `findManifest` walks up for `milo.json` and reads `deps`
- `parsePkgUrl` parses `github.com/user/repo@v1.0` and local paths
- `resolvePath` resolves imports out of `~/.milo/cache/<host>/<path>/<version>/`, with `lib.milo` / `<pkgname>.milo` entry fallback and platform-suffix support

Missing: anything that *populates* the cache, a lockfile, and the CLI verbs. `~/.milo/cache/github.com/` exists on dev machines and is empty.

---

## P-1 — visibility (lands first)

Everything is public today. A package ecosystem without a private/public boundary means every internal helper is somebody's dependency, and no package can change anything without breaking consumers. This has to be settled before packages ship, and it should be settled before mangling, because it changes what mangling has to be careful about.

### Private by default, `pub` to export

**Not `_name` for private.** The underscore prefix is already the convention for *deliberately unused* — `_x` on a parameter you don't read. Overloading it with "private" makes `_helper` mean two unrelated things and makes the unused-lint's job ambiguous. A keyword is the honest spelling.

**`pub`, not `export`, and the reason is not taste: `@export` is already taken.** It forces external C linkage (`src/checker.ts:1169-1175`). A language with both `export fn foo` (visible to other Milo modules) and `@export fn foo` (visible to the C linker) has two unrelated exports one sigil apart. `pub fn` collides with nothing.

```milo
pub fn parse(s: string): Result<Doc, Error> { ... }   // importable
fn scanToken(s: string, i: i64): Token { ... }        // module-private
```

Applies to `fn`, `struct`, `enum`, `trait`, `type`, and globals. Struct *fields* are a separate question — recommend all-or-nothing per struct initially (a `pub struct` exposes its fields), since per-field visibility is a much larger checker change and can be added later without breaking anything.

### Why before mangling, not after

Visibility does not replace mangling — private names from two packages still collide in the flat merged namespace, so they still need unique symbols. The two are complementary: mangling gives uniqueness, visibility gives an importable surface.

But visibility shrinks what mangling must get right. A private decl is never importable and never referenced across a package boundary, so it only needs *some* unique symbol — the per-file path hash works and no cross-package binding logic applies to it. Landing visibility first means the mangler only has to reason carefully about the `pub` subset.

It also makes the `"exports"` manifest field unnecessary: the source is the manifest.

### Migration

1312 top-level declarations in `std/`. Examples and tests hold ~3327 more, but they are leaves — nothing imports them, so they need no annotation at all.

Do it in two passes, the first mechanical and behavior-preserving:

1. **Codemod `pub` onto every top-level decl in `std/`.** Semantically identical to today; nothing breaks; reviewable as a pure-insertion diff.
2. **Remove `pub` where nothing outside the defining module references the name.** Incremental, module by module, each step independently verifiable by the test suite. Never has to finish to be useful.

The value is entirely in pass 2, but pass 1 is what makes pass 2 safe to do slowly.

### Open

- Struct field visibility — defer, per above?
- Does `pub` on a trait method mean anything, or is it implied by the trait's own visibility? (Recommend: implied. Rust's answer, and the alternative is noise.)

---

## P0 — per-package namespacing

### The problem

`resolveImports` merges every declaration from every module into one flat namespace, then hard-errors:

- `resolver.ts:279` `duplicate-fn` — two modules define `fn parse` with different bodies
- `resolver.ts:266` `shadows-stdlib` — a fn shadows a std fn with a different signature

Correct today, because you control both sides. Fatal with a package ecosystem:

- package A defines `parse`, package B defines `parse` → the **consumer**, who wrote neither, gets an unfixable compile error
- adding a fn to std later retroactively breaks a published package that used that name

Every real ecosystem has per-module namespaces. This must land before packages exist in the wild, because it is not a backward-compatible fix once packages have shipped assuming a flat namespace.

### Design

An AST rewrite pass in `resolver.ts`, before the merge. The checker, lowering, and codegen never see it — that is what makes this tractable.

**Package id.** Every resolved file gets one:

- `""` for the entry file, user source, and all of `std/` (including prelude)
- `<depName>` for anything resolved through a manifest `deps` entry

std stays unmangled deliberately: it is compiler-versioned, single-instance, and prelude names must be globally visible. Non-package code therefore behaves exactly as it does today — zero regression surface.

**Mangling.** In a file with package id `P`, every top-level declaration `foo` becomes `P$foo`. Applies to functions, structs, enums, traits, interfaces, type aliases, and globals. `impl Foo` becomes `impl P$Foo`; method names are untouched, since methods are already namespaced by their receiver type.

Never mangled:

- `extern fn` — binds a C symbol by name. Already exempt from the dedup checks, same rule.
- `@export` fns — a deliberate public C ABI surface.

**Intra-package references.** Inside `P`'s own modules, a reference to `foo` rewrites to `P$foo` only when `foo` is declared somewhere in `P`. Otherwise it is left alone: it belongs to std, or to an extern, or to a dep of `P`.

**Cross-package references.** Imports become a binding mechanism instead of the validate-only pass they are today (`resolver.ts:175`). In package A, `from "b/x" import { thing }` binds the local name `thing` to `b$thing`. In user code, `from "http2" import { Client }` binds `Client` to `http2$Client`.

**Collisions become fixable.** Importing `get` from two packages is now an error at the *user's* import site, where the user can fix it — instead of a duplicate-symbol error deep inside two libraries they don't own.

### Prerequisites

- **`import { x as y }` aliasing.** Not supported: `ast.ts:177` has `names: string[]`, and the parser has no `as` handling. Needed as the collision fix, so it is part of P0, not a nice-to-have. `ImportDecl.names` becomes `{ name: string, alias?: string }[]`.
- **Fix `fnIsUserCode` for package-prefixed names.** See below — this is the one thing P0 actually breaks.

### Symbol scheme: `$`, already shipping

No new character to pick. `$` is Milo's existing namespace separator and `_` its type-argument separator, both already in every emitted binary. Verified from real `emit-ir` output:

```llvm
define internal i64 @Box_i64$get(ptr %self)   ; impl method on a monomorphized type
define internal i64 @ident_i64(i64 %x)        ; monomorphized free fn
```

So `http2$get` and `http2$Box_i64$get` introduce nothing new. lldb, hades, and backtraces already render `$` symbols today, which means **no demangling layer and no DWARF work** — an earlier concern that evaporated on contact with the actual IR. A package prefix is a namespace boundary, so `$` is the consistent choice over `_`.

**The one real breakage.** `src/checker.ts:364-372` `fnIsUserCode` splits on `$` positionally and assumes `parts[0]` is the type-or-fn name:

```ts
const parts = name.split("$");
if (this._userFnNames.has(parts[0])) return true;
if (this._userImplKeys?.has(`${parts[0]}.${parts[parts.length - 1]}`)) return true;
```

Prepend a package and `parts[0]` becomes `http2`, so both lookups miss. That silently mis-classifies package code as user code and vice versa — and `fnIsUserCode` gates `unused-unsafe`, which by design "fires only in user code" (`checker.ts:307`). Symptom would be the lint going quiet on the user's own unsafe blocks while firing on every dependency's.

Fix: pass the resolved package-name set into the checker and strip a leading known-package segment before the existing logic runs. Contained to one function, but it must land *with* the mangling, not after — a lint that silently inverts its target is worse than one that is off.

### Already free: no glob imports

Milo has no `import *` and no bulk-binding form of any kind. `parseImport` (`src/parser.ts:160-182`) accepts only `from "path" import { a, b }`; bare `import "path"` is a parse error with a hint. Zero occurrences across every `.milo` file in the repo.

This matters more than it sounds. A glob import bulk-binds every name a package exports, which reintroduces exactly the collision problem mangling exists to solve — and it does so at a site the user cannot see. Every explicit-name ecosystem eventually adds globs and then regrets them. Milo never has to, because the syntax was never there.

Keep it that way: **no glob import form, ever, for packages or std.** Naming every imported symbol is what makes per-package binding total and diagnosable.

Two stale artifacts to clean up while doing P0:

- `CLAUDE.md` claims `from "std/<name>" import { ... }` "(or `import *`)" — false, no such syntax
- `ast.ts:180` types `names` as `string[] | null` with a `// null = glob import` comment; `null` is unreachable since bare imports became an error, leaving dead branches at `resolver.ts:160` and `resolver.ts:328`

### Open

Should packages be able to declare a public surface (only listed names importable), or is everything importable? Everything-public is less work and matches today. A `"exports": [...]` manifest field can be added later without breaking anything.

---

## P1 — the manager

### Manifest — `milo.json`

```jsonc
{
  "name": "http2",
  "version": "1.2.0",
  "description": "HTTP/2 client",
  "license": "MIT",
  "repository": "github.com/foo/milo-http2",

  "milo": ">=0.4.0",             // compiler version constraint
  "lib": "lib.milo",             // what `import "http2"` resolves to (libraries)
  "main": "src/main.milo",       // binary entry (applications)

  "deps":    { "json-ext": "github.com/bar/json-ext@v0.3.1" },
  "devDeps": { "bench":    "github.com/baz/bench@v0.1.0" },

  "targets": ["darwin", "linux", "windows"],
  "exclude": ["tests/**", "examples/**"],

  // advisory only — never affects linking, @link is the source of truth.
  // Used solely to turn "library not found: SDL2" into an install instruction.
  "nativeHints": { "SDL2": { "brew": "sdl2", "apt": "libsdl2-dev" } }
}
```

`lib` resolution keeps today's fallback chain (`lib.milo`, then `<pkgname>.milo`) so existing cache layouts still resolve.

**`milo` version constraint earns its place.** The language moves fast. A package written against 0.3 syntax must fail with `http2 needs milo >=0.4, you have 0.3.2` — not a parse error 40 lines into someone else's file.

**`nativeHints` is advisory by construction.** It cannot drift into being wrong-but-load-bearing, because nothing reads it during linking. `main.ts:671` already prints a note naming the `@link` that requested a missing lib; this upgrades that note to name the install command.

### Lockfile — `milo.lock`

Generated, committed, JSON, flat. Nested trees are npm's mistake.

```jsonc
{
  "lockVersion": 1,
  "packages": {
    "http2": {
      "url": "github.com/foo/milo-http2",
      "version": "v1.2.0",
      "commit": "a1b2c3d4e5f6...",   // exact SHA, not the tag
      "hash": "sha256:9f86d081...",  // extracted tree, verified every install
      "deps": ["json-ext"]
    }
  }
}
```

**Pin the commit SHA, not the tag.** Git tags are movable; a tag alone is not a supply-chain guarantee. The tree hash is the second belt — a force-pushed tag or a poisoned cache entry fails loudly instead of silently building different code. std already has `sha256`, so the verifier is writable in Milo.

### Source schemes

| Form | Example | Notes |
|---|---|---|
| Git host shorthand | `"github.com/foo/bar@v1.2.0"` | primary form; `parsePkgUrl` handles it today. Also gitlab.com, codeberg.org, sr.ht |
| Explicit git | `"git+ssh://git@internal/bar.git@v1.2.0"` | private and self-hosted |
| Local path | `"./vendor/bar"`, `"../shared"` | monorepos, and the output of `milo vendor`. Never hash-locked |
| Tarball | `"https://…/bar-1.2.0.tar.gz#sha256=abc…"` | hash mandatory in the URL |

Refs: `@v1.2.0` tag · `@a1b2c3d` SHA · `@main` branch. Branch refs are allowed but warn — unreproducible without the lock.

No semver ranges. Ranges require enumerating available versions, which requires an index. With git-as-registry, `milo update` re-resolves by listing tags on the remote and picking the highest matching one; the manifest stores the exact ref it settled on. Simpler and honest about what the system can actually guarantee.

### Cache layout

```
~/.milo/cache/
  github.com/foo/milo-http2/v1.2.0/   # extracted tree — what resolvePath reads today
  .blobs/<sha256>.tar.gz              # content-addressed downloads, shared across versions
```

The readable path stays because it is debuggable and already wired. `.blobs/` deduplicates the download layer.

### Verbs

```
milo init                    # milo.json in cwd, name inferred from directory
milo new <name>              # scaffold: dir, main.milo, milo.json, .gitignore
milo add <pkg>[@ver]         # resolve, fetch, verify, write manifest + lock
milo add --dev <pkg>
milo remove <pkg>            # manifest + lock, prune orphans
milo install                 # sync cache from lock
milo install --frozen        # CI: fail if lock is stale or missing
milo update [pkg]            # re-resolve tags, rewrite lock
milo tree                    # dependency graph
milo why <pkg>               # who pulls this in
milo outdated                # newer tags available upstream
milo vendor                  # copy deps to ./vendor, rewrite deps to local paths
milo publish                 # verify, tag, push
milo search <terms>          # GitHub topic search
```

`milo run` / `milo build` auto-install missing locked deps (bun/uv behavior) rather than erroring. `--frozen` is the CI escape hatch.

**`milo vendor` matters more here than in most languages.** Airgapped, audited, safety-critical builds — the positioning in `design.md` §Ethos — need every dependency byte in-tree and reviewable, with no network at build time. Rust and Go both bolted this on late. First-class from day one is cheap and on-brand.

### Publishing and discovery without a server

`milo publish`:

1. validate `milo.json` (name, version, license, `lib` or `main` resolves)
2. check the working tree is clean and `version` matches no existing tag
3. compile the package standalone as a smoke test
4. `git tag v<version>` and push

That is the whole thing. The repo is the package; the tag is the release.

Discovery uses the GitHub topic `milo-package`. `milo search <terms>` queries GitHub's search API for repos with that topic. No index to maintain, no moderation burden, no takedown policy.

The known cost, stated up front: **no short names.** Deps are always `github.com/foo/bar`, never `http2`. This is what Go did before the module proxy and it was fine. If short names ever become worth it, an index repo (a single JSON file, additions by PR) adds them without changing the format — the manifest value just becomes indirect.

---

## Example packages

Two, both real, both dogfood:

- **`milo-language/hello-package`** — minimal correct package. Exists to be read: manifest, `lib.milo`, exports, tests, a tagged release. The thing `milo new` scaffolds and the thing docs link to.
- **`milo-language/yaml`** — a YAML parser. Deliberately not in std, and real enough to exercise nested deps, the `milo` version constraint, and `milo publish` end to end. Widely needed, unpleasant format, nobody's favorite — which is exactly the profile of a thing that belongs in a package rather than the language. std is not where personal taste gets to be load-bearing; packages are how someone else's taste gets served without the language carrying it forever.

  (TOML was the obvious candidate until it wasn't — `std/toml.milo` already ships, listed in `roadmap.md:34`. Worth revisiting whether it should have: by the rule above it is package material, and the same argument applies to `csv`, `png`, `zip`, and `zstd`. Not a P0 question, but once packages exist, "what earns a place in std" needs an actual answer, and moving something *out* of std is a breaking change that gets harder every release.)

---

## Phasing

| Phase | Content | Gate |
|---|---|---|
| **P-1** | `pub` keyword, private by default, codemod std | Language change. Must precede packages; shrinks P0's surface |
| **P0** | Per-package mangling, `import as`, `fnIsUserCode` fix | Blocker. Not backward-compatible once packages ship |
| **P1** | Manifest, lock, fetch, verify, cache, `init/new/add/remove/install/update/tree/why/vendor/publish` | Ships the whole experience. Git-only |
| **P2** | `search`, `outdated`, `audit`, signing | Only when P1 has real users |

P1 is small: the resolver's read path already works, so it is mostly a fetcher, a lockfile, and CLI wiring. `resolvePath` barely changes.

---

## Adjacent: `milo lint`

Not part of the package manager, but it falls out of the one-binary decision, so recording it here until it gets its own plan.

The lints mostly exist already, as checker warning codes behind an allow/deny `WarningConfig` (`src/checker.ts:317`):

| Code | Site | Autofixable |
|---|---|---|
| `unused-unsafe` | `checker.ts:219` | yes — delete the block, dedent body |
| `unused-import` | `checker.ts:970` | yes — drop the name from the import list |
| `unused-move` | `checker.ts:2243` | no — suggests `&T`, which changes the signature and every call site |
| `shadows-stdlib-override` | `checker.ts:976` | no — requires choosing a new name |
| `unverified-extern` | `checker.ts:1726` | semi — `@cLayout` is generable from real headers, see `docs/plans` on C decl verification |
| `large-stack-array` | `checker.ts:345` | no |

Missing pieces: a command that runs the check phase alone (no codegen, no link), and an autofix writer.

```
milo lint [path]        # report: warnings + formatting diffs, exit 1 if any
milo lint --fix         # apply fmt + the mechanically-safe fixes, report the rest
```

`--fix` applies only the top two rows plus formatting. The rest print with their existing hints and stay the human's call — a lint that rewrites signatures is a lint people turn off.

`milo fmt` stays as-is; `--fix` shells the same `bin/milo-fmt` path so there is still exactly one formatter (`fmt.milo`), per the existing rule.

## Open questions

1. Whether anything currently in std should move out once packages exist — see the note under `milo-language/yaml`.

## Resolved

- **Self-host scope.** `.selfhost` is paused; packages are a TypeScript-compiler feature and the self-hosted compiler does not get the mangling pass. Revisit only if self-host resumes.
- **Symbol separator.** `$`, already the house convention. No demangler needed.
- **Glob imports.** Do not exist and never will.
- **Implementation language.** TypeScript, in the `milo` binary.
- **Dependency tests.** Never run. `milo test` covers the root project only.
- **Public surface.** A `pub` keyword in the source, not an `"exports"` manifest field — see P-1.
- **Transitive `@link` conflicts.** Not a real failure mode, and not statically detectable. `linkLibs` is a bare `string[]` (`src/hir.ts:185`) — a name, with no version and no static/dynamic flag — so "two packages want incompatible versions" is not expressible in the first place. Two packages naming `SDL2` produce one `-lSDL2`; two packages naming genuinely incompatible libs (`SDL2` and `SDL3`) produce a duplicate-symbol error from the linker, which is the only component that knows what symbols a `.dylib` actually exports. A manifest field could not improve on that, because the manifest does not know the symbol sets either. The linker stays the authority; `nativeHints` only improves the *message*, at `milo add` time instead of link time.
