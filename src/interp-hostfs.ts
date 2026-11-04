// The host filesystem as `milo interp` may see it: read-only (src/interp-sys.ts HostFs has no write method).
// Node-only, so the browser playground never imports this file.
import { readFileSync, readdirSync, statSync } from "fs";
import type { HostFs } from "./interp-sys";

export const nodeHostFs: HostFs = {
  // R-SYS-FS: the host side of the filesystem, read-only
  readFile(path) { try { return new Uint8Array(readFileSync(path)); } catch { return null; } },
  // R-SYS-FS
  readdir(path) {
    try { return readdirSync(path, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() })); } catch { return null; }
  },
  // R-SYS-FS
  stat(path) {
    try { const s = statSync(path); return { size: s.size, dir: s.isDirectory(), mtimeMs: s.mtimeMs }; } catch { return null; }
  },
};
