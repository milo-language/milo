# IDE Setup

Milo includes an LSP server with diagnostics, hover, and go-to-definition.

## VS Code

Build and install the extension:

```bash
cd editors/vscode && bun install && bun run build
ln -s "$(pwd)" ~/.vscode/extensions/milo.milo-lang-0.2.0
```

Restart VS Code and open any `.milo` file.

## What you get

- **Diagnostics** — type errors, move violations, and syntax errors as you type
- **Hover** — type information on any expression
- **Go-to-definition** — jump to function/struct/enum definitions
- **Syntax highlighting** — via the bundled TextMate grammar

## Other editors

The LSP server runs via:

```bash
bun run src/main.ts lsp
```

Point any LSP client at this command to get diagnostics, hover, and go-to-definition.
