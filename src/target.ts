// host platform detection for platform-specific stdlib resolution
import { arch, platform } from "os";

export interface TargetInfo {
  triple: string;
  os: "darwin" | "linux";
  arch: "aarch64" | "x86_64";
}

const targets: Record<string, TargetInfo> = {
  "macos-arm64": { triple: "aarch64-apple-darwin", os: "darwin", arch: "aarch64" },
  "macos-x64":   { triple: "x86_64-apple-darwin", os: "darwin", arch: "x86_64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", os: "linux", arch: "aarch64" },
  "linux-x64":   { triple: "x86_64-unknown-linux-gnu", os: "linux", arch: "x86_64" },
};

export function getHostTarget(): TargetInfo {
  const a = arch();
  const p = platform();
  if (p === "darwin") {
    return targets[a === "arm64" ? "macos-arm64" : "macos-x64"];
  }
  return targets[a === "arm64" || a === "aarch64" ? "linux-arm64" : "linux-x64"];
}
