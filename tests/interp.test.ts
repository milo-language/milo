// The reference interpreter (src/interp.ts) against docs/semantics/milo.md: small programs
// whose output pins one rule each (move, field move, drop order, &mut write-back, temporaries),
// a program the checker would reject run anyway to see it get stuck, and the @expect comparison
// (scripts/interp-coverage.ts) over a slice of the fixtures.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { InterpCo, runChecked, type RunOptions, type Task } from "../src/interp-co";
import { explore, type ExploreOptions } from "../src/interp-explore";
import { InterpStuck } from "../src/interp-values";
import type { Program } from "../src/ast";
import type { CheckResult } from "../src/checker";
import { compareOne } from "../scripts/interp-coverage";

const dir = mkdtempSync(join(tmpdir(), "milo-interp-test-"));
let n = 0;
const checkedOf = new Map<Program, CheckResult>();
function check(src: string): { program: Program; interp: Interp } {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, src);
  const tokens = new Lexer(src).tokenize();
  const parsed = new Parser(tokens, src, path).parse();
  const program = resolveImports(parsed, dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  const errors = result.diagnostics.filter(d => d.severity === "error");
  if (errors.length) throw new Error(`checker rejected the test program: ${errors.map(e => e.message).join("; ")}`);
  checkedOf.set(program, result);
  return { program, interp: new Interp(program, result) };
}
const run = (src: string) => {
  const r = check(src).interp.run();
  return { out: new TextDecoder().decode(r.stdout), code: r.code, live: r.live };
};

const NOISY = `
struct Noisy { id: i64 }
impl Drop for Noisy {
    fn drop(self: &mut Self) { print("drop ", self.id) }
}
fn mk(id: i64): Noisy { return Noisy { id: id } }
`;

test("E-MOVE: a moved Vec is dropped once, by its new owner, and no block leaks", () => {
  const r = run(`
fn len(v: Vec<i64>): i64 { return v.len }
fn main() {
    var v: Vec<i64> = [1, 2, 3]
    v.push(4)
    let w = v
    print(len(w))
}`);
  expect(r.out).toBe("4\n");
  expect(r.live).toBe(0);
});

test("E-FIELD-MOVE: moving one field leaves the other to drop with its struct", () => {
  const r = run(`${NOISY}
struct Pair { a: Noisy, b: Noisy }
fn take(n: Noisy) { print("took ", n.id) }
fn main() {
    let p = Pair { a: mk(1), b: mk(2) }
    take(p.a)
    print("end")
}`);
  expect(r.out).toBe("took 1\ndrop 1\nend\ndrop 2\n");
});

test("S-SCOPE-END: variables drop in reverse declaration order, fields last first", () => {
  const r = run(`${NOISY}
struct Pair { a: Noisy, b: Noisy }
fn main() {
    let x = mk(1)
    let p = Pair { a: mk(2), b: mk(3) }
    let y = mk(4)
    print("end")
}`);
  expect(r.out).toBe("end\ndrop 4\ndrop 3\ndrop 2\ndrop 1\n");
});

test("S-ASSIGN-REF: a write through &mut lands in the caller's slot, and S-ASSIGN drops the old value", () => {
  const r = run(`${NOISY}
fn bump(n: &mut Noisy, to: i64) { n.id = to }
fn swapIn(n: &mut Noisy) { n = mk(9) }
fn main() {
    var a = mk(1)
    bump(&mut a, 5)
    print(a.id)
    swapIn(&mut a)
    print(a.id)
}`);
  expect(r.out).toBe("5\ndrop 5\n9\ndrop 9\n");
});

test("S-TEMP-CALL: a temporary lent to a by-ref parameter dies when the call returns", () => {
  const r = run(`${NOISY}
fn peek(n: &Noisy): i64 { return n.id * 2 }
fn main() {
    let r = peek(mk(7)) + peek(mk(8))
    print("got ", r)
}`);
  expect(r.out).toBe("drop 7\ndrop 8\ngot 30\n");
});

test("panics exit 134 and run no drops", () => {
  const r = run(`${NOISY}
fn main() {
    let n = mk(1)
    let v: Vec<i64> = [1]
    print(v[3])
}`);
  expect(r.code).toBe(134);
  expect(r.out).toBe("");
  expect(r.live).toBeNull();
});

test("E-STUCK: reading a moved variable stops the run, naming the rule", () => {
  // The checker rejects this program, so take a valid one and aim a read at the moved slot.
  const { program, interp } = check(`
fn main() {
    let s = "a" + "b"
    let t = s
    print(t)
}`);
  const main = program.functions.find(f => f.name === "main")!;
  const printCall = (main.body[2] as { expr: { args: { name: string }[] } }).expr;
  printCall.args[0]!.name = "s";
  let rule = "";
  try { interp.run(); } catch (e) { rule = (e as InterpStuck).rule; }
  expect(rule).toBe("E-STUCK");
});

// ── raw memory and the C layer (docs/semantics/milo.md §5, R-MEM-* and R-SYS-*) ──
const MEM = `from "std/os" import { malloc, free, memset, memcpy, realloc }\n`;
// run a program that must get stuck; returns the rule it names
function stuckRule(src: string): string {
  try { run(src); } catch (e) { return (e as InterpStuck).rule; }
  return "";
}

test("R-MEM-LOAD, R-MEM-STORE, R-MEM-ALLOC, R-MEM-FREE, R-MEM-COPY: malloc, typed stores and loads, memcpy, memset and free round-trip, and the block count returns to zero", () => {
  const r = run(MEM + `
fn main() {
    unsafe {
        let p = malloc(32) as *i64
        p[0] = 41
        p[1] = 7
        p[2] = p[0] + p[1]
        print(p[2])
        let q = malloc(8) as *i64
        memcpy(q as *u8, p as *u8, 8)
        print(q[0])
        memset(q as *u8, 0, 8)
        print(q[0])
        let b = p as *u8
        b[8] = 1
        print(p[1])
        free(p as *u8)
        free(q as *u8)
    }
}`);
  expect(r.out).toBe("48\n41\n0\n1\n"); // byte 8 is the low byte of p[1], so 7 becomes 1
  expect(r.live).toBe(0);
});

test("R-MEM-REALLOC: realloc keeps the old bytes", () => {
  const r = run(MEM + `
fn main() {
    unsafe {
        var p = malloc(8) as *i64
        p[0] = 99
        p = realloc(p as *u8, 64) as *i64
        p[7] = 5
        print(p[0] + p[7])
        free(p as *u8)
    }
}`);
  expect(r.out).toBe("104\n");
  expect(r.live).toBe(0);
});

test("R-MEM-OOB: a load past the end of an allocation is stuck", () => {
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = malloc(8) as *i64
        p[0] = 1
        print(p[1])
    }
}`)).toBe("R-MEM-OOB");
});

test("R-MEM-UAF and R-MEM-DOUBLE-FREE: a load after free and a second free are stuck", () => {
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = malloc(8) as *i64
        free(p as *u8)
        print(p[0])
    }
}`)).toBe("R-MEM-UAF");
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = malloc(8)
        free(p)
        free(p)
    }
}`)).toBe("R-MEM-DOUBLE-FREE");
});

test("R-MEM-NULL and R-MEM-ALIGN: a null load and a misaligned i64 load are stuck", () => {
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = 0 as *i64
        print(p[0])
    }
}`)).toBe("R-MEM-NULL");
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = malloc(16)
        let q = ((p as i64) + 4) as *i64
        print(q[0])
    }
}`)).toBe("R-MEM-ALIGN");
});

test("R-MEM-ADDROF and R-MEM-VECPTR: pointers into a fixed array and a Vec buffer read and write the structured value", () => {
  const r = run(`
fn main() {
    var a: [i32; 4] = [1, 2, 3, 4]
    var v: Vec<i64> = [10, 20, 30]
    unsafe {
        let p = a.addrOf() as *i32
        p[2] = 99
        let q = v.ptr()
        q[1] = q[0] + q[2]
        let bytes = a.addrOf() as *u8
        print(bytes[0])
    }
    print(a[2])
    print(v[1])
}`);
  expect(r.out).toBe("1\n99\n40\n");
});

test("R-MEM-CSTR: string.cstr() is NUL-terminated and strlen finds it", () => {
  const r = run(`
extern fn strlen(s: *u8): u64
fn main() {
    let s = "hello"
    unsafe {
        let p = s.cstr()
        print(strlen(p))
        print(p[5])
    }
}`);
  expect(r.out).toBe("5\n0\n");
});

test("R-SYS-FD: a file written through std/fs reads back from the in-memory filesystem, and the host is untouched", () => {
  const name = `milo_interp_memfs_${process.pid}.txt`;
  const r = runTasks(`
from "std/fs" import { readFile, writeFile, pathExists }
fn main() {
    print(pathExists("${name}"))
    let _w = writeFile("${name}", "in memory")
    print(pathExists("${name}"))
    match readFile("${name}") {
        Result.Ok(s) => print(s),
        Result.Err(_) => print("err"),
    }
}`);
  expect(r.out).toBe("false\ntrue\nin memory\n");
  expect(require("fs").existsSync(join(process.cwd(), name))).toBe(false);
});

test("R-SYS-FS: a program reads a file of the host's directory through a read-only HostFs, and its writes stay in memory", () => {
  const hostFs = {
    readFile: (p: string) => (p === "/data/in.txt" ? new TextEncoder().encode("from host") : null),
    readdir: () => null,
    stat: (p: string) => (p === "/data/in.txt" ? { size: 9, dir: false, mtimeMs: 0 } : p === "/data" ? { size: 0, dir: true, mtimeMs: 0 } : null),
  };
  const r = runTasks(`
from "std/fs" import { readFile, writeFile }
fn show(path: &string, fallback: &string) {
    match readFile(path) {
        Result.Ok(s) => print(s),
        Result.Err(_) => print(fallback),
    }
}
fn main() {
    show("in.txt", "missing")
    let _w = writeFile("in.txt", "changed")
    show("in.txt", "missing")
    show("/etc/passwd", "hidden")
}`, { sys: { hostFs, hostRoots: ["/data"], cwd: "/data" } });
  expect(r.out).toBe("from host\nchanged\nhidden\n");
});

test("R-SYS-FS: the memory and C layers import no node module, so the playground bundle needs no host stub for them", () => {
  for (const f of ["interp-mem.ts", "interp-sys.ts"]) {
    const src = require("fs").readFileSync(join(import.meta.dir, "..", "src", f), "utf-8") as string;
    const imports = [...src.matchAll(/^import [^;]*from "([^"]+)";/gm)].map(m => m[1]!);
    expect(imports.filter(i => !i.startsWith("./"))).toEqual([]);
  }
});

// Fixtures the interpreter must run exactly as the compiled golden does (stdout, exit, live blocks).
const FIXTURES = [
  "arithmetic", "closureCaptureFlexInt", "closureCapture", "closureCaptureDropMatrix", "closureCapturesDropped", "dropOrderFieldsVec",
  "forkTempReceiver", "forLoopReuse", "hashmapBasic", "hashmapGet", "hashmapGetOrDefault", "heapTempBoxRead",
  "matchLiteralExact", "matchLiterals", "resultPropagate", "resultPropagateDiffT", "structs", "vecTruncateClearStd", "whileLoop",
  "closureCaptureSelf",
  "channelGreenPark", "greenThread", "asyncCallOrdering", "taskScopeBorrow", "waitGroup", "promiseAll", "onceGreenTasks", "contracts",
];
// every fixture tagged `// @rule: ID` stands as the test for that rule (scripts/trace-semantics.ts check (c)), so it runs too
const FIXDIR = join(import.meta.dir, "fixtures");
const TAGGED = readdirSync(FIXDIR).filter(f => f.endsWith(".milo") && /^\/\/ @rule:/m.test(readFileSync(join(FIXDIR, f), "utf-8"))).map(f => f.slice(0, -5));
test("interp-coverage: a slice of the fixtures, and every fixture tagged with a rule, prints what its @expect lines say", async () => {
  const results = [];
  for (const name of new Set([...FIXTURES, ...TAGGED])) results.push(await compareOne({ path: join(import.meta.dir, "fixtures", `${name}.milo`), name, kind: "fixtures" }, dir));
  const bad = results.filter(r => r.verdict !== "same");
  expect(bad.map(r => `${r.name}: ${r.verdict} ${r.detail}`)).toEqual([]);
}, 600_000);

// ── tasks (docs/semantics/milo.md R-TASK-*, R-CHAN, R-WG) ──
const runTasks = (src: string, opts: RunOptions = {}) => {
  const { program } = check(src);
  const { it, result: r } = runChecked(program, checkedOf.get(program)!, opts);
  return { out: new TextDecoder().decode(r.stdout), err: r.stderr, code: r.code, live: r.live, co: it instanceof InterpCo };
};

test("R-TASK-SPAWN, R-TASK-YIELD, R-TASK-JOIN, R-TASK-MAIN: a spawned task waits for its spawner to park; the run queue is FIFO and yield goes to the back", () => {
  const r = runTasks(`
from "std/runtime" import { Task, schedulerYield }
fn main() {
    let a = Task.spawn(move(): void => {
        print("a1")
        schedulerYield()
        print("a2")
    })
    let b = Task.spawn(move(): void => {
        print("b1")
        schedulerYield()
        print("b2")
    })
    print("main")
    a.join()
    b.join()
    print("end")
}`);
  expect(r.out).toBe("main\na1\nb1\na2\nb2\nend\n");
  expect(r.co).toBe(true);
  expect(r.live).toBe(0);
});

test("R-CHAN: a full channel parks the sender, an empty one the receiver, and a send wakes without switching", () => {
  const r = runTasks(`
from "std/runtime" import { Task }
from "std/sync" import { Channel }
fn main() {
    let ch = Channel<i64>.new(1)!
    let tx = ch.clone()
    let p = Task.spawn(move(): void => {
        var i: i64 = 0
        while i < 3 {
            tx.send(i)!
            print("sent ", i)
            i = i + 1
        }
    })
    var n: i64 = 0
    while n < 3 {
        let v = ch.recv()!
        print("got ", v)
        n = n + 1
    }
    p.join()
}`);
  // main parks on the empty channel; the producer sends 0 (waking main, which stays queued), then parks on the full slot;
  // main takes 0 and wakes it, parks on the empty channel again, and the two alternate
  expect(r.out).toBe("sent 0\ngot 0\nsent 1\ngot 1\nsent 2\ngot 2\n");
  expect(r.live).toBe(0);
});

test("S-DEADLOCK: every task parked is a clear error naming the blocked tasks", () => {
  const { program } = check(`
from "std/sync" import { Channel }
fn main() {
    let ch = Channel<i64>.new(1)!
    print(ch.recv()!)
}`);
  let msg = "";
  try { runChecked(program, checkedOf.get(program)!); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("S-DEADLOCK");
  expect(msg).toContain("task 1 (main) parked in Channel.recv");
});

test("R-TASK-PANIC: a panic retires its task and the program goes on", () => {
  const r = runTasks(`
from "std/runtime" import { Task }
fn main() {
    let t = Task.spawn(move(): void => {
        let v: Vec<i64> = [1]
        print(v[5])
    })
    t.join()
    print("main goes on")
}`);
  expect(r.out).toBe("main goes on\n");
  expect(r.err).toContain("index out of bounds");
  expect(r.code).toBe(0);
});

test("R-ATOMIC and R-WG: tasks add to an atomic and the wait group releases the waiter", () => {
  const r = runTasks(`
from "std/runtime" import { Task }
from "std/sync" import { AtomicI64, WaitGroup }
fn main() {
    let wg = WaitGroup.new()
    let n = AtomicI64.new(0)
    var i: i64 = 0
    while i < 5 {
        wg.add(1)
        let w = wg.clone()
        let c = n.clone()
        Task.spawn(move(): void => {
            c.add(2)
            w.done()
        })
        i = i + 1
    }
    wg.wait()
    print(n.load())
}`);
  expect(r.out).toBe("10\n");
  expect(r.live).toBe(0);
});

test("R-TASK-PICK: the scheduling decision is one overridable method", () => {
  const { program } = check(`
from "std/runtime" import { Task }
fn main() {
    let a = Task.spawn(move(): void => { print("a") })
    let b = Task.spawn(move(): void => { print("b") })
    a.join()
    b.join()
}`);
  class Lifo extends InterpCo { override pickNext(ready: readonly Task[]): number { return ready.length - 1; } }
  const r = new Lifo(program, checkedOf.get(program)!).run();
  expect(new TextDecoder().decode(r.stdout)).toBe("b\na\n");
});

// ── contracts (R-CONTRACT-*) ──
test("R-CONTRACT-ENTRY, R-CONTRACT-EXIT, R-CONTRACT-FAIL: requires, and ensures with result and old(), abort like a debug build", () => {
  const src = (call: string) => `
fn bump(n: &mut i64, by: i64): i64
requires by >= 0
ensures n == old(n) + by
ensures result == n
{
    n = n + by
    return n
}
fn main() {
    var x: i64 = 1
    var lo: i64 = 2
    lo = lo - 3
    ${call}
    print("ok ", x)
}`;
  const good = runTasks(src("bump(&mut x, 2)"), { contractChecks: true, entryFile: "t.milo" });
  expect(good.out).toBe("ok 3\n");
  const bad = runTasks(src("bump(&mut x, lo)"), { contractChecks: true, entryFile: "t.milo" });
  expect(bad.code).toBe(134);
  expect(bad.out).toBe("");
  expect(bad.err).toMatch(/^runtime error: requires clause violated at \S*t\d*\.milo:3\n$/);
  // off by default, as in a release build
  expect(runTasks(src("bump(&mut x, lo)")).out).toBe("ok 0\n");
});

test("R-CONTRACT-IMPLIES: a false antecedent skips the consequent; a true one with a false consequent fails", () => {
  const src = (n: string) => `
fn f(n: i64): i64
requires n != 0 ==> 10 / n >= 1
ensures n > 5 ==> n > 3 ==> result == 0
{
    return 0
}
fn main() {
    print("ok ", f(${n}))
}`;
  // n == 0: 10 / n would trap if the consequent ran
  expect(runTasks(src("0"), { contractChecks: true, entryFile: "t.milo" }).out).toBe("ok 0\n");
  expect(runTasks(src("2"), { contractChecks: true, entryFile: "t.milo" }).out).toBe("ok 0\n");
  const bad = runTasks(src("20"), { contractChecks: true, entryFile: "t.milo" });
  expect(bad.code).toBe(134);
  expect(bad.err).toMatch(/requires clause violated/);
});

// ── schedule exploration (R-EXPLORE-*) ──
const exploreOpts = (o: Partial<ExploreOptions> = {}): ExploreOptions =>
  ({ maxSchedules: 1000, seed: 1, allowNondeterministicOutput: false, entryFile: "t.milo", sys: {}, ...o });
const exploreSrc = (src: string, o: Partial<ExploreOptions> = {}) => {
  const { program } = check(src);
  return explore(program, checkedOf.get(program)!, exploreOpts(o), "t.milo");
};

// Two tasks take two channel locks in opposite order. t2 yields once first, so the default (FIFO) run finishes
// both; only the interleaving where t2 gets to its first lock before t1 takes its second deadlocks.
const LOCK_ORDER = `
from "std/runtime" import { Task, schedulerYield }
from "std/sync" import { Channel }
fn main() {
    let la = Channel<i64>.new(1)!
    let lb = Channel<i64>.new(1)!
    let la2 = la.clone()
    let lb2 = lb.clone()
    let t1 = Task.spawn(move(): void => {
        la.send(1)!
        schedulerYield()
        lb.send(1)!
        print("t1 done")
        lb.recv()!
        la.recv()!
    })
    let t2 = Task.spawn(move(): void => {
        schedulerYield()
        lb2.send(1)!
        la2.send(1)!
        print("t2 done")
        la2.recv()!
        lb2.recv()!
    })
    t1.join()
    t2.join()
}`;

test("R-EXPLORE-CHOICE, R-EXPLORE-DFS, R-EXPLORE-FAIL, R-EXPLORE-REPLAY: a deadlock only one interleaving reaches is found and its schedule replays", () => {
  expect(runTasks(LOCK_ORDER).out).toBe("t1 done\nt2 done\n"); // the default schedule passes
  const rep = exploreSrc(LOCK_ORDER);
  expect(rep.findings.map(f => f.kind)).toEqual(["deadlock"]);
  expect(rep.text).toMatch(/FAIL deadlock/);
  expect(rep.text).toMatch(/stopped at t\d+\.milo:\d+/);
  const sched = rep.findings[0]!.run.schedule;
  expect(sched.length).toBeGreaterThan(0);
  expect(rep.text).toContain(`replay: milo interp t.milo --schedule ${sched.join(",")}`);
  // replaying the printed schedule reproduces the deadlock; the default schedule still passes
  const { program } = check(LOCK_ORDER);
  let rule = "";
  try { runChecked(program, checkedOf.get(program)!, { schedule: sched }); } catch (e) { rule = (e as InterpStuck).rule; }
  expect(rule).toBe("S-DEADLOCK");
});

test("R-EXPLORE-RANDOM: random PCT schedules find the lock-order deadlock too, from a seed", () => {
  const { program } = check(LOCK_ORDER);
  const go = () => explore(program, checkedOf.get(program)!, exploreOpts({ random: 60, seed: 7 }), "t.milo");
  const rep = go();
  expect(rep.findings.map(f => f.kind)).toContain("deadlock");
  expect(go().text).toBe(rep.text); // same seed, same report
}, 60_000); // runs dozens of schedules; the 5s default trips under machine load

test("R-EXPLORE-FAIL: stdout that depends on the schedule is flagged, and --allow-nondeterministic-output accepts it", () => {
  const src = `
from "std/runtime" import { Task }
fn main() {
    let a = Task.spawn(move(): void => { print("a") })
    let b = Task.spawn(move(): void => { print("b") })
    a.join()
    b.join()
}`;
  const rep = exploreSrc(src);
  expect(rep.findings.map(f => f.kind)).toEqual(["nondeterministic-output"]);
  expect(rep.text).toMatch(/stdout differs/);
  expect(exploreSrc(src, { allowNondeterministicOutput: true }).failures).toBe(0);
});

test("R-EXPLORE-INDEP: tasks that share nothing are clean, and independent choices are not explored", () => {
  const src = `
from "std/runtime" import { Task, schedulerYield }
from "std/sync" import { Channel }
fn main() {
    let c1 = Channel<i64>.new(1)!
    let c2 = Channel<i64>.new(1)!
    let r1 = c1.clone()
    let r2 = c2.clone()
    let a = Task.spawn(move(): void => { c1.send(1)!; schedulerYield(); c1.send(2)! })
    let b = Task.spawn(move(): void => { c2.send(10)!; schedulerYield(); c2.send(20)! })
    let c = Task.spawn(move(): void => { r1.recv()!; r1.recv()!; r2.recv()!; r2.recv()! })
    a.join()
    b.join()
    c.join()
    print("done")
}`;
  const rep = exploreSrc(src);
  expect(rep.failures).toBe(0);
  expect(rep.schedules).toBeGreaterThan(1);
  expect(rep.text).toMatch(/^explore: \d+ schedules? /);
  expect(rep.text).toMatch(/no deadlock, panic/);
  expect(rep.text).toMatch(/[1-9]\d* choices? skipped as independent/);
});

test("R-EXPLORE-FAIL: an assert only some schedules fail is reported with its kind", () => {
  const rep = exploreSrc(`
from "std/runtime" import { Task, schedulerYield }
from "std/sync" import { AtomicI64 }
fn main() {
    let n = AtomicI64.new(0)
    let n2 = n.clone()
    let n3 = n.clone()
    let a = Task.spawn(move(): void => {
        let seen = n.load()
        schedulerYield()
        n.store(seen + 1)
    })
    let b = Task.spawn(move(): void => {
        schedulerYield()
        let seen = n2.load()
        schedulerYield()
        n2.store(seen + 1)
    })
    a.join()
    b.join()
    assert(n3.load() == 2, "lost update")
}`);
  expect(rep.findings.map(f => f.kind)).toEqual(["assert"]);
});

test("the generated task twin (src/interp-gen.ts) is current", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "gen-interp-co.ts"), "--check"]);
  expect(r.exitCode).toBe(0);
});

// ── rule coverage the trace gate counts (scripts/trace-semantics.ts, check (c)): core rules, the failure table, stuck states ──
function errorsOf(src: string): string[] {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, src);
  const program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dirname(path), getHostTarget(), path);
  return new TypeChecker().check(program).diagnostics.filter(d => d.severity === "error").map(d => d.message);
}
// run a program the checker rejects anyway, to see which rule the interpreter gets stuck on
function stuckLoose(src: string): string {
  const path = join(dir, `t${n++}.milo`);
  writeFileSync(path, src);
  const program = resolveImports(new Parser(new Lexer(src).tokenize(), src, path).parse(), dirname(path), getHostTarget(), path);
  const result = new TypeChecker().check(program);
  try { new Interp(program, result).run(); } catch (e) { return (e as InterpStuck).rule; }
  return "";
}

test("E-COPY, E-CALL, S-LET, S-VAR: a Copy struct is copied by a read, a call gets its own frame, a var may be assigned", () => {
  const r = run(`
struct P { x: i64, y: i64 }
fn sum(p: P): i64 { return p.x + p.y }
fn main() {
    let a = P { x: 1, y: 2 }
    var b = a
    b.x = 10
    print(sum(a), " ", sum(b))
}`);
  expect(r.out).toBe("3 12\n");
});

test("S-TEMP, S-TEMP-FIELD: a temporary drops at the end of its statement; a field read out of one moves it and drops the rest at once", () => {
  const r = run(`${NOISY}
struct Pair { a: Noisy, b: Noisy }
fn mk2(): Pair { return Pair { a: mk(1), b: mk(2) } }
fn main() {
    let n = mk(5).id
    print("n ", n)
    let first = mk2().a
    print("first ", first.id)
}`);
  expect(r.out).toBe("drop 5\nn 5\ndrop 2\nfirst 1\ndrop 1\n");
  expect(r.live).toBe(0);
});

test("T-LET, T-MOVED, T-EXCL, T-SHARED-READONLY, T-NO-MOVE-OUT, T-REF-PARAM: the checker rejects each program the rule names", () => {
  const P = `struct P { x: i64 }\nstruct H { v: Vec<i64> }\n`;
  const bad: [string, string][] = [
    ["T-LET", `fn main() { let x = 1\n x = 2\n print(x) }`],
    ["T-MOVED", `fn main() { let v: Vec<i64> = [1]\n let w = v\n print(v.len())\n print(w.len()) }`],
    ["T-EXCL", `${P}fn g(a: &mut P, b: &mut P) { a.x = b.x }\nfn main() { var p = P { x: 1 }\n g(p, p)\n print(p.x) }`],
    ["T-SHARED-READONLY", `${P}fn f(p: &P) { p.x = 1 }\nfn main() { var p = P { x: 0 }\n f(p)\n print(p.x) }`],
    ["T-NO-MOVE-OUT", `${P}fn f(h: &H): Vec<i64> { return h.v }\nfn main() { let h = H { v: [1] }\n print(f(h).len()) }`],
    ["T-REF-PARAM", `struct R { r: &i64 }\nfn main() { print(1) }`],
  ];
  for (const [rule, src] of bad) expect({ rule, rejected: errorsOf(src).length > 0 }).toEqual({ rule, rejected: true });
});

test("T-ASSIGN-MOVED-OK: assigning a moved variable makes it owned again", () => {
  const r = run(`${NOISY}
fn main() {
    var a = mk(1)
    let b = a
    a = mk(2)
    print(a.id, b.id)
}`);
  expect(r.out).toBe("21\ndrop 1\ndrop 2\n");
});

test("T-STUCK, T-SHARED-READONLY: a write through a shared reference, which the checker rejects, stops the run on S-ASSIGN-REF", () => {
  expect(stuckLoose(`struct P { x: i64 }
fn f(p: &P) { p.x = 1 }
fn main() {
    var p = P { x: 0 }
    f(p)
    print(p.x)
}`)).toBe("S-ASSIGN-REF");
});

test("E-VEC, E-STRING-SHARE: a Vec with no capacity owns no block, and a string copied out of a borrow shares its buffer", () => {
  expect(run(`fn main() {\n let v: Vec<i64> = Vec.new()\n exit(0)\n}`).live).toBe(0);
  expect(run(`fn main() {\n var v: Vec<i64> = Vec.new()\n v.push(1)\n exit(0)\n}`).live).toBe(1);
  const r = run(`
fn keep(v: &Vec<string>): string { return v[0] }
fn main() {
    var v: Vec<string> = Vec.new()
    v.push("ab" + "c")
    let s = keep(v)
    print(s, v[0])
    exit(0)
}`);
  expect(r.out).toBe("abcabc\n");
  expect(r.live).toBe(2); // the Vec buffer, and one string buffer with a count of 2
});

test("E-PROPAGATE: ? yields the payload on Ok and returns the error from the enclosing fn on Err", () => {
  const r = run(`
fn half(n: i64): Result<i64, string> {
    if n % 2 != 0 { return Err("odd") }
    return Ok(n / 2)
}
fn quarter(n: i64): Result<i64, string> {
    let h = half(n)?
    return half(h)
}
fn main() {
    print(quarter(8)!)
    match quarter(6) {
        Ok(v) => print("ok ", v),
        Err(e) => print("err ", e),
    }
}`);
  expect(r.out).toBe("2\nerr odd\n");
});

test("S-PANIC-ABORT: every runtime failure is status 134 with the output so far flushed and no live count; exit(n) is n; a stack overflow is 139", () => {
  const kinds: [string, string][] = [
    ["bounds", `fn main() { var v: Vec<i64> = Vec.new()\n v.push(1)\n let i = v.len() + 4\n print("x")\n print(v[i]) }`],
    ["overflow", `fn one(): i32 { return 1 }\nfn main() { let x: i32 = 2147483647\n print("x")\n print(x + one()) }`],
    ["division", `fn z(): i64 { return 0 }\nfn main() { print("x")\n print(5 / z()) }`],
    ["remainder", `fn z(): i64 { return 0 }\nfn main() { print("x")\n print(5 % z()) }`],
    ["shift", `fn z(): i64 { return 70 }\nfn main() { print("x")\n print(1 << z()) }`],
    ["unwrap", `fn nothing(): Option<i64> { return None }\nfn main() { print("x")\n print(nothing()!) }`],
    ["assert", `fn main() { print("x")\n assert(1 == 2, "no") }`],
  ];
  for (const [kind, src] of kinds) {
    const r = run(src);
    expect({ kind, code: r.code, out: r.out, live: r.live }).toEqual({ kind, code: 134, out: "x\n", live: null });
  }
  const e = run(`fn main() { print("x")\n exit(3) }`);
  expect({ code: e.code, out: e.out }).toEqual({ code: 3, out: "x\n" });
  expect(run(`fn f(n: i64): i64 { return f(n + 1) + 1 }\nfn main() { print(f(0)) }`).code).toBe(139);
});

test("R-MEM-ADDR, R-MEM-FREE-INVALID, R-MEM-OVERLAP, R-MEM-PROVENANCE, R-MEM-LAYOUT: the remaining raw-memory rules", () => {
  const r = run(MEM + `
fn main() {
    unsafe {
        let p = malloc(16) as *i64
        let a = p as i64
        let q = a as *i64
        q[0] = 5
        print(p[0])
        print(a == (q as i64))
        free(p as *u8)
    }
}`);
  expect(r.out).toBe("5\ntrue\n");
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        var x: i64 = 0
        free(x.addrOf() as *u8)
    }
}`)).toBe("R-MEM-FREE-INVALID");
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = malloc(16) as *u8
        memcpy(p, p, 8)
    }
}`)).toBe("R-MEM-OVERLAP");
  expect(stuckRule(MEM + `
fn main() {
    unsafe {
        let p = 4096 as *i64
        print(p[0])
    }
}`)).toBe("R-MEM-PROVENANCE");
  expect(stuckLoose(`
struct S { a: i64 }
fn main() {
    print(offsetOf<S>("nope"))
}`)).toBe("R-MEM-LAYOUT");
});

test("R-SYS-ENV, R-SYS-CLOCK, R-SYS-RANDOM, R-SYS-EXIT, R-REPLAY-OFF, R-MEM-WRITE-RO: the environment, the clock, entropy, _exit, record/replay off, a read-only message", () => {
  const r = run(`
from "std/time" import { epochMillis }
extern fn getenv(name: *u8): *u8
extern fn setenv(name: *u8, value: *u8, overwrite: i32): i32
extern fn time(t: *i64): i64
extern fn sleep(s: u32): u32
extern fn arc4random_uniform(n: u32): u32
fn main() {
    unsafe {
        print(getenv("MILO_TRACE_UNSET".cstr()) as i64)
        setenv("MILO_TRACE_SET".cstr(), "7".cstr(), 1)
        let p = getenv("MILO_TRACE_SET".cstr())
        print(p[0] as i64)
        let t0 = time(0 as *i64)
        sleep(3)
        print(time(0 as *i64) - t0 >= 3)
        print(arc4random_uniform(10) < 10)
    }
    print(epochMillis() > 0)
}`);
  expect(r.out).toBe("0\n55\ntrue\ntrue\ntrue\n");
  const e = run(`
extern fn _exit(code: i32): void
fn main() {
    print("x")
    unsafe { _exit(5) }
}`);
  expect({ code: e.code, out: e.out }).toEqual({ code: 5, out: "x\n" });
  expect(stuckRule(`
extern fn strerror(e: i32): *u8
fn main() {
    unsafe {
        let p = strerror(2)
        p[0] = 1
    }
}`)).toBe("R-MEM-WRITE-RO");
});
