# std/color

ANSI terminal color and style formatting.

```milo
from "std/color" import { Color }
```

## Functions

### Text Colors

```milo
fn Color.red(s: &string): string
fn Color.green(s: &string): string
fn Color.yellow(s: &string): string
fn Color.blue(s: &string): string
fn Color.magenta(s: &string): string
fn Color.cyan(s: &string): string
fn Color.white(s: &string): string
fn Color.gray(s: &string): string
```

### Background Colors

```milo
fn Color.bgRed(s: &string): string
fn Color.bgGreen(s: &string): string
fn Color.bgYellow(s: &string): string
fn Color.bgBlue(s: &string): string
```

### Styles

```milo
fn Color.bold(s: &string): string
fn Color.dim(s: &string): string
fn Color.italic(s: &string): string
fn Color.underline(s: &string): string
fn Color.strikethrough(s: &string): string
```

## Example

```milo
print(Color.bold(Color.red("error:")) + " something went wrong")
print(Color.green("ok") + " " + Color.dim("(3 tests passed)"))
```
