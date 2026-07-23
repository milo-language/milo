# std/unicode

## std/unicode

### `charWidth`

```milo
fn charWidth(cp: i32): i64
```

Terminal cells occupied by a single codepoint: 0, 1, or 2.

Control characters report 0 because they advance no column when printed —
callers that need to reject them should filter before measuring, not rely on
a negative sentinel.

### `codepointCount`

```milo
fn codepointCount(s: &string): i64
```

Number of Unicode codepoints in a string (not bytes).

### `codepoints`

```milo
fn codepoints(s: &string): Vec<i32>
```

Decode UTF-8 string into Unicode codepoints. Allocates; prefer
decodeCodepoint in a scan loop.

### `decodeCodepoint`

```milo
fn decodeCodepoint(s: &string, at: i64): CodePoint
```

Decode the UTF-8 codepoint starting at byte offset `at`, without allocating.
This is the primitive to scan text with: a lexer keeps its own byte cursor and
advances by `.size`, so no Vec<i32> is materialized just to walk a string.

Malformed input never reads out of bounds and never returns a partial
codepoint: a bad lead byte, a truncated tail, or a non-continuation byte all
yield U+FFFD with size 1, so a scan advances and terminates on any input.
Overlong forms and surrogate-range values are rejected the same way, which is
what keeps decode/encode round-trips honest.

### `displayWidth`

```milo
fn displayWidth(s: &string): i64
```

Columns a string occupies in a terminal.

Measured over grapheme clusters, not codepoints, so the multi-codepoint
sequences that real text is full of collapse to the one glyph a terminal
actually paints: ZWJ emoji sequences (family, professions) count once, a
flag's two regional indicators count once, skin tones and variation
selectors fold into the emoji they modify.

### `encodeCodepoint`

```milo
fn encodeCodepoint(out: &mut string, cp: i32): void
```

Append `cp` to `out` as UTF-8. Invalid codepoints encode as U+FFFD rather
than emitting bytes that would not decode back.

### `fromSurrogatePair`

```milo
fn fromSurrogatePair(high: i32, low: i32): i32
```

Combine a surrogate pair back into a single codepoint.

### `highSurrogate`

```milo
fn highSurrogate(cp: i32): i32
```

_Undocumented._

### `isAlpha`

```milo
fn isAlpha(ch: u8): bool
```

_Undocumented._

### `isAlphanumeric`

```milo
fn isAlphanumeric(ch: u8): bool
```

_Undocumented._

### `isAlphaStr`

```milo
fn isAlphaStr(s: &string): bool
```

Check if an entire string is alphabetic.

### `isAscii`

```milo
fn isAscii(ch: u8): bool
```

Classify ASCII bytes.

### `isCombining`

```milo
fn isCombining(cp: i32): bool
```

Marks that attach to a preceding base character and advance no column.

### `isControl`

```milo
fn isControl(ch: u8): bool
```

_Undocumented._

### `isDigit`

```milo
fn isDigit(ch: u8): bool
```

_Undocumented._

### `isHexDigit`

```milo
fn isHexDigit(ch: u8): bool
```

_Undocumented._

### `isLower`

```milo
fn isLower(ch: u8): bool
```

_Undocumented._

### `isNumeric`

```milo
fn isNumeric(s: &string): bool
```

Check if an entire string is numeric (all digits).

### `isPrintable`

```milo
fn isPrintable(ch: u8): bool
```

_Undocumented._

### `isPunctuation`

```milo
fn isPunctuation(ch: u8): bool
```

_Undocumented._

### `isRegionalIndicator`

```milo
fn isRegionalIndicator(cp: i32): bool
```

Regional indicator symbols — two in a row form one flag glyph.

### `isSkinToneModifier`

```milo
fn isSkinToneModifier(cp: i32): bool
```

Emoji skin-tone modifiers, absorbed by the emoji they follow.

### `isSupplementary`

```milo
fn isSupplementary(cp: i32): bool
```

UTF-16 conversion. A codepoint above the BMP is a single codepoint but TWO
UTF-16 code units, encoded as a surrogate pair — so a byte- or
codepoint-oriented count is not a UTF-16 index. Needed by anything crossing a
UTF-16 boundary (Windows wide-char APIs, JVM strings).

### `isUpper`

```milo
fn isUpper(ch: u8): bool
```

_Undocumented._

### `isWhitespace`

```milo
fn isWhitespace(ch: u8): bool
```

_Undocumented._

### `isWide`

```milo
fn isWide(cp: i32): bool
```

East Asian Wide/Fullwidth plus the emoji blocks that render double-width.

### `isZeroWidthFormat`

```milo
fn isZeroWidthFormat(cp: i32): bool
```

Format/invisible characters: joiners, bidi controls, variation selectors, BOM.

### `lowSurrogate`

```milo
fn lowSurrogate(cp: i32): i32
```

_Undocumented._

### `nextCodepointBoundary`

```milo
fn nextCodepointBoundary(s: &string, at: i64): i64
```

Byte offset of the next codepoint boundary at or after `at`.

### `toLowerChar`

```milo
fn toLowerChar(ch: u8): u8
```

Case conversion for ASCII bytes.

### `toUpperChar`

```milo
fn toUpperChar(ch: u8): u8
```

_Undocumented._

### `truncateToWidth`

```milo
fn truncateToWidth(s: &string, maxCols: i64): i64
```

Byte offset just past the longest prefix of `s` that fits in `maxCols`
columns. Never splits a codepoint, and never leaves half of a double-width
glyph — a wide character that would straddle the limit is excluded entirely.

### `utf16UnitCount`

```milo
fn utf16UnitCount(cp: i32): i64
```

_Undocumented._
