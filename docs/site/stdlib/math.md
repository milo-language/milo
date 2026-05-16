# std/math

Mathematical functions and constants.

```milo
from "std/math" import { mathSqrt, mathPow, mathPi, minI64, maxI64, clampF64 }
```

## Functions

### Floating-Point Math

```milo
fn mathSqrt(x: f64): f64
fn mathPow(base: f64, exp: f64): f64
fn mathSin(x: f64): f64
fn mathCos(x: f64): f64
fn mathTan(x: f64): f64
fn mathAtan2(y: f64, x: f64): f64
fn mathFloor(x: f64): f64
fn mathCeil(x: f64): f64
fn mathRound(x: f64): f64
fn mathAbs(x: f64): f64
fn mathMod(x: f64, y: f64): f64
fn mathLog(x: f64): f64
fn mathLog2(x: f64): f64
fn mathLog10(x: f64): f64
fn mathExp(x: f64): f64
```

### Integer Math

```milo
fn absI64(x: i64): i64
fn absI32(x: i32): i32
fn minI64(a: i64, b: i64): i64
fn maxI64(a: i64, b: i64): i64
fn minI32(a: i32, b: i32): i32
fn maxI32(a: i32, b: i32): i32
fn minF64(a: f64, b: f64): f64
fn maxF64(a: f64, b: f64): f64
fn clampI64(x: i64, lo: i64, hi: i64): i64
fn clampF64(x: f64, lo: f64, hi: f64): f64
```

### Constants

```milo
fn mathPi(): f64
fn mathE(): f64
fn mathInf(): f64
```
