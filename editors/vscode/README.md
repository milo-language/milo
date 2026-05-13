# Milo VS Code Extension

Syntax highlighting + LSP client (`milod`) for Milo.

## Install (local dev)

Symlink into VS Code extensions:

```bash
ln -s "$(pwd)" ~/.vscode/extensions/milo.milo-lang-0.2.0
```

Folder name must match `<publisher>.<name>-<version>` exactly — VS Code ignores symlinks without the publisher prefix.

Then build once:

```bash
cd editors/vscode
bun install
bun run build
```

Restart VS Code. Open any `.milo` file — highlighting + diagnostics should activate.

## Develop

```bash
code editors/vscode    # F5 launches Extension Development Host
```

Or watch-compile while symlinked:

```bash
bun run watch
```

Reload window (`Cmd+R` in dev host, or `Developer: Reload Window` in command palette) after edits.

## Package

```bash
bunx @vscode/vsce package
code --install-extension milo-lang-0.2.0.vsix
```

## Troubleshooting

- **Nothing happens on `.milo` open**: check Output panel → "Milo Language Server" for errors. Verify `bun` is on PATH.
- **"could not locate compiler root"**: extension expects to live at `<milo>/editors/vscode`. Symlink target must point there.
- **Stale behavior after edits**: rerun `bun run build`, then reload window.
