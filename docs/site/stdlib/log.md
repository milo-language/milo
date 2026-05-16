# std/log

Logging to stderr at four severity levels.

```milo
from "std/log" import { logDebug, logInfo, logWarn, logError }
```

## Functions

### logDebug

```milo
fn logDebug(msg: string)
```

Writes a debug-level message to stderr.

### logInfo

```milo
fn logInfo(msg: string)
```

Writes an info-level message to stderr.

### logWarn

```milo
fn logWarn(msg: string)
```

Writes a warning-level message to stderr.

### logError

```milo
fn logError(msg: string)
```

Writes an error-level message to stderr.
