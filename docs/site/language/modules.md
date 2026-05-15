# Modules & Imports

## Import a file

```milo
import "math.milo"
```

Imports everything from the file into the current scope.

## Named imports

```milo
from "std/http" import { Request, Response, serve }
```

## Relative imports

```milo
from "lib/math" import { add }
```

## Standard library imports

```milo
import "std/io"
import "std/fs"
import "std/net"
import "std/argparse"
```

Standard library modules are auto-discovered via `import "std/<name>"`.

## How it works

Imports are resolved recursively and deduplicated. The resolver merges all imported ASTs before type checking — there's no separate compilation yet.

Platform-specific modules use suffix-based selection: `std/platform.darwin.milo` vs `std/platform.linux.milo`. The resolver picks the right one for your host.

Next: [C FFI →](./ffi)
