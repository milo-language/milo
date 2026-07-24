# std/path

## std/path

### `pathBasename`

```milo
pub fn pathBasename(path: &string): string
```

Final component of the path (the file name), directories stripped.

### `pathDirname`

```milo
pub fn pathDirname(path: &string): string
```

Directory portion of the path (everything before the final component).

### `pathExt`

```milo
pub fn pathExt(path: &string): string
```

File extension including the leading dot (e.g. ".txt"); empty if none.

### `pathJoin`

```milo
pub fn pathJoin(a: &string, b: &string): string
```

Join two segments with a single "/" separator (avoids doubling an existing one).

### `pathStem`

```milo
pub fn pathStem(path: &string): string
```

File name without its extension (basename minus pathExt).
