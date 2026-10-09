// Compiler version, reported by `milo --version`.
//
// MILO_BUILD is rewritten by scripts/stamp-version.ts in the release workflow, just
// before `bun build --compile` freezes the source into a binary. In a checkout it
// stays "dev" and we fall back to asking git, so a locally-run compiler still
// identifies the commit it came from.

import { execSync } from "child_process";

export const MILO_VERSION = "0.3.0";
export const MILO_BUILD = "dev";

let cached: string | null = null;

export function versionString(): string {
  if (cached !== null) return cached;

  let build = MILO_BUILD;
  if (build === "dev") {
    try {
      const sha = execSync("git rev-parse --short HEAD", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: import.meta.dir,
        timeout: 2000,
      }).trim();
      build = sha ? `dev ${sha}` : "dev";
    } catch {
      // Not a git checkout, or no git installed. "dev" alone is still true.
    }
  }

  cached = `milo ${MILO_VERSION} (${build})`;
  return cached;
}
