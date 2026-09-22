# Modules & Imports

## Explicit imports

All imports name exactly which symbols they use:

```milo skip
from "std/http" import { Context, Response, Router, serveRouter }
from "std/json" import { jsonParse, Json }
from "lib/math" import { add, multiply }
```

No wildcard imports, no bare `import "path"`. The LSP autocompletes both module paths and symbol names.

## Standard library

The standard library is a collection of modules under `std/`:

```milo
from "std/fs" import { readFile, writeFile }
from "std/fs" import { readDir, fileInfo }
from "std/fetch" import { fetch }
from "std/argparse" import { ArgParser }
```

## Project structure

A typical Milo project looks like this:

```
myapp/
  main.milo          # entry point
  lib/
    auth.milo         # from "lib/auth" import { ... }
    db.milo           # from "lib/db" import { ... }
  std/                # standard library (provided by the compiler)
```

Imports are paths relative to the project root. A file at `lib/auth.milo` is imported as `from "lib/auth" import { ... }`.

## Visibility

Declarations are private to their file by default. Mark a function, struct, or enum `pub`
to make it importable from other files. Field privacy inside a `pub struct` is covered
under [Structs](/language/structs#visibility-and-private-fields).

```milo
pub fn createUser(name: string): string {
    return helper(name)
}

fn helper(name: string): string {   // not pub: other files cannot import it
    return name
}
```

## Platform-specific files

A file can come in per-OS variants named by suffix: `platform.darwin.milo`,
`platform.linux.milo`, `platform.windows.milo`. With no plain `platform.milo` present, an
import of `platform` picks the variant for the target OS, so every variant must export the
same names.
