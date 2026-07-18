// Bundles the Milo compiler + stdlib for browser use.
// Output: playground/dist/compiler.js (single file, no dependencies)

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(import.meta.dir, "..");
const STD_DIR = join(ROOT, "std");
const DIST = join(import.meta.dir, "dist");

mkdirSync(DIST, { recursive: true });

// collect all .milo stdlib files into a JSON map
const stdlib: Record<string, string> = {};
for (const file of readdirSync(STD_DIR)) {
  if (file.endsWith(".milo")) {
    stdlib[`std/${file}`] = readFileSync(join(STD_DIR, file), "utf-8");
  }
}

// Write a shim that stubs Node APIs for browser
const shimCode = `
export function readFileSync() { throw new Error("fs not available in playground"); }
export function existsSync() { return false; }
export function writeFileSync() {}
export function mkdirSync() {}
export function readdirSync() { return []; }
`;
writeFileSync(join(DIST, "_fs-shim.js"), shimCode);

const pathShim = `
export function resolve(...args) { return args.join("/"); }
export function dirname(p) { return p.split("/").slice(0, -1).join("/") || "/"; }
export function join(...args) { return args.join("/"); }
`;
writeFileSync(join(DIST, "_path-shim.js"), pathShim);

const osShim = `export function homedir() { return "/home"; }`;
writeFileSync(join(DIST, "_os-shim.js"), osShim);

const processShim = `
const process = { cwd: () => "/playground", env: {} };
export default process;
`;
writeFileSync(join(DIST, "_process-shim.js"), processShim);

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "compiler.ts")],
  outdir: DIST,
  target: "browser",
  format: "esm",
  minify: false,
  define: {
    "STDLIB_FILES": JSON.stringify(stdlib),
    "process.cwd": "(() => '/playground')",
    "process.env": "({})",
  },
  external: [],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built playground/dist/compiler.js (${(result.outputs[0].size / 1024).toFixed(0)} KB)`);
