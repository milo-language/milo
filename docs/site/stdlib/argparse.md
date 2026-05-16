# std/argparse

CLI argument parsing with typed flags, positional args, and auto-generated help text.

```milo
from "std/argparse" import { ArgParser, ParsedArgs, newParser }
```

## Types

### FlagDef

```milo
struct FlagDef {
    long: string,
    short: string,
    description: string,
    required: bool,
    isBool: bool,
}
```

### PositionalDef

```milo
struct PositionalDef {
    name: string,
    description: string,
    required: bool,
}
```

### ArgEntry

```milo
struct ArgEntry {
    key: string,
    value: string,
}
```

### ArgParser

```milo
struct ArgParser {
    name: string,
    description: string,
    flags: Vec<FlagDef>,
    positionals: Vec<PositionalDef>,
}
```

#### Methods

### addString

```milo
fn addString(parser: &ArgParser, long: string, short: string, description: string)
```

Register an optional string flag (e.g. `--output`, `-o`).

### addRequired

```milo
fn addRequired(parser: &ArgParser, long: string, short: string, description: string)
```

Register a required string flag. Parsing fails if omitted.

### addBool

```milo
fn addBool(parser: &ArgParser, long: string, short: string, description: string)
```

Register a boolean flag. Present = true, absent = false.

### addPositional

```milo
fn addPositional(parser: &ArgParser, name: string, description: string)
```

Register a required positional argument.

### addOptionalPositional

```milo
fn addOptionalPositional(parser: &ArgParser, name: string, description: string)
```

Register an optional positional argument.

### helpText

```milo
fn helpText(parser: &ArgParser): string
```

Generate a formatted help/usage string.

### parse

```milo
fn parse(parser: &ArgParser, args: Vec<string>): Result<ParsedArgs>
```

Parse a vector of CLI arguments against the registered flags and positionals.

### ParsedArgs

```milo
struct ParsedArgs {
    entries: Vec<ArgEntry>,
}
```

#### Methods

### getString

```milo
fn getString(args: &ParsedArgs, key: &string): Option<string>
```

Get a string value by flag name or positional name.

### getI64

```milo
fn getI64(args: &ParsedArgs, key: &string): Option<i64>
```

Get a value parsed as `i64`.

### getU16

```milo
fn getU16(args: &ParsedArgs, key: &string): Option<u16>
```

Get a value parsed as `u16`.

### getBool

```milo
fn getBool(args: &ParsedArgs, key: &string): bool
```

Returns `true` if the boolean flag was present.

### has

```milo
fn has(args: &ParsedArgs, key: &string): bool
```

Check whether a key exists in the parsed results.

## Functions

### newParser

```milo
fn newParser(name: string, description: string): ArgParser
```

Create a new argument parser with the given program name and description.

## Example: CLI Tool

```milo
from "std/argparse" import { newParser, ArgParser, ParsedArgs }
from "std/io" import { print, writeStdout }
from "std/process" import { exit }

fn main(): i32 {
    var parser = newParser("greet", "A greeting tool")
    addRequired(&parser, "name", "n", "Name to greet")
    addBool(&parser, "loud", "l", "Shout the greeting")
    addOptionalPositional(&parser, "title", "Optional title prefix")

    let args = osArgs()
    match parse(&parser, args) {
        Ok(parsed) => {
            let name = getString(&parsed, "name")!
            let title = getString(&parsed, "title")
            let titleStr = match title {
                Some(t) => t,
                None => "",
            }
            let greeting = if titleStr != "" { titleStr + " " + name } else { name }

            if getBool(&parsed, "loud") {
                print("HELLO, " + greeting + "!")
            } else {
                print("Hello, " + greeting)
            }
        },
        Err(e) => {
            print(e)
            print(helpText(&parser))
            exit(1)
        },
    }

    return 0
}
```
