// Browser host for the playground bundle: the one place that stands in for the node APIs the
// frontend reads (process, fs). scripts/build-playground.ts rewrites every bare `process` in the
// bundle to `__miloHost` (a build-time define) and aliases `fs` and `os` to playground-fs/os, so
// no compiler file needs a browser branch and the real `process` (a test runner's, say) is never
// touched. It must be the entry's FIRST import: resolver.ts and checker.ts read
// `process.env.MILO_ROOT` while they load.
export const PLAY_ROOT = "/milo";
export const PLAY_DIR = "/play";
export const PLAY_FILE = "/play/main.milo";

(globalThis as any).__miloHost = {
  env: { MILO_ROOT: PLAY_ROOT },
  platform: "linux",
  arch: "x64",
  cwd: () => PLAY_DIR,
  stderr: { write: (_s: string) => true },
};

// path -> text. The entry fills it with std/*.milo under /milo/std; run() adds the program.
export const vfs = new Map<string, string>();
