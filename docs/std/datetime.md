# std/datetime

## std/datetime

### `DateTime.format`

```milo
fn DateTime.format(self: &DateTime): string
```

ISO 8601: 2024-03-15T14:30:00

### `DateTime.formatDate`

```milo
fn DateTime.formatDate(self: &DateTime): string
```

The date portion only: 2024-03-15.

### `DateTime.formatTime`

```milo
fn DateTime.formatTime(self: &DateTime): string
```

The time portion only: 14:30:00.

### `DateTime.fromEpoch`

```milo
fn DateTime.fromEpoch(epochSec: i64): DateTime
```

Components in UTC for the given epoch seconds.

### `DateTime.fromEpochLocal`

```milo
fn DateTime.fromEpochLocal(epochSec: i64): DateTime
```

Same components as fromEpoch but in the host timezone (TZ env /
/etc/localtime). struct tm leads with nine consecutive ints
(tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday,
tm_isdst) on both macOS and glibc — only those leading fields are read, so
the trailing platform differences (tm_gmtoff/tm_zone) don't matter.

### `DateTime.localNow`

```milo
fn DateTime.localNow(): DateTime
```

Current time in the host timezone.

### `DateTime.now`

```milo
fn DateTime.now(): DateTime
```

Current UTC time.

### `monthName`

```milo
pub fn monthName(m: i32): string
```

English name for a month, 1 = January.

### `weekdayName`

```milo
pub fn weekdayName(wd: i32): string
```

English name for a weekday, 0 = Sunday.
