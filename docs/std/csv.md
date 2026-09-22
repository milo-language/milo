# std/csv

## std/csv

### `Csv.parse`

```milo
fn Csv.parse(input: &string): Result<Vec<Vec<string>>>
```

Parse CSV text into rows of fields. Errs on an unterminated quoted field, a
bare '"' inside an unquoted field, or text after a field's closing quote.
Ragged row widths are accepted: the width a caller expects is schema policy, and a
ragged file still parsed unambiguously.

A lone CR outside a quoted field is dropped, so CRLF files parse; inside a quoted
field it is data and is kept.

### `Csv.stringify`

```milo
fn Csv.stringify(rows: &Vec<Vec<string>>): string
```

Serialize rows to CSV, quoting any field containing ',', '"', CR or LF.
