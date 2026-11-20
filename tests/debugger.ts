// Whether this host can attach a debugger-class tool (lldb, `leaks`) to a child process.
// On macOS with Developer Mode off, attaching waits on an authorization prompt nobody answers,
// so the tool hangs until the test times out and the failure reads like a code bug. CI runners
// can attach; there this is always true, so nothing that should run is ever skipped on CI.
import { spawnSync } from "child_process";

export function canAttach(): boolean {
  if (process.env.CI || process.platform !== "darwin") return true;
  const r = spawnSync("DevToolsSecurity", ["-status"], { encoding: "utf-8" });
  return !/disabled/.test(r.stdout ?? "");
}
