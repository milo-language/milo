# std/csv

## std/csv

### `csvParse`

```milo
pub fn csvParse(input: &string): Vec<Vec<string>>
```

Parse a CSV string into a Vec of rows, each row a Vec of fields.

### `csvQuoteField`

```milo
fn csvQuoteField(val: &string): string
```

Quote a field if it contains commas, quotes, or newlines.

### `csvStringify`

```milo
pub fn csvStringify(rows: &Vec<Vec<string>>): string
```

Serialize rows to a CSV string.
