# std/datetime

## std/datetime

### `dateTimeFormat`

```milo
pub fn dateTimeFormat(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFormatDate`

```milo
pub fn dateTimeFormatDate(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFormatTime`

```milo
pub fn dateTimeFormatTime(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFromEpoch`

```milo
pub fn dateTimeFromEpoch(epochSec: i64): DateTime
```

_Undocumented._

### `dateTimeFromEpochLocal`

```milo
pub fn dateTimeFromEpochLocal(epochSec: i64): DateTime
```

Same components as dateTimeFromEpoch but in the host timezone (TZ env /
/etc/localtime). struct tm leads with nine consecutive ints
(tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday,
tm_isdst) on both macOS and glibc — only those leading fields are read, so
the trailing platform differences (tm_gmtoff/tm_zone) don't matter.

### `dateTimeLocalNow`

```milo
pub fn dateTimeLocalNow(): DateTime
```

_Undocumented._

### `dateTimeNow`

```milo
pub fn dateTimeNow(): DateTime
```

_Undocumented._

### `monthName`

```milo
pub fn monthName(m: i32): string
```

_Undocumented._

### `padI32`

```milo
fn padI32(val: i32, width: i32): string
```

_Undocumented._

### `tmI32`

```milo
fn tmI32(buf: &[u8; 128], off: i64): i32
```

Little-endian i32 read out of the struct tm buffer.

### `weekdayName`

```milo
pub fn weekdayName(wd: i32): string
```

_Undocumented._
