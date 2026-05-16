# std/datetime

Date and time formatting from epoch timestamps.

```milo
from "std/datetime" import { DateTime, dateTimeNow, dateTimeFormat, weekdayName, monthName }
```

## Types

### DateTime

```milo
struct DateTime {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    weekday: i32,
}
```

A broken-down calendar date and time.

## Functions

### dateTimeFromEpoch

```milo
fn dateTimeFromEpoch(epoch: i64): DateTime
```

Converts a Unix epoch timestamp (seconds) into a `DateTime`.

### dateTimeNow

```milo
fn dateTimeNow(): DateTime
```

Returns the current date and time.

### dateTimeFormat

```milo
fn dateTimeFormat(dt: &DateTime): string
```

Formats as a full date-time string (e.g. `"2026-05-15 10:30:00"`).

### dateTimeFormatDate

```milo
fn dateTimeFormatDate(dt: &DateTime): string
```

Formats the date portion only (e.g. `"2026-05-15"`).

### dateTimeFormatTime

```milo
fn dateTimeFormatTime(dt: &DateTime): string
```

Formats the time portion only (e.g. `"10:30:00"`).

### weekdayName

```milo
fn weekdayName(weekday: i32): string
```

Returns the English name for a weekday (0 = Sunday).

### monthName

```milo
fn monthName(month: i32): string
```

Returns the English name for a month (1 = January).

## Example

```milo
let dt = dateTimeNow()
print(dateTimeFormat(&dt))
print(weekdayName(dt.weekday) + ", " + monthName(dt.month))
```
