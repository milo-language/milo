// Record/replay phases 2 and 3 (std/replay, docs/record-replay.md): file, socket,
// subprocess IO and green-scheduler decisions recorded under MILO_RECORD and answered
// from the trace under MILO_REPLAY; divergence with context, unconsumed records at
// exit, MILO_REPLAY_STOP, and `milo trace`.
//
// The replays here run against a world that has changed since the recording: the
// file rewritten or deleted, the outside server stopped, the child's environment
// different. Identical stdout then means the answers came from the trace, and the
// recorded values asserted alongside (the server's random token, the child's output)
// make sure it is not two runs that happened to agree.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-replay-io-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// Every test here compiles one or two programs; a slow macOS release runner took over
// bun's 5 s default for that alone, so each test carries its own timeout.
function build(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  const out = join(dir, name);
  writeFileSync(file, src);
  execFileSync("bun", ["run", MAIN, "build", file, "-o", out], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

function env(extra: Record<string, string>): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MILO_")) e[k] = v;
  return { ...e, ...extra };
}

// Async: the outside server below lives in this process, so the child must not be
// waited on with a blocking spawnSync.
async function runAsync(bin: string, args: string[], extra: Record<string, string>) {
  const p = Bun.spawn([bin, ...args], { cwd: dir, env: env(extra), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited, signal: p.signalCode };
}

function run(bin: string, args: string[], extra: Record<string, string>) {
  const r = spawnSync(bin, args, { cwd: dir, env: env(extra), encoding: "utf-8", timeout: 60000 });
  return { out: r.stdout, err: r.stderr, code: r.status, signal: r.signal };
}

// A file read, an HTTP request to a server the program runs on a green task, an HTTP
// request to an outside server, a subprocess, and three green tasks interleaving
// through a channel on sleeps.
const SCENARIO = `from "std/fs" import { readFile }
from "std/net" import { TcpListener, ip4 }
from "std/fetch" import { fetch }
from "std/process" import { Command }
from "std/runtime" import { Task }
from "std/sync" import { Channel }
from "std/time" import { sleepMs }
from "std/args" import { args }

// A named fn so the connection is dropped (closed) when it returns and the client's
// read-to-EOF ends.
fn serveOne(listener: &TcpListener): void {
    let conn = listener.accept()!
    let req = conn.recvOnce()
    let body = "own server saw " + req.len.toString() + " request bytes"
    conn.send("HTTP/1.0 200 OK\\r\\nContent-Length: " + body.len.toString() + "\\r\\n\\r\\n" + body)!
}

fn main() {
    let argv = args()
    let data = readFile(argv[1])!
    print("file: " + data.trim())

    let listener = TcpListener.bindAddr(ip4(127, 0, 0, 1), 0)!
    let port = listener.port()
    let server = Task.spawn(move(): void => {
        serveOne(listener)
    })
    let own = fetch("http://127.0.0.1:" + port.toString() + "/own")!
    print("own: " + own.status.toString() + " " + own.text())
    server.join()

    let ext = fetch(argv[2])!
    print("ext: " + ext.status.toString() + " " + ext.text())

    var child = Command.new("sh").arg("-c").arg("echo sub $RR_SUB").spawn()!
    var out = ""
    for chunk in child.stdout() {
        out.pushStr(chunk)
    }
    print("child: " + out.trim() + " exit " + child.wait()!.toString())

    let ch = Channel<string>.new(64)!
    var tasks: Vec<Task> = []
    for id in 0..3 {
        let c = ch.clone()
        tasks.push(Task.spawn(move(): void => {
            for k in 0..3 {
                sleepMs(3 + id)
                c.send("t" + id.toString() + "." + k.toString())!
            }
        }))
    }
    var order = ""
    for _ in 0..9 {
        order.pushStr(ch.recv()!)
        order.push(' ')
    }
    for t in tasks {
        t.join()
    }
    print("order: " + order.trim())
}
`;

let scenario = "";
let scenarioOut = "";
const scenarioTrace = () => join(dir, "scenario.mrr");

test("file, http, subprocess and three green tasks: replay prints the recording against a changed world", async () => {
  scenario = build("scenario", SCENARIO);
  const dataFile = join(dir, "scenario.data");
  writeFileSync(dataFile, "file v1\n");
  const token = Math.random().toString(36).slice(2, 10);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ext " + token) });
  const url = `http://127.0.0.1:${server.port}/x`;
  let rec;
  try {
    rec = await runAsync(scenario, [dataFile, url], { MILO_RECORD: scenarioTrace(), RR_SUB: "recorded" });
  } finally {
    server.stop(true);
  }
  expect(rec.err).toBe("");
  expect(rec.code).toBe(0);
  expect(rec.out).toContain("file: file v1\n");
  expect(rec.out).toContain("own: 200 own server saw ");
  expect(rec.out).toContain(`ext: 200 ext ${token}\n`);
  expect(rec.out).toContain("child: sub recorded exit 0\n");
  expect(rec.out).toMatch(/order: (t\d\.\d ?){9}\n/);
  scenarioOut = rec.out;

  // The file rewritten, the outside server gone, the child's environment different.
  writeFileSync(dataFile, "file v2, rewritten\n");
  const rep = await runAsync(scenario, [dataFile, url], { MILO_REPLAY: scenarioTrace(), RR_SUB: "live" });
  expect(rep.err).toBe("");
  expect(rep.code).toBe(0);
  expect(rep.out).toBe(scenarioOut);

  // The file deleted.
  rmSync(dataFile);
  const gone = await runAsync(scenario, [dataFile, url], { MILO_REPLAY: scenarioTrace() });
  expect(gone.code).toBe(0);
  expect(gone.out).toBe(scenarioOut);

  // And live, against the same changed world, the program sees it: no file.
  const live = await runAsync(scenario, [dataFile, url], {});
  expect(live.code).not.toBe(0);
  expect(live.out).not.toContain("file: file v1");
}, 120000);

test("milo trace lists the scenario's records by kind", () => {
  const r = spawnSync("bun", ["run", MAIN, "trace", scenarioTrace(), "--json"], { encoding: "utf-8" });
  expect(r.status).toBe(0);
  const t = JSON.parse(r.stdout);
  expect(t.version).toBe(1);
  expect(t.total).toBe(t.records.length);
  // Everything the scenario touches goes through std, so the recording has no gaps.
  expect(t.holes).toEqual([]);
  const kinds = new Set(t.records.map((x: any) => x.kind));
  for (const k of ["args", "fs.open", "fs.read", "net.socket", "net.accept", "net.connect", "net.read", "net.write", "net.resolve", "proc.spawn", "proc.read", "proc.wait", "sched.pick"]) {
    expect(kinds).toContain(k);
  }
  const open = t.records.find((x: any) => x.kind === "fs.open");
  expect(open.arg).toBe(`0 ${join(dir, "scenario.data")}`);
  const seqs = t.records.map((x: any) => x.seq);
  expect(seqs).toEqual(seqs.map((_: any, i: number) => i + 1));

  const procOnly = spawnSync("bun", ["run", MAIN, "trace", scenarioTrace(), "--kind", "proc."], { encoding: "utf-8" });
  expect(procOnly.stdout.split("\n").filter(l => l.trim()).every(l => / proc\./.test(l))).toBe(true);

  const read = t.records.find((x: any) => x.kind === "fs.read");
  const payload = spawnSync("bun", ["run", MAIN, "trace", scenarioTrace(), "--payload", String(read.seq)], { encoding: "utf-8" });
  expect(payload.stdout).toBe("=file v1\n");
}, 60000);

// Sleeps under replay take no time: the recorded schedule says when each timer fired.
test("replaying a program that sleeps is faster than recording it", () => {
  const bin = build("sleeper", `from "std/time" import { sleepMs }
from "std/runtime" import { Task }

fn main() {
    let t = Task.spawn(move(): void => {
        for _ in 0..4 {
            sleepMs(100)
        }
        print("task done")
    })
    sleepMs(150)
    print("main slept")
    t.join()
}
`);
  const trace = join(dir, "sleeper.mrr");
  const t0 = performance.now();
  const rec = run(bin, [], { MILO_RECORD: trace });
  const recordMs = performance.now() - t0;
  const t1 = performance.now();
  const rep = run(bin, [], { MILO_REPLAY: trace });
  const replayMs = performance.now() - t1;
  expect(rec.code).toBe(0);
  expect(rep.code).toBe(0);
  expect(rep.out).toBe(rec.out);
  expect(rec.out).toBe("main slept\ntask done\n");
  expect(recordMs).toBeGreaterThan(400);
  expect(replayMs).toBeLessThan(recordMs / 2);
}, 60000);

const READER = (path: string, n: number) => `from "std/fs" import { readFile }

fn main() {
    for _ in 0..${n} {
        print(readFile("${path}")!.trim())
    }
}
`;

test("a program changed to read a different file diverges at that read, with context", () => {
  writeFileSync(join(dir, "a.txt"), "aaa\n");
  writeFileSync(join(dir, "b.txt"), "bbb\n");
  const trace = join(dir, "reader.mrr");
  expect(run(build("readA", READER("a.txt", 1)), [], { MILO_RECORD: trace }).code).toBe(0);
  const r = run(build("readB", READER("b.txt", 1)), [], { MILO_REPLAY: trace });
  expect(r.code).toBe(3);
  const lines = r.err.split("\n");
  expect(lines[0]).toBe("replay diverged at record 1: expected fs.open(0 a.txt), got fs.open(0 b.txt)");
  expect(r.out).toBe("");
}, 60000);

test("a replay that ends with records left over is a divergence naming the first", () => {
  writeFileSync(join(dir, "a.txt"), "aaa\n");
  const trace = join(dir, "twice.mrr");
  expect(run(build("readTwice", READER("a.txt", 2)), [], { MILO_RECORD: trace }).code).toBe(0);
  const r = run(build("readOnce", READER("a.txt", 1)), [], { MILO_REPLAY: trace });
  expect(r.code).toBe(3);
  // The output it did produce still reached stdout before the report.
  expect(r.out).toBe("aaa\n");
  const lines = r.err.split("\n");
  expect(lines[0]).toMatch(/^replay diverged at record \d+: expected fs\.open\(0 a\.txt\), got end of program \(\d+ records not replayed\)$/);
  expect(lines[1]).toBe("last records replayed:");
  expect(lines.slice(2).join("\n")).toContain("fs.read(");
}, 60000);

test("MILO_REPLAY_STOP stops at the requested record", () => {
  writeFileSync(join(dir, "a.txt"), "aaa\n");
  const trace = join(dir, "stop.mrr");
  const bin = build("readStop", READER("a.txt", 2));
  expect(run(bin, [], { MILO_RECORD: trace }).code).toBe(0);
  const list = JSON.parse(spawnSync("bun", ["run", MAIN, "trace", trace, "--json"], { encoding: "utf-8" }).stdout);
  const second = list.records.filter((x: any) => x.kind === "fs.open")[1];

  // Print mode: the stop is reported and the replay runs on.
  const printed = run(bin, [], { MILO_REPLAY: trace, MILO_REPLAY_STOP: String(second.seq), MILO_REPLAY_STOP_PRINT: "1" });
  expect(printed.code).toBe(0);
  expect(printed.out).toBe("aaa\naaa\n");
  expect(printed.err).toBe(`replay: stop at record ${second.seq}: fs.open(0 a.txt)\n`);

  // Trap mode with no debugger attached: SIGTRAP ends the process at that record,
  // after the first read's output and before the second's.
  const trapped = run(bin, [], { MILO_REPLAY: trace, MILO_REPLAY_STOP: String(second.seq), MILO_LINE_BUFFERED: "1" });
  expect(trapped.signal).toBe("SIGTRAP");
  expect(trapped.out).toBe("aaa\n");
}, 60000);

const lldb = spawnSync("lldb", ["--version"], { encoding: "utf-8" }).status === 0;

test.skipIf(!lldb)("under lldb, a breakpoint on miloReplayStop stops at the record", () => {
  writeFileSync(join(dir, "a.txt"), "aaa\n");
  const trace = join(dir, "lldb.mrr");
  const bin = build("readLldb", READER("a.txt", 2));
  expect(run(bin, [], { MILO_RECORD: trace }).code).toBe(0);
  const r = spawnSync("lldb", ["--batch", "-o", "breakpoint set -n miloReplayStop", "-o", "run", "-o", "bt 3", "-o", "kill", "--", bin],
    { cwd: dir, env: env({ MILO_REPLAY: trace, MILO_REPLAY_STOP: "3" }), encoding: "utf-8", timeout: 60000 });
  expect(r.stdout).toContain("stop reason = breakpoint 1.1");
  expect(r.stdout).toMatch(/frame #0: .*miloReplayStop/);
  expect(r.stdout).toMatch(/frame #1: .*noteConsumed/);
});

test("with neither variable set the IO hooks are inert: live reads, no trace", () => {
  writeFileSync(join(dir, "a.txt"), "live one\n");
  const bin = build("readLive", READER("a.txt", 1));
  const r = run(bin, [], {});
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  expect(r.out).toBe("live one\n");
  expect(existsSync(join(dir, "a.txt.mrr"))).toBe(false);
}, 60000);

// A replay never changes the world: a write to a file is recorded (that it happened,
// how many bytes) and answered from the trace, and the file is not created.
test("file writes are recorded by size and not performed under replay", () => {
  const out = join(dir, "written.txt");
  const bin = build("writer", `from "std/fs" import { writeFile }

fn main() {
    print(writeFile("${out}", "twelve bytes")!.toString())
}
`);
  const trace = join(dir, "writer.mrr");
  expect(run(bin, [], { MILO_RECORD: trace }).out).toBe("12\n");
  expect(readFileSync(out, "utf-8")).toBe("twelve bytes");
  rmSync(out);
  const rep = run(bin, [], { MILO_REPLAY: trace });
  expect(rep.code).toBe(0);
  expect(rep.out).toBe("12\n");
  expect(existsSync(out)).toBe(false);
  const kinds = spawnSync("bun", ["run", MAIN, "trace", trace], { encoding: "utf-8" }).stdout;
  expect(kinds).toMatch(/fs\.write +\d+ 12 +2 bytes/);
}, 60000);
