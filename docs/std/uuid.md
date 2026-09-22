# std/uuid

## std/uuid

### `Uuid.isNil`

```milo
fn Uuid.isNil(self: &Uuid): bool
```

True for the all-zero UUID, the conventional "no id yet" sentinel.

### `Uuid.nil`

```milo
fn Uuid.nil(): Uuid
```

The all-zero UUID, 00000000-0000-0000-0000-000000000000.

### `Uuid.parse`

```milo
fn Uuid.parse(s: &string): Option<Uuid>
```

Parse the canonical 8-4-4-4-12 hex form, e.g.
"550e8400-e29b-41d4-a716-446655440000". Case-insensitive. Returns None for
anything else — no braces, no "urn:uuid:" prefix, no unhyphenated form.

### `Uuid.timestampMs`

```milo
fn Uuid.timestampMs(self: &Uuid): i64
```

Unix-epoch milliseconds encoded in a v7 UUID. Meaningless for other
versions, so check `version() == 7` first.

### `Uuid.toString`

```milo
fn Uuid.toString(self: &Uuid): string
```

Canonical lowercase text form, 36 characters.

### `Uuid.v4`

```milo
fn Uuid.v4(): Uuid
```

Random UUID (version 4): 122 random bits.

The bits come from the OS CSPRNG.

### `Uuid.v7`

```milo
fn Uuid.v7(): Uuid
```

Time-ordered UUID (version 7): 48-bit Unix-epoch millisecond prefix, a
12-bit monotonic counter, then random bits. Lexicographic order of the text
form matches creation order, which is what makes v7 the better default for
database keys.

Ids minted inside the same millisecond still sort in creation order. The counter
is per process and not synchronized across threads: a racing thread can reuse a
counter value, which costs ordering but not uniqueness.

### `Uuid.variant`

```milo
fn Uuid.variant(self: &Uuid): i32
```

Variant field: 2 for the RFC 4122/9562 variant (10xx), 0 for the nil UUID
and other NCS-reserved values, 6 for the legacy Microsoft variant, 7 reserved.

### `Uuid.version`

```milo
fn Uuid.version(self: &Uuid): i32
```

Version nibble: 4 for v4, 7 for v7, 0 for the nil UUID.
