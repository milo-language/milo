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

Symbols are private by default. Mark a function, struct, or field `pub` to make it visible to other modules:

```milo
pub struct User {
    pub name: string,
    age: i32,           // private, visible only in this file
}

pub fn createUser(name: string): User {
    return User { name: name, age: 0 }
}
```

## How it works

Imports are resolved recursively and deduplicated. The resolver merges all imported ASTs before type checking, so there's no separate compilation yet.

Platform-specific modules use suffix-based selection: `std/platform.darwin.milo` vs `std/platform.linux.milo`. The resolver picks the right one for the host.

Next: [C FFI](/features/ffi)
