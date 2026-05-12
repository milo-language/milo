import * as path from "path";
import { workspace, ExtensionContext, window } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const miloRoot = findMiloRoot(context.extensionPath);
  if (!miloRoot) {
    window.showWarningMessage("Milo: could not locate compiler root. LSP disabled.");
    return;
  }

  const mainTs = path.join(miloRoot, "src", "main.ts");

  const serverOptions: ServerOptions = {
    command: "bun",
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
