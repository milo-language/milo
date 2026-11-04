// The reference interpreter (src/interp.ts) against docs/semantics/mini-milo.md: small programs
// whose output pins one rule each (move, field move, drop order, &mut write-back, temporaries),
// a program the checker would reject run anyway to see it get stuck, and the golden comparison
// (scripts/interp-vs-golden.ts) over a slice of the fixtures.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { resolveImports } from "../src/resolver";
import { TypeChecker } from "../src/checker";
import { getHostTarget } from "../src/target";
import { Interp } from "../src/interp";
import { InterpCo, runChecked, type RunOptions, type Task } from "../src/interp-co";
import { InterpStuck } from "../src/interp-values";
import type { Program } from "../src/ast";
import type { CheckResult } from "../src/checker";
import { compareOne } from "../scripts/interp-vs-golden";

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

// Fixtures the interpreter must run exactly as the compiled golden does (stdout, exit, live blocks).
const FIXTURES = [
  "arithmetic", "closureCaptureFlexInt", "closureCapture", "closureCaptureDropMatrix", "closureCapturesDropped", "dropOrderFieldsVec",
  "forkTempReceiver", "forLoopReuse", "hashmapBasic", "hashmapGet", "hashmapGetOrDefault", "heapTempBoxRead",
  "matchLiteralExact", "matchLiterals", "resultPropagate", "resultPropagateDiffT", "structs", "vecTruncateClearStd", "whileLoop",
  "closureCaptureSelf",
  "channelGreenPark", "greenThread", "asyncCallOrdering", "taskScopeBorrow", "waitGroup", "promiseAll", "onceGreenTasks", "contracts",
];
test("interp-vs-golden: a slice of the fixtures is the same as the compiled run", async () => {
  const results = [];
  for (const name of FIXTURES) results.push(await compareOne({ path: join(import.meta.dir, "fixtures", `${name}.milo`), name, kind: "fixtures" }, dir));
  const bad = results.filter(r => r.verdict !== "same");
  expect(bad.map(r => `${r.name}: ${r.verdict} ${r.detail}`)).toEqual([]);
}, 120_000);

// ── tasks (docs/semantics/mini-milo.md R-TASK-*, R-CHAN, R-WG) ──
const runTasks = (src: string, opts: RunOptions = {}) => {
  const { program } = check(src);
  const { it, result: r } = runChecked(program, checkedOf.get(program)!, opts);
  return { out: new TextDecoder().decode(r.stdout), err: r.stderr, code: r.code, live: r.live, co: it instanceof InterpCo };
};

test("R-TASK-SPAWN: a spawned task waits for its spawner to park; the run queue is FIFO and yield goes to the back", () => {
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
test("R-CONTRACT: requires, ensures with result and old(), and loop invariants abort like a debug build", () => {
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

test("the generated task twin (src/interp-gen.ts) is current", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "gen-interp-co.ts"), "--check"]);
  expect(r.exitCode).toBe(0);
});
