# std/csv

## std/csv

### `csvParse`

```milo
fn csvParse(input: &string): Vec<Vec<string>>
```

Parse a CSV string into a Vec of rows, each row a Vec of fields.

### `csvStringify`

```milo
fn csvStringify(rows: &Vec<Vec<string>>): string
```

Serialize rows to a CSV string.
