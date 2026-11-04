// Builds docs/site/public/playground/milo-playground.js: the frontend plus the reference
// interpreter for the browser, with std/*.milo embedded. The docs build runs this first
// (docs/site package.json "stage"). The output is generated and gitignored; tests import it.
import { readdirSync, readFileSync, mkdirSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = resolve(root, "docs/site/public/playground/milo-playground.js");

export async function buildPlayground(): Promise<number> {
  const std: Record<string, string> = {};
  for (const f of readdirSync(resolve(root, "std")).sort()) {
    if (f.endsWith(".milo")) std[`/milo/std/${f}`] = readFileSync(resolve(root, "std", f), "utf-8");
  }
  const alias: Record<string, string> = {
    fs: resolve(root, "src/playground-fs.ts"),
    os: resolve(root, "src/playground-os.ts"),
  };
  const r = await Bun.build({
    entrypoints: [resolve(root, "src/playground-entry.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    define: { process: "__miloHost" },
    plugins: [{
      name: "playground-host",
      setup(b) {
        b.onResolve({ filter: /^(fs|os)$/ }, a => ({ path: alias[a.path]! }));
        b.onResolve({ filter: /^(\.\/pkg|\.\/stdlibBundle|bun:sqlite)$/ }, () => ({ path: resolve(root, "src/playground-stubs.ts") }));
        b.onResolve({ filter: /^playground-std$/ }, () => ({ path: "playground-std", namespace: "virtual" }));
        b.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: `export default ${JSON.stringify(std)};`, loader: "js" }));
      },
    }],
  });
  if (!r.success) { for (const l of r.logs) console.error(String(l)); throw new Error("playground build failed"); }
  mkdirSync(dirname(OUT), { recursive: true });
  await Bun.write(OUT, r.outputs[0]!);
  return statSync(OUT).size;
}

if (import.meta.main) console.log(`playground bundle: ${((await buildPlayground()) / 1024).toFixed(0)} KiB -> ${OUT}`);
