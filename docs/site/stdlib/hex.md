# std/hex

Hex encoding and decoding.

```milo
from "std/hex" import { hexEncode, hexDecode }
```

## Functions

### hexEncode

```milo
fn hexEncode(input: &string): string
```

Encodes a string as hexadecimal.

### hexDecode

```milo
fn hexDecode(input: &string): string
```

Decodes a hex string back to its original form.

```milo
let encoded = hexEncode(&"hello")
print(encoded)  // 68656c6c6f
let decoded = hexDecode(&encoded)
print(decoded)  // hello
```
