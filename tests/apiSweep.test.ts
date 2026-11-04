// scripts/api-sweep.ts: route scan, masking, and end to end on a tiny HTTP program
// (same source twice is identical; a planted response change is reported by route).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { firstDiff, mask, plan, scanRoutes } from "../scripts/api-sweep";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "api-sweep.ts");
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "api-sweep-test-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const app = (aBody: string) => `from "std/http" import { Context, Response, Router, serveRouterOn }
from "std/env" import { Env }

fn a(ctx: &mut Context): Response {
    return Response.Status(200, "text/plain", "${aBody}")
}

fn b(ctx: &mut Context): Response {
    return Response.Status(200, "text/plain", "stable b at 12:00:01")
}

fn named(ctx: &mut Context): Response {
    return Response.Status(200, "text/plain", "named")
}

fn main(): i32 {
    let port = ((Env.get("PORT") ?? "3920").parseInt() ?? 3920) as u16
    var r: Router = Router.new()
    r.get("/a", a)
    r.get("/b", b)
    r.get("/n/:id", named)
    if let Result.Err(msg) = serveRouterOn("127.0.0.1", port, r) {
        eprint(msg)
        return 1
    }
    return 0
}
`;

test("scanRoutes finds get, stream and addRoute GET; plan skips params without a sample", () => {
  const src = `r.get("/a", h)\nr.stream("/s/:x/stream", h)\nr.addRoute("GET", "/p", h)\nr.post("/no", h)\nr.addRoute("PATCH", "/no2", h)`;
  const routes = scanRoutes(src);
  expect(routes).toEqual(["/a", "/p", "/s/:x/stream"]);
  expect(plan(routes, [])).toEqual({ requests: ["/a", "/p"], skipped: ["/s/:x/stream"] });
  expect(plan(routes, ["/s/9/stream?z=1"]).requests).toContain("/s/9/stream?z=1");
});

test("mask hides ignored matches and firstDiff names the byte", () => {
  const re = [/\d\d:\d\d:\d\d/g];
  expect(firstDiff(mask(Buffer.from("t 12:00:01"), re), mask(Buffer.from("t 09:59:59"), re))).toBeNull();
  expect(firstDiff("hello", "help!")).toContain("at byte 3");
});

function sweep(oldSrc: string, newSrc: string) {
  const o = join(dir, "old.milo"), n = join(dir, "new.milo");
  writeFileSync(o, oldSrc);
  writeFileSync(n, newSrc);
  return spawnSync("bun", ["run", SCRIPT, "--app", o, "--new-app", n, "--old-compiler", ROOT, "--new-compiler", ROOT, "--ignore", "\\d\\d:\\d\\d:\\d\\d"], { cwd: ROOT, encoding: "utf-8", timeout: 240000 });
}

test("same program twice: every route identical, exit 0", () => {
  const r = sweep(app("alpha"), app("alpha"));
  expect(r.stdout).toContain("routes compared: 2, identical: 2, differing: 0, skipped: 1");
  expect(r.status).toBe(0);
}, 280000);

test("planted response change: that route is reported, exit 1", () => {
  const r = sweep(app("alpha"), app("alpHa"));
  expect(r.stdout).toContain("differing: 1");
  expect(r.stdout).toContain("/a: at byte 3");
  expect(r.stdout).not.toContain("/b:");
  expect(r.status).toBe(1);
}, 280000);
