# Self-hosting compiler (WIP)

A Milo compiler written in Milo. Reads source from stdin, emits LLVM IR to stdout.

```bash
milo build self-hosting/main.milo -o milo0
echo 'fn main(): i32 { print("hello"); return 0 }' | ./milo0 > out.ll
clang out.ll -o out && ./out
```

Status: lexer and parser work, codegen covers a subset of the language. Not yet feature-complete.
