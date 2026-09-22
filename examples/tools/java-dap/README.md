# java-dap

A Debug Adapter Protocol server for the JVM, ~1300 lines of Milo. The JVM has a
debugger built in: started with `-agentlib:jdwp`, it answers JDWP, a wire protocol
for breakpoints, stepping and reading frames. java-dap launches the JVM that way and
translates between JDWP and DAP, the protocol editors and dapweb speak. Notes in
[design.md](design.md).

```bash
milo build examples/tools/java-dap/src/main.milo -o ~/bin/java-dap
```

Launch and attach, deferred breakpoints, stepping, stack traces, variables,
dotted-path evaluate, exception breakpoints. No conditional breakpoints, hot
reload, or Maven/Gradle classpaths. Compile with `javac -g`.
