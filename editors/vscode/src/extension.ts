import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { workspace, ExtensionContext, window, commands } from "vscode";
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

  context.subscriptions.push(
    commands.registerCommand("milo.runFile", (filePath: string) => {
      const terminal = window.createTerminal("Milo Run");
      terminal.show();
      terminal.sendText(`${bunPath} run ${mainTs} run ${filePath}`);
    }),
    commands.registerCommand("milo.runTest", (filePath: string) => {
      const name = path.basename(filePath, ".milo");
      const terminal = window.createTerminal("Milo Test");
      terminal.show();
      terminal.sendText(`${bunPath} test ${path.join(miloRoot, "tests", "run.test.ts")} -t "${name}"`);
    }),
  );
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

function isMiloRoot(dir: string): boolean {
  try {
    const pkg = require(path.join(dir, "package.json"));
    return pkg.name === "milo" && fs.statSync(path.join(dir, "src", "main.ts")).isFile();
  } catch { return false; }
}

function findMiloRoot(extensionPath: string): string | null {
  // Explicit override wins — needed when editing .milo files outside the milo repo.
  const configured = workspace.getConfiguration("milo").get<string>("compilerRoot")?.trim();
  if (configured) {
    if (isMiloRoot(configured)) return configured;
    window.showWarningMessage(`Milo: milo.compilerRoot="${configured}" is not a Milo repo (no src/main.ts or wrong package name).`);
    return null;
  }

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
