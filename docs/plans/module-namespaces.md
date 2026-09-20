<!-- doc-meta
system: module-namespace-plan
purpose: implementation plan for per-module name scoping, replacing the flat one-namespace merge
key-files: src/mangle.ts, src/resolver.ts, src/checker.ts, docs/breaking-changes.md
update-when: the mangling granularity, the std carve-out, or the staging changes
last-verified: 2026-09-20
-->

# Per-module namespaces — implementation plan

**The problem.** Two modules that each define a private helper collide, even though neither
imports the other's name:

```
error: 'fn tone' is defined in two modules with different bodies
  hint: also defined in 'examples/games/flight/gfx.milo'. Milo compiles all modules into
        one namespace, so only one body survives and every call site runs it.
```

Hit for real in `examples/games/flight`. The advice — rename one — is the wrong direction:
it makes a *local* name choice depend on every other file that happens to end up in the same
build, and the pressure grows with the program.

## Why this is fixable cheaply: imports are already mandatory

Verified 2026-07-31 on a scratch project:

- A name from another file is **not visible without an explicit import**. `helperA()` defined
  in `a.milo` and called from `main.milo` with no import is `undefined function 'helperA'`.
- Two modules defining `dup`, with `main` importing only `fromB`/`fromC`, still collide — the
  merge is what fails, not the resolution.

So name *resolution* is already per-module; only the final merge is flat. That means
**per-module mangling needs no source changes anywhere** — it deletes an error class without
altering a single working program's meaning. That is the whole argument for doing it.

## The machinery already exists

`manglePackage(prog, pkg, pkgDecls, bindings)` in `src/mangle.ts` already does exactly this
job at *package* granularity (shipped as package-manager P0): it prefixes a unit's decls and
rewrites internal references, with a `bindings` map pointing imported names at the origin's
mangled symbol. `resolver.ts` already computes `declOrigins` per file, tracking which file
declared each value/type and whether it was `pub`.

The change is granularity: call it per *file* rather than per package, with `bindings` built
from that file's import list.

## Sequence

**Stage 1 — SHIPPED 2026-08-15, and narrower than this plan proposed: rename only the
names that actually COLLIDE.**

The plan said to mangle every private name in every user module. That was implemented and
it works — the collision disappears and each call site reaches its own module's body — but
a mangled name is not only a link-time symbol. Measured on the fixture suite: 24 failures,
in two clusters. `print` of a struct emitted `printContainers$User` instead of `User`, and
14 error fixtures stopped matching their `@error:` text because the diagnostic named a
mangled type. Both are the stage-3 concern below, arriving early and as a hard blocker.

Renaming a name that nothing else declares buys nothing, so the shipped pass indexes every
user module's top-level names first and renames a private name only when some other user
module declares the same one. A program with no collision compiles byte-for-byte as before
(866/866 fixtures, unchanged output), so the display problem is confined to the rare
programs that were previously rejected outright — which is a strictly better place for it
than every program in the language.

What ships:

- Private names only (`fn`, `global`, `struct`, `enum`, `trait`, `interface`, `type`). A
  `pub` name stays put, so **no import binding anywhere had to be rewritten** — and two
  modules exporting the same name with different bodies is still an error, which is right:
  that one is a genuine ambiguity for anyone importing both.
- A private name may also collide with another module's `pub` name; the private side is
  renamed, for the same reason.
- Carve-outs, in `isModuleManglableFn` / `collectModulePrivateDecls`: `extern`,
  `@externalLinkage` (both already honoured by `isManglableFn`), `main`, `@cName` and
  `@cLayout`.
- Packages and `std/` are skipped entirely — packages already carry a `<pkg>$` prefix and
  stacking a second would rename the same decl twice.
- `manglePackage` gained a `restrictToDecls` mode, because its rename phase renames every
  top-level decl in the file, which is right for a package (it owns the file) and wrong for
  a module pass (it owns only the private names).

Two tests in `tests/modules.test.ts` asserted the old rule for PRIVATE fns and globals and
now assert it for `pub` ones, which is the behaviour that survived.

**Stage 3 (display names) and stage 4 (std) SHIPPED 2026-09-20.** A mangled name is a
symbol and nothing else: the resolver records every rename in `Program.displayNames`
(mangled to as-written), `display()` in `src/mangle.ts` renders any text through it, and
every human-facing surface goes through that one function: the checker rewrites each
diagnostic's message and hint on the way out of `check()`, codegen renders the `Name { .. }`
text behind `print` and every DWARF `name` (no `linkageName`: lldb would show it in every
frame), `@derive` templates get the written name in their `@…Str` holes, the LSP restores
the written names after checking (`restoreDisplayNames`), and the verify/prove/safety
reports are substituted on the way to stdout. WCET flow facts keep the symbols on purpose
(OTAWA matches them against the linked ELF). Two consequences for compiler-generated
source: the lexer accepts `$` in identifiers only when lexing a derived codec
(`new Lexer(src, true)`), and the parser's "spelled like a type" test looks at the segment
after the last `$`, since `gfx$User { … }` is still a struct literal.

The gate that cannot be gamed is `MILO_MANGLE_ALL=1`: it renames EVERY private name in
every user module, and the fixture suite must not notice. Before display names it turned
59 error fixtures red; after, 0, and a 40-fixture sample of print/derive/interface output
is byte-identical. A private user name that also names a std decl is never renamed under
that switch, so the `shadows-stdlib` diagnostics keep firing.

std: every non-`pub` top-level name in a std module is `<module>$<name>` (a platform arm
takes its base module's id, so all arms produce the same symbols). `pub` std names stay
flat: `milo api`, `milo doc` and docs/breaking-changes.md index the flat pub surface. The
one carve-out is `COMPILER_KNOWN_STD_HELPERS` (std/string's `str*` family and `vecJoin`),
which lowering and codegen call by name. The `_xxRotl`/`_sha1Rotl` naming convention from
backlog #11 is reverted, `tests/modules.test.ts` imports every std module in one program
(seen to fail with the pass disabled), and one real bug fell out: deflate's private
`fn flush` used to resolve to the JS backend's builtin `flush`.

Still open: user modules rename only names that collide. `MILO_MANGLE_ALL` proves the wide
form is safe; it stays a switch until something needs stable per-module symbols.

**Stage 1 (original proposal) — mangle user modules only.** Leave `std/` and the prelude at `pkg=""` and
unmangled. This bounds the blast radius to user code and keeps the stdlib's flat surface
(which `milo api`, `milo doc`, and `docs/breaking-changes.md` all assume) untouched. Collisions
between two user modules stop being errors; a user-vs-std collision keeps today's behavior.

**Stage 2 — the carve-outs.** These are the parts that must NOT be mangled, and getting one
wrong is a silent break rather than a compile error:

- **`extern` functions.** A C symbol is bound by name. Mangling one produces a link error at
  best and calls the wrong symbol at worst. `project_package_manager` already records "never
  rename an extern fn" as a hard-won rule — same rule, same reason.
- **`main`**, and anything else the linker or runtime looks up by exact name.
- **`@cName`-annotated decls**, whose entire purpose is a fixed symbol.
- **`pub` names re-exported across a package boundary**, which are already package-mangled;
  the two schemes have to compose, not stack.

**Stage 3 — diagnostics and tooling.** The error text above disappears, but its replacements
matter: an ambiguous *imported* name (two modules export `parse`, one file imports both) is a
genuine conflict and needs a clear message naming both origins and suggesting `as`. LSP
go-to-definition, `milo doc`, and stack traces all currently show unmangled names and must
keep doing so — mangling is an internal symbol concern, never a user-visible one.

**Stage 4 — std.** Only if it proves worth it. The stdlib's flat namespace is required for
`milo api` discovery and is documented as such; changing it is a much larger decision than the
user-module fix and should not ride along with it.

## Risks

- **Debug info.** DWARF names come from the emitted symbol; a mangled name in a backtrace or
  in `lldb`/`hades` is a real regression in the debugging story. Emit the source name as the
  DWARF linkage-name's display form.
- **Monomorphization keys.** Generic instances are keyed by name today; per-module names must
  not accidentally split one instantiation into two identical copies (code bloat) or merge two
  distinct ones (miscompile).
- **`impl` blocks.** Methods resolve by receiver type rather than flat name, so they should be
  unaffected — but this needs a test, not an assumption, since `userImplKeys` is built from
  names.

## Should we do it?

Yes, and it is close to a pure win: no source changes, an error class deleted, and the
machinery already written and shipped for packages. The reason it is not folded into an
unrelated change is that stage 2's carve-outs are exactly the kind of thing that fails
silently, so it wants its own diff and its own test pass — including a link-level test that an
`extern` symbol still resolves.
