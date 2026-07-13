// Local dev server for the browser emulator demos. Serves the NES demo at /nes/
// and the Genesis demo at /genesis/, plus (localhost only) the repo's gitignored
// roms/ folder so each page can one-click your own ROMs. These local endpoints
// don't exist on the public GitHub Pages build, so copyrighted dumps stay local.
//   bun examples/apps/genesis/serve.ts   ->  http://localhost:8017
import { readdirSync, statSync, existsSync } from "fs";
import { join, extname } from "path";

const REPO = join(import.meta.dir, "..", "..", "..");
const NES_WEB = join(REPO, "examples", "apps", "nes", "web");
const GEN_WEB = join(REPO, "examples", "apps", "genesis", "web");
const ROMS = existsSync(join(REPO, "roms", "games")) ? join(REPO, "roms", "games") : join(REPO, "roms");
const PORT = Number(process.env.PORT) || 8017;

const ROM_EXTS = new Set([".nes", ".md", ".bin", ".gen", ".smd", ".sms"]);

// Recursively collect ROM files under `dir`, as paths relative to it. Each page
// filters this shared manifest to the extensions it can run.
function listRoms(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listRoms(full, r));
    else if (ROM_EXTS.has(extname(name).toLowerCase())) out.push(r);
  }
  return out.sort();
}

const LANDING = `<!doctype html><meta charset=utf-8><title>Milo emulators</title>
<style>body{background:#0d1117;color:#e6edf3;font:16px ui-monospace,Menlo,monospace;
display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;height:100vh;margin:0}
a{color:#58a6ff;font-size:20px;text-decoration:none;border:1px solid #30363d;padding:12px 24px;border-radius:8px}
a:hover{background:#21262d}</style>
<h1>Milo emulators — compiled to JavaScript</h1>
<a href="/nes/">🎮 NES</a><a href="/genesis/">🕹️ Genesis</a>`;

async function serveFrom(root: string, rel: string): Promise<Response> {
  if (rel === "" || rel === "/") rel = "/index.html";
  const file = Bun.file(join(root, rel));
  return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/local-roms.json") return Response.json(listRoms(ROMS));
    if (path.startsWith("/local/")) {
      const rel = path.slice("/local/".length);
      if (rel.includes("..")) return new Response("bad path", { status: 400 });
      const file = Bun.file(join(ROMS, rel));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    }
    if (path === "/") return new Response(LANDING, { headers: { "content-type": "text/html" } });
    if (path === "/nes" || path.startsWith("/nes/")) return serveFrom(NES_WEB, path.replace(/^\/nes/, ""));
    if (path === "/genesis" || path.startsWith("/genesis/")) return serveFrom(GEN_WEB, path.replace(/^\/genesis/, ""));
    return new Response("not found", { status: 404 });
  },
});

console.log(`Milo emulators: http://localhost:${PORT}   (NES /nes/, Genesis /genesis/, local ROMs from ${ROMS})`);
