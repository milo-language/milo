// Record/replay phase 4 (docs/record-replay.md): extern calls the compiler records from
// the catalog or an `@records` attribute, holes reported at compile time and once per
// recorded run, and OS threads replayed in their recorded interleaving.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-replay4-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function write(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  writeFileSync(file, src);
  return file;
}

function build(name: string, src: string): string {
  const out = join(dir, name);
  execFileSync("bun", ["run", MAIN, "build", write(name, src), "-o", out], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.MILO_RECORD;
  delete e.MILO_REPLAY;
  return { ...e, ...extra };
}

function run(bin: string, extra: Record<string, string> = {}) {
  const r = spawnSync(bin, [], { cwd: dir, env: env(extra), encoding: "utf-8", timeout: 60000 });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

// A program's own externs: a scalar one with no description (getpid, clock: recorded by
// return value), one the std catalog describes (gethostname writes a C string into its
// buffer), one described by `@records` (confstr), and one nothing describes (uname: a
// hole). Every value that differs between runs is printed.
const USER_EXTERNS = `from "std/env" import { Env }

extern fn getpid(): i32
extern fn gethostname(name: *u8, len: i64): i32
extern fn clock(): u64
@records("buf[cstr:len]")
extern fn confstr(name: i32, buf: *u8, len: i64): i64
extern fn uname(buf: *u8): i32

fn main() {
    var host: [u8; 256] = [0; 256]
    var conf: [u8; 256] = [0; 256]
    var un: [u8; 2048] = [0; 2048]
    unsafe {
        let pid = getpid()
        let r = gethostname(host as *u8, 256)
        let c = clock()
        let n = confstr(1, conf as *u8, 256)
        uname(un as *u8)
        uname(un as *u8)
        print("pid " + pid.toString() + " clock " + c.toString())
        print("host " + _cstrToString(host as *u8) + " " + r.toString())
        print("conf " + _cstrToString(conf as *u8) + " " + n.toString())
    }
    print("env " + Env.getOr("UX", "-"))
}
`;

test("a program's own extern calls record and replay, answered from the trace", () => {
  const bin = build("ux", USER_EXTERNS);
  const trace = join(dir, "ux.mrr");
  const rec = run(bin, { MILO_RECORD: trace, UX: "recorded" });
  expect(rec.code).toBe(0);
  const live = run(bin, { UX: "live" });
  // getpid differs in every process, so a replay printing the recorded pid is the trace
  // answering, not a coincidence.
  expect(live.out.split("\n")[0]).not.toBe(rec.out.split("\n")[0]);
  const rep = run(bin, { MILO_REPLAY: trace, UX: "live" });
  expect(rep.err).toBe("");
  expect(rep.code).toBe(0);
  expect(rep.out).toBe(rec.out);

  // The bytes the calls wrote come from the trace too: change the recorded hostname
  // and the confstr result (same lengths, so the framing still holds) and the replay
  // prints the changed ones.
  const host = rec.out.match(/^host (\S+) /m)![1];
  const conf = rec.out.match(/^conf (\S+) /m)![1];
  let t = readFileSync(trace, "latin1");
  t = t.replace(host, "h".repeat(host.length)).replace(conf, "c".repeat(conf.length));
  writeFileSync(join(dir, "ux-edited.mrr"), t, "latin1");
  const edited = run(bin, { MILO_REPLAY: join(dir, "ux-edited.mrr") });
  expect(edited.code).toBe(0);
  expect(edited.out).toContain(`host ${"h".repeat(host.length)} 0\n`);
  expect(edited.out).toContain(`conf ${"c".repeat(conf.length)} `);
}, 60000);

test("an extern nothing describes is listed at compile time and reported once by a recorded run", () => {
  const file = write("uxcheck", USER_EXTERNS);
  const quiet = spawnSync("bun", ["run", MAIN, "check", file], { cwd: ROOT, encoding: "utf-8" });
  expect(quiet.status).toBe(0);
  expect(quiet.stderr).not.toContain("replay-hole");
  const listed = spawnSync("bun", ["run", MAIN, "check", "--replay-holes", file], { cwd: ROOT, encoding: "utf-8" });
  expect(listed.status).toBe(0);
  expect(listed.stderr).toContain("warning[replay-hole]");
  expect(listed.stderr).toContain("'uname' is not recorded under MILO_RECORD");
  // Only uname: the scalar, catalogued and @records externs are recorded.
  expect(listed.stderr.match(/replay-hole/g)!.length).toBe(2);
  const denied = spawnSync("bun", ["run", MAIN, "check", "--deny=replay-hole", file], { cwd: ROOT, encoding: "utf-8" });
  expect(denied.status).not.toBe(0);

  const bin = join(dir, "ux");
  const trace = join(dir, "ux-hole.mrr");
  const built = join(dir, "ux.milo");
  const rec = run(bin, { MILO_RECORD: trace });
  // Two calls to uname, one report.
  expect(rec.err).toBe("replay: this run called unrecorded uname at " + built + ":19; a replay may diverge\n");
  const listing = spawnSync("bun", ["run", MAIN, "trace", trace], { encoding: "utf-8" });
  expect(listing.stdout).toContain(`hole: this run called unrecorded uname at ${built}:19`);
  const json = JSON.parse(spawnSync("bun", ["run", MAIN, "trace", trace, "--json"], { encoding: "utf-8" }).stdout);
  expect(json.holes.map((h: any) => h.name)).toEqual(["uname"]);
  // An unrecorded run says nothing.
  expect(run(bin).err).toBe("");
}, 60000);

// Four OS threads (Promise.blocking workers) take a lock in turn: a one-slot channel
// holding a counter. Each prints who got it, so stdout is the acquisition order, which
// is different on nearly every live run and must be identical on every replay.
const THREADS = `from "std/runtime" import { Promise }
from "std/sync" import { Channel, AtomicI64 }

fn main() {
    let lock = Channel<i64>.new(1)!
    lock.send(0)!
    let hits = AtomicI64.new(0)
    var ps: Vec<Promise<i64>> = Vec.new()
    for w in 0..4 {
        let l = lock.clone()
        let h = hits.clone()
        ps.push(Promise<i64>.blocking(move (): i64 => {
            var mine: i64 = 0
            for i in 0..25 {
                let c = l.recv()!
                let seen = h.add(1)
                print("w" + w.toString() + " lock " + c.toString() + " atomic " + seen.toString())
                l.send(c + 1)!
                mine += 1
            }
            return mine
        }))
    }
    var total: i64 = 0
    for p in ps {
        total += p.await()!
    }
    print("total " + total.toString() + " hits " + hits.load().toString() + " final " + lock.recv()!.toString())
}
`;

test("several OS threads contending on a lock replay byte-identically, 20 times", () => {
  const bin = build("threads", THREADS);
  const lives = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const r = run(bin);
    expect(r.code).toBe(0);
    lives.add(r.out);
  }
  // The interleaving is the OS scheduler's: unrecorded runs disagree with each other.
  expect(lives.size).toBeGreaterThan(1);
  const trace = join(dir, "threads.mrr");
  const rec = run(bin, { MILO_RECORD: trace });
  expect(rec.code).toBe(0);
  expect(rec.out).toContain("total 100 hits 100 final 100\n");
  for (let i = 0; i < 20; i++) {
    const rep = run(bin, { MILO_REPLAY: trace });
    expect(rep.err).toBe("");
    expect(rep.code).toBe(0);
    expect(rep.out).toBe(rec.out);
  }
}, 120000);

// A worker's own OS reads (a file it reads, the environment) are recorded on its thread
// and replayed there, with the file gone and the variable changed.
test("Promise.blocking work replays, the worker's own reads included", () => {
  const data = join(dir, "worker.data");
  writeFileSync(data, "recorded contents\n");
  const bin = build("blockingwork", `from "std/runtime" import { Promise }
from "std/fs" import { readFile }
from "std/env" import { Env }

fn main() {
    var ps: Vec<Promise<string>> = Vec.new()
    for i in 0..3 {
        ps.push(Promise<string>.blocking(move (): string => {
            let text = readFile("${data}")!
            return i.toString() + " " + Env.getOr("WORK", "-") + " " + text.trim()
        }))
    }
    for p in ps {
        print(p.await()!)
    }
}
`);
  const trace = join(dir, "blocking.mrr");
  const rec = run(bin, { MILO_RECORD: trace, WORK: "rec" });
  expect(rec.code).toBe(0);
  expect(rec.out).toBe("0 rec recorded contents\n1 rec recorded contents\n2 rec recorded contents\n");
  rmSync(data);
  const rep = run(bin, { MILO_REPLAY: trace, WORK: "live" });
  expect(rep.err).toBe("");
  expect(rep.out).toBe(rec.out);
  // The worker records carry their thread numbers.
  const kinds = JSON.parse(spawnSync("bun", ["run", MAIN, "trace", trace, "--json"], { encoding: "utf-8" }).stdout).records;
  expect(new Set(kinds.filter((r: any) => r.kind === "fs.open").map((r: any) => r.thread))).toEqual(new Set([1, 2, 3]));
}, 60000);

test("a thread closure sharing unsafe memory is a hole, listed and reported", () => {
  const file = write("rawshare", `from "std/runtime" import { Promise }
from "std/os" import { malloc }

struct Cell {
    p: *u8,
}

unsafe impl Send for Cell {
}

fn main() {
    var c = Cell { p: 0 as *u8 }
    unsafe { c.p = malloc(8) }
    let pr = Promise<i64>.blocking(move (): i64 => {
        let q = c.p
        unsafe { q[0] = 7 }
        return 1
    })
    print("done " + pr.await()!.toString())
}
`);
  const listed = spawnSync("bun", ["run", MAIN, "check", "--replay-holes", file], { cwd: ROOT, encoding: "utf-8" });
  expect(listed.stderr).toContain("it captures 'c', which carries a raw pointer");
  const bin = join(dir, "rawshare");
  execFileSync("bun", ["run", MAIN, "build", file, "-o", bin], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const rec = run(bin, { MILO_RECORD: join(dir, "raw.mrr") });
  expect(rec.out).toBe("done 1\n");
  expect(rec.err).toBe(`replay: this run called unrecorded unsafe shared memory at ${file}:14; a replay may diverge\n`);
}, 60000);
