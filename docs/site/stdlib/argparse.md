# std/argparse

CLI argument parsing with typed flags, positional args, and auto-generated help text.

```milo
from "std/argparse" import { ArgParser, ParsedArgs, newParser }
```

## Quick start

```milo
from "std/argparse" import { newParser, ArgParser, ParsedArgs }

fn main(): i32 {
    var parser = newParser("greet", "A greeting tool")
    parser.addRequired("name", "n", "Name to greet")
    parser.addBool("loud", "l", "Shout the greeting")
    parser.addOptionalPositional("title", "Optional title prefix")

    let args = parser.parse()
    let name = args.getString("name")

    if args.getBool("loud") {
        print($"HELLO, {name}!")
    } else {
        print($"Hello, {name}")
    }

    return 0
}
```

```bash
$ greet --name Alice --loud
HELLO, Alice!

$ greet --help
greet - A greeting tool

usage: greet [options] [title]

arguments:
  <title>                     Optional title prefix

options:
  -n, --name <value>          Name to greet (required)
  -l, --loud                  Shout the greeting
  -h, --help                  Show this help message
```

Define flags, call `parse()`, access typed values. `--help` is generated automatically. Missing required flags print an error with usage.

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

