import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { workspace, ExtensionContext, window } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const miloRoot = findMiloRoot(context.extensionPath);
  if (!miloRoot) {
    window.showWarningMessage("Milo: could not locate compiler root. LSP disabled.");
    return;
  }

  const bunPath = findBun();
  if (!bunPath) {
    window.showErrorMessage("Milo: could not find `bun` executable. Install Bun or add it to PATH.");
    return;
  }

  const mainTs = path.join(miloRoot, "src", "main.ts");

  const serverOptions: ServerOptions = {
    command: bunPath,
    args: ["run", mainTs, "lsp"],
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "milo" }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.milo"),
    },
  };

  client = new LanguageClient("milod", "Milo Language Server", serverOptions, clientOptions);
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

// VS Code launched from Dock inherits a minimal PATH that often lacks ~/.bun/bin,
// /opt/homebrew/bin, etc. Probe known install locations before falling back to PATH.
function findBun(): string | null {
  const candidates = [
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return "bun"; // last resort: rely on PATH
}

function findMiloRoot(extensionPath: string): string | null {
  // Extension lives at <milo>/editors/vscode
  const candidate = path.resolve(extensionPath, "..", "..");
  try {
    const pkg = require(path.join(candidate, "package.json"));
    if (pkg.name === "milo") return candidate;
  } catch {}

  // Also check workspace folders
  for (const folder of workspace.workspaceFolders ?? []) {
    try {
      const pkg = require(path.join(folder.uri.fsPath, "package.json"));
      if (pkg.name === "milo") return folder.uri.fsPath;
    } catch {}
  }

  return null;
}
