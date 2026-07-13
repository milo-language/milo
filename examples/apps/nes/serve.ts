// Local dev server for the browser NES demo. Serves examples/apps/nes/web/ and,
// for localhost convenience only, exposes the repo's (gitignored) roms/ folder so
// the page can one-click your own ROMs. These local endpoints don't exist on the
// public GitHub Pages build, so copyrighted dumps never leave your machine.
//   bun examples/apps/nes/serve.ts   ->  http://localhost:8017
import { readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";

const WEB = join(import.meta.dir, "web");
const REPO = join(import.meta.dir, "..", "..", "..");
const ROMS = existsSync(join(REPO, "roms", "games")) ? join(REPO, "roms", "games") : join(REPO, "roms");
const PORT = Number(process.env.PORT) || 8017;

// Recursively collect .nes files under `dir`, returned as paths relative to it.
function listRoms(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listRoms(full, r));
    else if (extname(name).toLowerCase() === ".nes") out.push(r);
  }
  return out.sort();
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);

    // Manifest of local ROMs (empty array if none — the page just hides the section).
    if (path === "/local-roms.json") {
      return Response.json(listRoms(ROMS));
    }
    // Stream a local ROM by its manifest-relative path. Reject traversal.
    if (path.startsWith("/local/")) {
      const rel = path.slice("/local/".length);
      if (rel.includes("..")) return new Response("bad path", { status: 400 });
      const file = Bun.file(join(ROMS, rel));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }

    // Static files from web/.
    if (path === "/") path = "/index.html";
    const file = Bun.file(join(WEB, path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Milo NES: http://localhost:${PORT}   (local ROMs from ${ROMS})`);
