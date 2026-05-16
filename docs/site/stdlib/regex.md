# std/regex

POSIX regular expressions.

```milo
from "std/regex" import { Regex, RegexMatch, regexNew, regexMatch, regexFind, regexFindAll }
```

## Types

### Regex

```milo
struct Regex {
    _preg: [u8; 128],
    _valid: bool,
}
```

A compiled regular expression. Create via `regexNew`.

### RegexMatch

```milo
struct RegexMatch {
    start: i64,
    end: i64,
}
```

A match result with byte offsets into the input string.

## Functions

### regexNew

```milo
fn regexNew(pattern: string): Option<Regex>
```

Compiles a regex pattern. Returns `None` if the pattern is invalid.

### regexMatch

```milo
fn regexMatch(re: &mut Regex, input: &string): bool
```

Returns `true` if the input matches the pattern.

### regexFind

```milo
fn regexFind(re: &mut Regex, input: &string): Option<RegexMatch>
```

Finds the first match in the input.

### regexFindAll

```milo
fn regexFindAll(re: &mut Regex, input: &string): Vec<RegexMatch>
```

Finds all non-overlapping matches in the input.

## Example

```milo
match regexNew("[0-9]+") {
    Some(re) => {
        var r = re
        if regexMatch(&mut r, &"abc123def") {
            print("found digits")
        }
        let matches = regexFindAll(&mut r, &"12 apples and 34 oranges")
        // matches[0] = {start: 0, end: 2}, matches[1] = {start: 14, end: 16}
    }
    None => print("bad pattern")
}
```
