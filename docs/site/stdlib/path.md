# std/path

Path manipulation utilities.

```milo
from "std/path" import { pathJoin, pathBasename, pathDirname, pathExt, pathStem }
```

## Functions

### pathExt

```milo
fn pathExt(path: &string): string
```

Extract the file extension including the dot. Returns `""` if none.

```milo
pathExt("archive.tar.gz")  // ".gz"
```

### pathBasename

```milo
fn pathBasename(path: &string): string
```

Extract the final component of a path.

```milo
pathBasename("/home/user/file.txt")  // "file.txt"
```

### pathDirname

```milo
fn pathDirname(path: &string): string
```

Extract the directory portion of a path.

```milo
pathDirname("/home/user/file.txt")  // "/home/user"
```

### pathJoin

```milo
fn pathJoin(a: &string, b: &string): string
```

Join two path segments with a separator.

```milo
pathJoin("/home/user", "docs")  // "/home/user/docs"
```

### pathStem

```milo
fn pathStem(path: &string): string
```

Extract the filename without its extension.

```milo
pathStem("report.pdf")  // "report"
```
