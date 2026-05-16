# std/base64

Base64 encoding and decoding.

```milo
from "std/base64" import { base64Encode, base64Decode }
```

## Functions

### base64Encode

```milo
fn base64Encode(input: &string): string
```

Encodes a string to Base64.

### base64Decode

```milo
fn base64Decode(input: &string): string
```

Decodes a Base64 string back to its original form.

```milo
let encoded = base64Encode(&"hello world")
let decoded = base64Decode(&encoded)
print(decoded)  // hello world
```
