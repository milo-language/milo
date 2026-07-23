# std/keys

## std/keys

### `applyModifier`

```milo
fn applyModifier(k: Key, mod: i64): Key
```

xterm encodes modifiers as a parameter of 1 + a bitmask, so `ESC [ 1;5 A`
is ctrl+Up. Applies to both CSI and SS3 forms.

### `controlKey`

```milo
fn controlKey(b: i64): Key
```

Control bytes below 0x20 double as ctrl+letter. Tab, Enter and Escape have
their own identities and are matched before falling through to ctrl+letter,
because a user pressing Tab did not press ctrl+I even though the byte is the
same.

### `decodeCsi`

```milo
fn decodeCsi(s: &string, start: i64, at: i64): Key
```

Decode a CSI sequence: the caller has already matched `ESC [`, and `at`
points just past it.

### `decodeKey`

```milo
fn decodeKey(s: &string, at: i64): Key
```

Decode one key starting at byte offset `at`.

Returns `None` with size 0 on empty input, and `Partial` with size 0 when the
bytes end mid-escape-sequence — the caller should keep the tail and retry
after reading more.

### `decodeKeyFinal`

```milo
fn decodeKeyFinal(s: &string, at: i64): Key
```

Treat a buffer known to be complete as a finished key: resolves the lone-ESC
ambiguity in favour of the Escape key. Use this after an input read has timed
out with no further bytes.

### `letterKey`

```milo
fn letterKey(b: i64): KeyCode
```

Final letter of a CSI/SS3 sequence to its key.

### `plainKey`

```milo
fn plainKey(code: KeyCode, size: i64): Key
```

_Undocumented._

### `tildeKey`

```milo
fn tildeKey(n: i64): KeyCode
```

Map the numeric parameter of a `ESC [ N ~` sequence to its key.
