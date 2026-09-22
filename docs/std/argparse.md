# std/argparse

## std/argparse

### `ArgParser.addBool`

```milo
fn ArgParser.addBool(self: &mut ArgParser, long: string, short: string, help: string): void
```

Add a boolean flag (present = true, absent = false).

### `ArgParser.addI64`

```milo
fn ArgParser.addI64(self: &mut ArgParser, long: string, short: string, help: string, defaultVal: i64): void
```

Add an integer flag with a default value. Validated as numeric at parse time.

### `ArgParser.addOptionalPositional`

```milo
fn ArgParser.addOptionalPositional(self: &mut ArgParser, name: string, help: string): void
```

Add an optional positional argument.

### `ArgParser.addPositional`

```milo
fn ArgParser.addPositional(self: &mut ArgParser, name: string, help: string): void
```

Add a required positional argument.

### `ArgParser.addRequired`

```milo
fn ArgParser.addRequired(self: &mut ArgParser, long: string, short: string, help: string): void
```

Add a required string flag. parse() exits with error if missing.

### `ArgParser.addString`

```milo
fn ArgParser.addString(self: &mut ArgParser, long: string, short: string, help: string, defaultVal: string): void
```

Add a string flag with long name, short alias, help text, and default.
Example: parser.addString("output", "o", "Output file", "out.txt")

Pass "" as `defaultVal` for no default.

### `ArgParser.enableIgnoreUnknown`

```milo
fn ArgParser.enableIgnoreUnknown(self: &mut ArgParser): void
```

Silently skip unrecognized flags instead of exiting with an error.

### `ArgParser.enableTrailingArgs`

```milo
fn ArgParser.enableTrailingArgs(self: &mut ArgParser): void
```

Stop flag parsing after the first positional arg.
Remaining args collected as positionals without interpretation.

For a runtime or wrapper: flags before the command are yours, everything after
belongs to the child. A `--` separator always ends flag parsing, whatever this
setting.

### `ArgParser.helpText`

```milo
fn ArgParser.helpText(self: &ArgParser): string
```

Generate formatted help text for all registered flags.

### `ArgParser.new`

```milo
fn ArgParser.new(name: string, description: string): ArgParser
```

Create a parser with a program name and description.

### `ArgParser.parse`

```milo
fn ArgParser.parse(self: &ArgParser): ParsedArgs
```

Parse command-line arguments and return ParsedArgs.
Automatically handles --help. Exits on invalid input.

Returns no Result: a missing required flag prints usage and exits, so the value
is always usable. `parseFrom` takes the argv vector instead, which is what a test
wants.

### `ArgParser.parseFrom`

```milo
fn ArgParser.parseFrom(self: &ArgParser, argv: Vec<string>): ParsedArgs
```

Parse from a provided argument list instead of process args.
argv[0] is treated as the program name (skipped during parsing).
Like Python's parse_args(args=[...]).

### `ArgParser.setEpilog`

```milo
fn ArgParser.setEpilog(self: &mut ArgParser, text: string): void
```

Text printed at the end of --help, after the options.
Example: parser.setEpilog("controls:\n  UP / DOWN   pitch")

### `ParsedArgs.getBool`

```milo
fn ParsedArgs.getBool(self: &ParsedArgs, name: &string): bool
```

Check if a boolean flag was set.

### `ParsedArgs.getI64`

```milo
fn ParsedArgs.getI64(self: &ParsedArgs, name: &string): i64
```

Get an integer value of a flag. Exits if the value is not numeric.

### `ParsedArgs.getString`

```milo
fn ParsedArgs.getString(self: &ParsedArgs, name: &string): Option<string>
```

Value of the flag or positional `name`, or None if it has no value:
either `name` was never declared, or it was declared with no default and
not supplied. `--name ""` is supplied, so it is Some("").

A declared default is the value when the flag is absent, so it comes back
as Some. An empty default is how addString spells "no default" (helpText
only prints a default when it is non-empty), which is why the check is on
the value's length and not on a separate flag.

### `ParsedArgs.getU16`

```milo
fn ParsedArgs.getU16(self: &ParsedArgs, name: &string): u16
```

Get a u16 value of a flag. Exits if out of range 0..65535.

### `ParsedArgs.has`

```milo
fn ParsedArgs.has(self: &ParsedArgs, name: &string): bool
```

Check if a flag was provided on the command line.
