# std/base32

## std/base32

### `base32Decode`

```milo
fn base32Decode(input: &string): string
```

Decode a Base32 string to bytes. Padding, whitespace, and case are tolerated;
any other character is skipped so lightly-formatted secrets still decode.

### `base32Encode`

```milo
fn base32Encode(input: &string): string
```

Encode bytes to a padded Base32 string.
