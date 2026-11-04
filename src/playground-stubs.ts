// Seams the playground bundle cuts: pkg.ts (git/tarball dependency fetching, child_process),
// bun:sqlite (the @sql attribute's schema check) and stdlibBundle.ts (std comes from the
// in-memory file map). A playground program has no milo.json and no database, so the first two
// are unreachable on the paths a snippet takes; reaching one is a plain error, not a silent
// success.
import { vfs } from "./playground-host";

export function depDirForSpec(_spec: string, _baseDir: string): string {
  throw new Error("package dependencies are not available in the playground");
}

export class Database {
  constructor(_path?: string) {
    throw new Error("@sql is not available in the playground");
  }
}

export const STDLIB_DIR = "/milo";
export const readStd = (absPath: string): string | null => vfs.get(absPath) ?? null;
export const bundledStdPaths = (): string[] => [...vfs.keys()].filter(p => p.startsWith("/milo/std/"));
