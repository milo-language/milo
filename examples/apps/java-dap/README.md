# java-dap

A standalone Debug Adapter Protocol server for the JVM, written in Milo. No
Eclipse, no jdt.ls, no JVM-side code: the JVM ships its debug agent
(`-agentlib:jdwp`), so the whole adapter is a DAP↔JDWP protocol translator
(~1300 lines of Milo). Design and wire-format notes: [design.md](design.md).

Works with any DAP client. [Hades](../hades) has a built-in `java` dialect that
finds it automatically.

## Build

```bash
milo build examples/apps/java-dap/src/main.milo -o ~/bin/java-dap
```

## Use with hades

```bash
hades mcp --program Main.java --source Main.java --dapPath ~/bin/java-dap
# or with java-dap on PATH, the java dialect probes it:
hades web   # then a config with "type": "java"
```

Launch configuration (VS Code `launch.json` shape — see [launch.json](launch.json)):

| key | meaning | default |
|---|---|---|
| `program` | main `.java` source file | — |
| `mainClass` | fully-qualified main class | derived from `program` (package decl + stem) |
| `classPaths` | classpath entries (array) | dir of `program` |
| `sourceRoots` | roots for source lookup (array) | dir of `program` |
| `args` | program argv (array) | `[]` |
| `vmArgs` | extra JVM flags (array) | `[]` |
| `javaPath` | java executable | `$JAVA_HOME/bin/java`, then Homebrew openjdk, then PATH |
| `jdwpPort` | port for the spawned JVM's JDWP agent | 15737 |

Attach mode (`"request": "attach"`) connects to a JVM you started yourself:

```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=5005 -cp . Main
```

with `hostName` + `port` (direct DAP clients) or `jdwpPort` (hades configs —
hades reserves `port` for its own TCP-adapter transport).

Sources must be compiled with `javac -g` for locals to be visible.

## What works

- launch (spawns the JVM suspended) and attach
- line breakpoints, including **deferred** ones — set before the class loads,
  auto-verified on JDWP CLASS_PREPARE
- step over/in/out, pause, continue
- threads, stack traces with source mapping, scopes
- variables: primitives, strings, object fields, arrays (first 100)
- evaluate as dotted path (`foo.bar.baz`) over locals and `this` — no
  expression compilation, by design
- program stdout/stderr as DAP output events; exit/termination propagation

Not implemented: conditional breakpoints, exception breakpoints, hot code
replace, expression compilation, Maven/Gradle classpath resolution.

## Smoke / E2E

```bash
examples/apps/java-dap/scripts/smoke.sh          # wire-level: handshake, IDSizes, threads
bun examples/apps/java-dap/scripts/dap-e2e.ts <java-dap-bin>       # full DAP session
bun examples/apps/java-dap/scripts/hades-e2e.ts <hades-bin> <java-dap-bin>  # via hades MCP
```

All three skip/fail cleanly without a JDK (`brew install openjdk`).
