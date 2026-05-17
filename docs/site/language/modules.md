# Modules & Imports

## Explicit imports

All imports must name exactly which symbols they use:

```milo
from "std/http" import { Context, Response, Router, serveRouter }
from "std/json" import { jsonParse, Json }
from "lib/math" import { add, multiply }
```

No wildcard imports, no bare `import "path"`. The LSP autocompletes both module paths and symbol names.

## Standard library

```milo
from "std/io" import { readFile, writeFile }
from "std/fs" import { readDir, fileInfo }
from "std/net" import { fetch }
from "std/argparse" import { newParser }
```

## How it works

Imports are resolved recursively and deduplicated. The resolver merges all imported ASTs before type checking — there's no separate compilation yet.

Platform-specific modules use suffix-based selection: `std/platform.darwin.milo` vs `std/platform.linux.milo`. The resolver picks the right one for your host.

Next: [C FFI →](./ffi)
