<!-- doc-meta
system: packages-index
purpose: the published Milo packages, what each is graded against, and how to publish one
key-files: docs/site/.vitepress/config.mts, src/pkgcli.ts
update-when: a package is published, renamed, or retired
last-verified: 2026-08-15
-->

# Packages

Milo's registry is GitHub. There is no central index to sign up for — `milo pkg add`
takes a repository, resolves the highest tag, and writes the exact commit and
tree hash into `milo.lock`.

```bash
milo pkg add github.com/milo-language/milo-postgres          # highest release
milo pkg add github.com/milo-language/milo-postgres@v0.1.0   # or pin a tag
```

Then import it by its package name, which is the repository name minus the
`milo-` prefix:

```milo
from "postgres" import { Conn }
```

## Published

| Package | Install | What it is |
|---|---|---|
| **postgres** | `milo pkg add github.com/milo-language/milo-postgres` | PostgreSQL client — wire protocol v3, SCRAM-SHA-256, extended query with real bind parameters, TLS |
| **redis** | `milo pkg add github.com/milo-language/milo-redis` | Redis client — RESP2/RESP3, pipelining, pub/sub, transactions |
| **markdown** | `milo pkg add github.com/milo-language/milo-markdown` | CommonMark + GFM parser and HTML renderer, with a walkable AST |
| **toml** | `milo pkg add github.com/milo-language/milo-toml` | TOML v1.0.0 parser and serializer |
| **yaml** | `milo pkg add github.com/milo-language/milo-yaml` | YAML 1.2 subset parser |
| **json-rpc** | `milo pkg add github.com/milo-language/milo-json-rpc` | JSON-RPC 2.0 over Content-Length framing — the LSP/DAP base protocol |
| **gl** | `milo pkg add github.com/milo-language/milo-gl` | OpenGL 3.3 core bindings and a safe layer |
| **sdl** | `milo pkg add github.com/milo-language/milo-sdl` | SDL2 bindings — video, input, gamepad, audio |

## How they are graded

Every package here is tested against something that is **not itself** — an
independent implementation, a published test vector, or the real server. A test
suite that only compares a library to its own expectations proves that it is
self-consistent, not that it is correct.

| Package | Graded against |
|---|---|
| markdown | all 655 CommonMark spec examples, plus byte-identical output to `cmark` over the whole spec document |
| toml | Python's `tomllib` over a 78-file corpus, comparing values **and** types |
| postgres | a real PostgreSQL requiring SCRAM, with `psql` reading back what the client wrote |
| redis | a real Redis requiring AUTH, with `redis-cli` cross-checking, and RESP2 vs RESP3 asserted as a differential |
| yaml | `ruamel.yaml` |

## Why these live outside the standard library

`std` carries JSON, because the toolchain itself reads `milo.json` and because
the slot has one obvious winner. Formats with credible competitors, and clients
that track someone else's release cycle, are packages instead — so a fix ships
the same day on its own tag rather than waiting for a compiler release.

See [the standard library](/stdlib/) for what is built in.

## Publishing your own

A package is a repository with a `milo.json` and a `lib` entry point:

```json
{
  "name": "mylib",
  "version": "0.1.0",
  "license": "MIT",
  "repository": "github.com/you/milo-mylib",
  "lib": "lib.milo",
  "targets": ["darwin", "linux", "windows"],
  "exclude": ["tests/**", "examples/**"]
}
```

Tag a release (`git tag v0.1.0 && git push origin v0.1.0`) and it is installable.
**Tag it** — without a tag, `milo pkg add` tracks whatever `main` happens to be at
install time, so two people adding your package on different days get different
code.

### Then install what you published

A package's own tests import `"./lib"` or `"../lib"` — the **local** path. Nobody
who installs your package takes that path; they take the package path, which
mangles names per package. The two can disagree, and when they do your CI is
green and your users cannot compile at all.

Both failures have happened here, from different causes:

* `milo-postgres` v0.1.0 shipped with 32 passing tests and did not compile for
  anyone, because a capitalised global was unresolvable under package mangling.
* `milo-yaml` v0.2.1 shipped without a fix that was already sitting on `main`,
  so the tag `milo pkg add` resolved to was older than the working code.

Neither is catchable by a package's own test suite. The check that catches both
takes ten seconds:

```bash
mkdir /tmp/verify && cd /tmp/verify
echo '{ "name": "verify", "version": "0.0.1" }' > milo.json
milo pkg add github.com/you/milo-mylib          # the published artifact, not your checkout
printf 'from "mylib" import { thing }\nfn main() { print(thing()) }\n' > main.milo
milo run main.milo
```

Run it after tagging, from a directory that is not your repo.
