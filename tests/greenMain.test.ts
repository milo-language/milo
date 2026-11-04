// `main` runs as a green task whenever the program can spawn one.
//
// The bug this locks down had no diagnostic: a blocking std call in `main` read
// `schedulerCurrent()` as 0, took the OS-blocking path, and starved the green
// tasks that would have satisfied it. `accept` in `main` with the peer in a
// `Task.spawn` simply stopped forever.
//
// So case 1 is written to HANG if the fix regresses, and the timeout is the
// assertion — an "it ran" check that cannot tell a fixed program from a hung one
// would be worthless here. Case 3 is the other half: the wrapper must NOT appear
// in a program that never spawns, or every hello-world would drag in the
// ucontext scheduler and wasm/bare-metal (which have no stackful coroutines)
// would stop building.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-greenmain-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function build(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  const out = join(dir, name);
  writeFileSync(file, src);
  execFileSync("bun", ["run", MAIN, "build", file, "-o", out],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

function emitIr(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  writeFileSync(file, src);
  return execFileSync("bun", ["run", MAIN, "emit-ir", file],
    { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

// The repro from docs/backlog.md, verbatim in shape: a server that spawns its
// worker and then accepts — the natural way to write one.
const ACCEPT_IN_MAIN = `from "std/net" import { TcpListener, TcpStream, ip4 }
from "std/runtime" import { Task }
from "std/io" import { print }

fn main() {
    let ln = TcpListener.bind(0)!
    let port = ln.port() as u16
    let t = Task.spawn(move(): void => {
        let c = TcpStream.connect(ip4(127, 0, 0, 1), port)!
        let _ = c.send("hi")
    })
    let _conn = ln.accept()!
    print("accepted")
    t.join()
}
`;

test("a blocking accept in main does not starve the task that satisfies it", () => {
  const bin = build("acceptInMain", ACCEPT_IN_MAIN);
  // Before the fix this never returns; execFileSync's timeout is what fails the
  // test, so keep it well above a cold start but far below any CI job budget.
  const out = execFileSync(bin, [], { encoding: "utf-8", timeout: 20_000 });
  expect(out.trim()).toBe("accepted");
}, 60_000);

test("main's exit code survives the trip through the scheduler", () => {
  const bin = build("greenExit", `from "std/runtime" import { Task }

fn main(): i32 {
    let t = Task.spawn(move(): void => {})
    t.join()
    return 7
}
`);
  let code = 0;
  try { execFileSync(bin, [], { timeout: 20_000 }); }
  catch (e: any) { code = e.status; }
  expect(code).toBe(7);
}, 60_000);

test("a program that cannot spawn keeps the plain entry point", () => {
  const ir = emitIr("noSpawn", `fn main() {
    print("hello")
}
`);
  expect(ir).not.toContain("__milo_main_body");
  expect(ir).toContain("define i32 @main(");
}, 60_000);
