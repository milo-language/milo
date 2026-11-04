// The host filesystem as `milo interp` may see it: read-only (src/interp-sys.ts HostFs has no write method).
// Node-only, so the browser playground never imports this file.
import { readFileSync, readdirSync, statSync } from "fs";
import type { HostFs } from "./interp-sys";

export const nodeHostFs: HostFs = {
  readFile(path) { try { return new Uint8Array(readFileSync(path)); } catch { return null; } },
  readdir(path) {
    try { return readdirSync(path, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() })); } catch { return null; }
  },
  stat(path) {
    try { const s = statSync(path); return { size: s.size, dir: s.isDirectory(), mtimeMs: s.mtimeMs }; } catch { return null; }
  },
};
