# std/binary

Fixed-width integer and float codecs over a byte buffer — the `encoding/binary` /
`byteorder` / `Buffer.readUInt32LE` layer.

```milo
from "std/binary" import { Bytes }
```

A Milo `string` is an owned byte buffer, and it is what file-format code carries its
bytes in, so reads take `&string` plus a byte offset and writes append to a
`&mut string`.

## Reads return `Option`

A read yields `Option.None` when fewer than the needed bytes remain at the offset,
or when the offset is negative. Nothing aborts, and nothing comes back as a
plausible zero.

That is deliberate. `src[i]` is an *index* — a claim by you that the position is
valid, and a bad claim is a bug worth trapping on. A decode at an offset that came
out of the data being decoded is the opposite situation: the input is untrusted, and
truncation is an ordinary thing for a file or a network frame to be. `Option.None`
is what lets a parser answer a truncated input with a parse error instead of dying,
and — unlike a zero-filled read — it can't be mistaken for a value that was really
there.

```milo
// a parser turns the None into its own error, once, in a helper
fn le32(src: &string, p: i64): Result<i64, string> {
    let Option.Some(v) = Bytes.readU32Le(src, p) else {
        return Result.Err("truncated archive")
    }
    return Result.Ok(v as i64)
}
```

## Reading

`Bytes.readU8` / `readI8`, and `Le`/`Be` pairs for every wider type:

```milo
fn Bytes.readU16Le(src: &string, off: i64): Option<u16>   // also Be, and I16
fn Bytes.readU32Le(src: &string, off: i64): Option<u32>   // also Be, and I32
fn Bytes.readU64Le(src: &string, off: i64): Option<u64>   // also Be, and I64
fn Bytes.readF32Le(src: &string, off: i64): Option<f32>   // also Be
fn Bytes.readF64Le(src: &string, off: i64): Option<f64>   // also Be
```

The signed forms are the two's-complement reinterpretation of the same bytes, so
`readI16Be` over `ff ff` is `-1`, not `65535`.

```milo
let hdr = readFile("frame.bin")?
let magic = Bytes.readU32Be(hdr, 0)
let temp = Bytes.readI16Le(hdr, 8)   // -40 stays -40
```

`Bytes.has(src, off, n)` answers the bounds question directly when you want to check
once and then read several fields.

## Writing

Writes append and cannot fail, so they return `void`:

```milo
var out = ""
Bytes.writeU32Be(&mut out, body.len as u32)   // body.len is i64 — the cast is required
Bytes.writeI16Le(&mut out, -40)               // a literal adopts the parameter's type
Bytes.writeF64Le(&mut out, 1.5)
```

A literal needs no cast: it takes the width from the parameter it is passed to. A
*value* of another width does, and that `as u32` is where one too large for the field
gets truncated — spelling it at the call site is what keeps the truncation visible.

## Float bits

`Bytes.f64ToBits` / `f64FromBits` (and the `f32` pair) expose the raw IEEE-754 bit
pattern. `as` between a float and an integer converts the *value*; these convert the
*representation*, which is what the `readF*`/`writeF*` pairs are built on.

```milo
print(Bytes.f64ToBits(1.5))   // 4609434218613702656
```
