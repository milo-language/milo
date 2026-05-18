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

## Examples

### Check if a string matches a pattern

```milo
match regexNew("[0-9]+") {
    Some(re) => {
        var r = re
        if regexMatch(&mut r, "abc123def") {
            print("found digits")
        }
    }
    None => print("bad pattern")
}
```

### Extract matches with byte offsets

```milo
match regexNew("[a-z]+") {
    Some(re) => {
        var r = re
        let m = regexFind(&mut r, "123hello456")
        match m {
            Some(hit) => {
                let word = "123hello456".substr(hit.start, hit.end)
                print(word)  // hello
            }
            None => print("no match")
        }
    }
    None => print("bad pattern")
}
```

### Find all matches

```milo
match regexNew("[0-9]+") {
    Some(re) => {
        var r = re
        let input = "12 apples and 34 oranges"
        let matches = regexFindAll(&mut r, input)
        var i: i64 = 0
        while i < matches.len {
            print(input.substr(matches[i].start, matches[i].end))
            i = i + 1
        }
        // prints: 12, 34
    }
    None => print("bad pattern")
}
```

### Validate input format

```milo
fn isEmail(s: &string): bool {
    match regexNew("^[a-zA-Z0-9.]+@[a-zA-Z0-9]+\\.[a-zA-Z]+$") {
        Some(re) => {
            var r = re
            return regexMatch(&mut r, s)
        }
        None => return false
    }
}
```

## Notes

- Uses POSIX extended regular expressions (ERE) via the system `regex.h`.
- `RegexMatch.start` and `RegexMatch.end` are byte offsets, not codepoint offsets.
- Compile the regex once and reuse it — `regexNew` is expensive relative to `regexMatch`/`regexFind`.
