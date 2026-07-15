# Example Programs

Every example is a single `.milo` file that compiles to a small native binary. They double as integration tests for the standard library.

## CLI tools

Located in [`examples/cli-tools/`](https://github.com/cs01/milo/tree/main/examples/cli-tools).

| Program | Description |
|---------|-------------|
| [grep](https://github.com/cs01/milo/blob/main/examples/cli-tools/grep.milo) | Pattern search with color highlighting, `-i`, `-n`, `-c`, `-v` |
| [rg](https://github.com/cs01/milo/blob/main/examples/cli-tools/rg.milo) | ripgrep-lite: regex-powered recursive search |
| [jq](https://github.com/cs01/milo/blob/main/examples/cli-tools/jq.milo) | JSON query tool (field access, array iteration) |
| [tree](https://github.com/cs01/milo/blob/main/examples/cli-tools/tree.milo) | Recursive directory tree with depth limiting |
| [cat](https://github.com/cs01/milo/blob/main/examples/cli-tools/cat.milo) | File viewer with line numbers and syntax highlighting |
| [wc](https://github.com/cs01/milo/blob/main/examples/cli-tools/wc.milo) | Line/word/char counter |
| [hex](https://github.com/cs01/milo/blob/main/examples/cli-tools/hex.milo) | Hex dump viewer with ASCII column |
| [shuf](https://github.com/cs01/milo/blob/main/examples/cli-tools/shuf.milo) | Shuffle input lines |
| [calc](https://github.com/cs01/milo/blob/main/examples/cli-tools/calc.milo) | Expression evaluator |
| [parallel](https://github.com/cs01/milo/blob/main/examples/cli-tools/parallel.milo) | Run shell commands in parallel across input lines (fork-based) |
| [timeout](https://github.com/cs01/milo/blob/main/examples/cli-tools/timeout.milo) | Run a command with a time limit |
| [fmt](https://github.com/cs01/milo/blob/main/examples/cli-tools/fmt.milo) | Milo source formatter |
| [pkg](https://github.com/cs01/milo/blob/main/examples/cli-tools/pkg.milo) | Package manager for Milo |

## Apps

Located in [`examples/apps/`](https://github.com/cs01/milo/tree/main/examples/apps). The emulators, terminal apps, and servers are covered on the [Demos & Showcase](/demos) page; the rest:

| Program | Description |
|---------|-------------|
| [httpClient](https://github.com/cs01/milo/blob/main/examples/apps/httpClient.milo) | HTTP client for fetching URLs |
| [fetch](https://github.com/cs01/milo/blob/main/examples/apps/fetch.milo) | Fetch an HTTP API over TLS and parse the JSON response |
| [kvstore](https://github.com/cs01/milo/blob/main/examples/apps/kvstore.milo) | Page-based key-value store with cursors |
| [minilang](https://github.com/cs01/milo/blob/main/examples/apps/minilang.milo) | Tree-walking interpreter for a small expression language |

## Running an example

```bash
bun run src/main.ts run examples/cli-tools/grep.milo -- "hello" myfile.txt
bun run src/main.ts build examples/apps/serve.milo -o serve && ./serve
```

## A taste: grep in Milo

```milo
from "std/argparse" import { newParser }
from "std/io" import { readLines }

fn main(): i32 {
    var parser = newParser("grep", "search for a string pattern in files")
    parser.addPositional("pattern", "string pattern to search for")
    parser.addPositional("file", "file to search")
    parser.addBool("ignore-case", "i", "case-insensitive search")
    parser.addBool("line-number", "n", "show line numbers")
    parser.addBool("count", "c", "only print count of matching lines")
    let args = parser.parse()

    let pattern = args.getString("pattern")
    let filePath = args.getString("file")

    let content = readFile(filePath)!
    let lines = content.split("\n")

    for line in lines {
        if line.contains(pattern) {
            print(line)
        }
    }
    return 0
}
```
