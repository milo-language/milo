# std/datetime

## std/datetime

### `dateTimeFormat`

```milo
fn dateTimeFormat(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFormatDate`

```milo
fn dateTimeFormatDate(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFormatTime`

```milo
fn dateTimeFormatTime(dt: &DateTime): string
```

_Undocumented._

### `dateTimeFromEpoch`

```milo
fn dateTimeFromEpoch(epochSec: i64): DateTime
```

_Undocumented._

### `dateTimeFromEpochLocal`

```milo
fn dateTimeFromEpochLocal(epochSec: i64): DateTime
```

Same components as dateTimeFromEpoch but in the host timezone (TZ env /
/etc/localtime). struct tm leads with nine consecutive ints
(tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday,
tm_isdst) on both macOS and glibc — only those leading fields are read, so
the trailing platform differences (tm_gmtoff/tm_zone) don't matter.

### `dateTimeLocalNow`

```milo
fn dateTimeLocalNow(): DateTime
```

_Undocumented._

### `dateTimeNow`

```milo
fn dateTimeNow(): DateTime
```

_Undocumented._

### `monthName`

```milo
fn monthName(m: i32): string
```

_Undocumented._

### `weekdayName`

```milo
fn weekdayName(wd: i32): string
```

_Undocumented._
