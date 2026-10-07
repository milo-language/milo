// Record/replay phase 1 (std/replay, docs/record-replay.md): clock, entropy, timezone,
// environment and argv recorded under MILO_RECORD and answered from the trace under
// MILO_REPLAY.
//
// Every replay here runs with a DIFFERENT environment, different argv and a later
// clock than its recording, and asserts byte-identical stdout. Any input that slipped
// past the hook shows up as a differing line; the assertions on the replayed values
// themselves (the recorded env value, the recorded argv) make sure the identity is not
// two runs that happened to agree.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "milo-replay-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function build(name: string, src: string): string {
  const file = join(dir, `${name}.milo`);
  const out = join(dir, name);
  writeFileSync(file, src);
  execFileSync("bun", ["run", MAIN, "build", file, "-o", out], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

// A clean environment plus `extra`, so an inherited MILO_RECORD from whoever runs the
// suite cannot leak in.
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.MILO_RECORD;
  delete e.MILO_REPLAY;
  return { ...e, ...extra };
}

function run(bin: string, args: string[], extra: Record<string, string>) {
  const r = spawnSync(bin, args, { cwd: dir, env: env(extra), encoding: "utf-8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

// Every phase 1 source, plus the paths that reach them indirectly: a global
// initializer (runs before main), DateTime, uuid, a green task sleeping on the
// scheduler (whose own clock reads are deliberately unrecorded), and HashMap
// iteration order (seeded from entropy unless recording or replaying).
const PROGRAM = `from "std/time" import { now, since, epochMillis, sleepMs }
from "std/random" import { Random }
from "std/env" import { Env }
from "std/environ" import { envVars }
from "std/args" import { args }
from "std/uuid" import { Uuid }
from "std/datetime" import { DateTime }
from "std/runtime" import { Task }

var startedAt: i64 = epochMillis()

fn main() {
    let t0 = now()
    print("wall " + t0.sec.toString() + " " + t0.usec.toString())
    print("global " + startedAt.toString())
    sleepMs(2)
    print("delta " + since(t0).toMicros().toString())
    for _ in 0..3 {
        print("rand " + Random.int(1000000).toString() + " " + Random.u32().toString() + " " + Random.float().toString())
    }
    var b: [u8; 8] = [0; 8]
    unsafe { Random.bytes(b as *u8, 8) }
    print("bytes " + b[0].toString() + " " + b[3].toString() + " " + b[7].toString())
    print("uuid " + Uuid.v4().toString())
    print("local " + DateTime.localNow().format())
    print("utc " + DateTime.now().format())
    print("env " + Env.getOr("RR_VALUE", "<unset>"))
    print("unset " + Env.getOr("RR_NEVER_SET", "<unset>"))
    print("record var " + Env.getOr("MILO_RECORD", "<unset>"))
    var seen = 0
    for e in envVars() {
        if e.name == "RR_VALUE" {
            seen += 1
            print("environ " + e.value)
        }
    }
    print("environ count " + seen.toString())
    for a in args() {
        print("arg " + a)
    }
    var m: HashMap<string, i64> = HashMap.new()
    for i in 0..12 {
        m.insert("k" + i.toString(), i)
    }
    var order = ""
    for k in m.keys() {
        order.pushStr(k)
        order.push(' ')
    }
    print("map " + order)
    let task = Task.spawnWithStack(move(): void => {
        sleepMs(15)
        print("task " + epochMillis().toString())
    }, 1048576)
    task.join()
}
`;

let prog = "";
const recorded = () => join(dir, "prog.mrr");
let recordedOut = "";

test("record, then replay under a different env, argv and clock: byte-identical output", async () => {
  prog = build("prog", PROGRAM);
  const rec = run(prog, ["alpha", "beta gamma"], { MILO_RECORD: recorded(), RR_VALUE: "first", TZ: "America/Los_Angeles" });
  expect(rec.err).toBe("");
  expect(rec.code).toBe(0);
  recordedOut = rec.out;
  expect(readFileSync(recorded(), "utf-8").startsWith("milo-trace 1\n")).toBe(true);
  // The child-inheritance guard: std/replay removes the variable once it has read it.
  expect(rec.out).toContain("record var <unset>\n");

  // Later wall clock by at least a second, so a leaked clock read differs in `wall`.
  await Bun.sleep(1100);
  const rep = run(prog, ["other"], { MILO_REPLAY: recorded(), RR_VALUE: "second", TZ: "Asia/Tokyo" });
  expect(rep.err).toBe("");
  expect(rep.code).toBe(0);
  expect(rep.out).toBe(recordedOut);
  // The identity holds because the recorded values came back, not because both runs
  // happened to see the same inputs.
  expect(rep.out).toContain("env first\n");
  expect(rep.out).toContain("environ first\n");
  expect(rep.out).toContain("arg alpha\narg beta gamma\n");
  expect(rep.out).not.toContain("arg other");
}, 120000);

test("milo run --record / --replay is the same mechanism", () => {
  const src = join(dir, "prog.milo");
  const trace = join(dir, "cli.mrr");
  const runCli = (flag: string, args: string[], value: string) =>
    spawnSync("bun", ["run", MAIN, "run", src, flag, trace, ...args],
      { cwd: ROOT, env: env({ RR_VALUE: value }), encoding: "utf-8" });
  const rec = runCli("--record", ["one"], "cli-first");
  expect(rec.status).toBe(0);
  const rep = runCli("--replay", ["two", "three"], "cli-second");
  expect(rep.status).toBe(0);
  expect(rep.stdout).toBe(rec.stdout);
  expect(rep.stdout).toContain("env cli-first\n");
}, 120000);

// Same first call as PROGRAM (the global initializer's clock read), then a call
// PROGRAM did not make next.
const DIVERGES = `from "std/time" import { epochMillis }
from "std/random" import { Random }

fn main() {
    print("t " + epochMillis().toString())
    print("r " + Random.u32().toString())
}
`;

test("a different call order stops with the divergence message and exit code 3", () => {
  const bin = build("diverges", DIVERGES);
  const r = run(bin, [], { MILO_REPLAY: recorded() });
  expect(r.code).toBe(3);
  expect(r.err.split("\n")[0]).toBe("replay diverged at record 2: expected time.wall, got random.u32");
});

test("a call of the right kind with a different argument also diverges", () => {
  const bin = build("envA", `from "std/env" import { Env }
fn main() {
    print(Env.getOr("RR_A", "-"))
}
`);
  const binB = build("envB", `from "std/env" import { Env }
fn main() {
    print(Env.getOr("RR_B", "-"))
}
`);
  const trace = join(dir, "env.mrr");
  expect(run(bin, [], { MILO_RECORD: trace }).code).toBe(0);
  const r = run(binB, [], { MILO_REPLAY: trace });
  expect(r.code).toBe(3);
  expect(r.err.split("\n")[0]).toBe("replay diverged at record 1: expected env.get(RR_A), got env.get(RR_B)");
});

test("running past the end of the trace diverges", () => {
  const short = build("short", `from "std/time" import { epochMillis }
fn main() {
    print(epochMillis().toString())
}
`);
  const trace = join(dir, "short.mrr");
  expect(run(short, [], { MILO_RECORD: trace }).code).toBe(0);
  const bin = build("diverges2", DIVERGES);
  const r = run(bin, [], { MILO_REPLAY: trace });
  expect(r.code).toBe(3);
  expect(r.err.split("\n")[0]).toBe("replay diverged at record 2: expected end of trace, got random.u32");
});

test("a missing or foreign trace, or both variables set, is refused with exit code 3", () => {
  const missing = run(prog, [], { MILO_REPLAY: join(dir, "nope.mrr") });
  expect(missing.code).toBe(3);
  expect(missing.err).toContain("replay: cannot open trace file");
  const foreign = join(dir, "foreign.mrr");
  writeFileSync(foreign, "1 time.wall 0 3\n\n1 2\n");
  const bad = run(prog, [], { MILO_REPLAY: foreign });
  expect(bad.code).toBe(3);
  expect(bad.err).toContain("is not a milo-trace version 1 file");
  const both = run(prog, [], { MILO_REPLAY: recorded(), MILO_RECORD: join(dir, "x.mrr") });
  expect(both.code).toBe(3);
  expect(both.err).toContain("MILO_RECORD and MILO_REPLAY are both set");
});

test("with neither variable set (or set empty) every read goes to the OS, as before", () => {
  const a = run(prog, ["live-a"], { RR_VALUE: "live-1" });
  const b = run(prog, ["live-b"], { RR_VALUE: "live-2", MILO_RECORD: "", MILO_REPLAY: "" });
  for (const [r, arg, value] of [[a, "live-a", "live-1"], [b, "live-b", "live-2"]] as const) {
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(`arg ${arg}\n`);
    expect(r.out).toContain(`env ${value}\n`);
    expect(r.out).toContain(`environ ${value}\n`);
  }
  // Fresh entropy per run: the three random lines and the uuid agreeing across two
  // live runs is a 2^-100-ish coincidence, not a flake.
  const randoms = (s: string) => s.split("\n").filter(l => l.startsWith("rand ") || l.startsWith("uuid ")).join("\n");
  expect(randoms(a.out)).not.toBe(randoms(b.out));
  expect(existsSync(join(dir, "x.mrr"))).toBe(false);
}, 60000);

// Phase 4: a Promise.blocking worker's hooked calls are recorded too, tagged with the
// worker's thread number, and replayed on that thread. It still has to compile under the
// checker's thread-boundary race check (dapweb reads the environment on a worker), which
// is why std/replay's shared state is only written inside its @synchronized lock.
test("a hooked call on an OS thread is recorded and replayed on that thread", () => {
  const bin = build("worker", `from "std/env" import { Env }
from "std/runtime" import { Promise }

fn main() {
    print("main " + Env.getOr("RR_VALUE", "-"))
    let p = Promise<string>.blocking(move(): string => {
        return Env.getOr("RR_VALUE", "-")
    })
    print("worker " + p.await()!)
}
`);
  const trace = join(dir, "worker.mrr");
  const rec = run(bin, [], { MILO_RECORD: trace, RR_VALUE: "rec" });
  expect(rec.code).toBe(0);
  expect(rec.out).toBe("main rec\nworker rec\n");
  const rep = run(bin, [], { MILO_REPLAY: trace, RR_VALUE: "live" });
  expect(rep.code).toBe(0);
  expect(rep.err).toBe("");
  expect(rep.out).toBe("main rec\nworker rec\n");
  expect(readFileSync(trace, "latin1")).toMatch(/\n\d+ env\.get@1 8 \d+\n/);
});

test("HashMap iteration order is fixed under record and replay, entropy-seeded otherwise", () => {
  const mapLine = (s: string) => s.split("\n").find(l => l.startsWith("map "));
  const recMap = mapLine(recordedOut);
  // Two recordings agree with each other, not just with their own replay.
  const again = run(prog, [], { MILO_RECORD: join(dir, "again.mrr") });
  expect(mapLine(again.out)).toBe(recMap);
  // Live runs: 12 keys give 12! orders, so some run of five differs from the fixed one.
  const live = new Set<string | undefined>();
  for (let i = 0; i < 5; i++) live.add(mapLine(run(prog, [], {}).out));
  expect([...live].some(l => l !== recMap)).toBe(true);
}, 60000);
