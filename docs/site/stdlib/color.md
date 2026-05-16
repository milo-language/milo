# std/color

ANSI terminal color and style formatting.

```milo
from "std/color" import { red, green, yellow, blue, bold, dim, underline }
```

## Functions

### Text Colors

```milo
fn red(s: &string): string
fn green(s: &string): string
fn yellow(s: &string): string
fn blue(s: &string): string
fn magenta(s: &string): string
fn cyan(s: &string): string
fn white(s: &string): string
fn gray(s: &string): string
```

### Background Colors

```milo
fn bgRed(s: &string): string
fn bgGreen(s: &string): string
fn bgYellow(s: &string): string
fn bgBlue(s: &string): string
```

### Styles

```milo
fn bold(s: &string): string
fn dim(s: &string): string
fn italic(s: &string): string
fn underline(s: &string): string
fn strikethrough(s: &string): string
```

## Example

```milo
print(bold(&red(&"error:")) + " something went wrong")
print(green(&"ok") + " " + dim(&"(3 tests passed)"))
```
