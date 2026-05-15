# Example Programs

Milo ships real CLI tools and apps as examples — all compile to small native binaries.

## CLI Tools

Located in `examples/cli-tools/`.

| Program | Description |
|---------|-------------|
| [grep](https://github.com/cs01/milo/blob/main/examples/cli-tools/grep.milo) | Pattern search with color highlighting, `-i`, `-n`, `-c`, `-v` |
| [wc](https://github.com/cs01/milo/blob/main/examples/cli-tools/wc.milo) | Line/word/char counter |
| [hex](https://github.com/cs01/milo/blob/main/examples/cli-tools/hex.milo) | Hex dump viewer with ASCII column |
| [tree](https://github.com/cs01/milo/blob/main/examples/cli-tools/tree.milo) | Recursive directory tree with depth limiting |
| [cat](https://github.com/cs01/milo/blob/main/examples/cli-tools/cat.milo) | File viewer with syntax highlighting |
| [jq](https://github.com/cs01/milo/blob/main/examples/cli-tools/jq.milo) | JSON query tool (field access, array iteration) |

## Apps

Located in `examples/apps/`.

| Program | Description |
|---------|-------------|
| [serve](https://github.com/cs01/milo/blob/main/examples/apps/serve.milo) | Static file server with directory listing |
| [http](https://github.com/cs01/milo/blob/main/examples/apps/http.milo) | HTTP client with JSON pretty-printing |
| [webserver](https://github.com/cs01/milo/blob/main/examples/apps/webserver.milo) | HTTP server with routing |
| [fetch](https://github.com/cs01/milo/blob/main/examples/apps/fetch.milo) | HTTP client with TLS |

## Running an example

```bash
bun run src/main.ts run examples/cli-tools/grep.milo -- "hello" myfile.txt
bun run src/main.ts build examples/apps/serve.milo -o serve && ./serve
```

## A taste: grep in Milo

```milo
import "std/argparse"
import "std/io"

fn main(): i32 {
    var parser = new_parser("grep", "search for a string pattern in files")
    parser.add_positional("pattern", "string pattern to search for")
    parser.add_positional("file", "file to search")
    parser.add_bool("ignore-case", "i", "case-insensitive search")
    parser.add_bool("line-number", "n", "show line numbers")
    parser.add_bool("count", "c", "only print count of matching lines")
    let args = parser.parse()

    let pattern = args.get_string("pattern")
    let filePath = args.get_string("file")

    let content = read_file(filePath)!
    let lines = content.split("\n")

    var lineNum: i64 = 0
    while lineNum < lines.len {
        let line = lines[lineNum]
        if line.contains(pattern) {
            print(line)
        }
        lineNum = lineNum + 1
    }
    return 0
}
```
