// Destructor accounting as a falsifiable invariant: every value constructed must be
// destroyed exactly once.
//
// This needs no per-shape expected count and no model of what the program means. It
// composes random combinations of the shapes a value can travel through (bound, left
// as a temporary, captured by a `move` closure, put in a container, carried through an
// early exit) and asks the program itself whether the books balance.
//
// That matters because the bugs in this area are INVISIBLE to the other oracles. A
// struct that owns no heap and never runs its destructor leaks nothing, so `leaks` and
// AddressSanitizer both report clean. Counting Drop runs is the only thing that sees
// it, and hand-enumerating shapes found three real bugs in one sitting -- a zero-valued
// capture never destroyed, a nested re-capture destroyed twice, and `makeRes().id`
// destroying nothing at all. This generates the combinations nobody thought to write.
//
//   bun scripts/fuzz-drops.ts --cases 200 --seed 1
//   bun scripts/fuzz-drops.ts --cases 50 --sanitize     # also run each under ASan
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const args = process.argv.slice(2);
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1]!, 10) : dflt;
};
const CASES = num("--cases", 200);
const SEED = num("--seed", 1);
const SANITIZE = args.includes("--sanitize");
const KEEP = args.includes("--keep");
const ROOT = join(import.meta.dir, "..");

// deterministic PRNG so a failing case is reproducible from its seed alone
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// The counters are atomics because a Res moved into Promise.blocking drops on a worker
// thread; plain globals there are a data race the checker rejects.
const PRELUDE = `from "std/runtime" import {\n    Task, Promise\n}\nfrom "std/sync" import { AtomicI64 }\n\nvar sink2: i64 = 0\nlet made: AtomicI64 = AtomicI64.new(0)
let gone: AtomicI64 = AtomicI64.new(0)

struct Res {
    id: i64,
}

impl Drop for Res {
    fn drop(self: &mut Self): void {
        gone.add(1)
    }
}

impl Res {
    fn get(self: &Self): i64 {
        return self.id
    }
}

struct Wrap {
    inner: Res,
}

fn newRes(n: i64): Res {
    made.add(1)
    return Res { id: n }
}

fn useRes(r: Res): i64 {
    return r.id
}

fn callIt(f: move () => i64): i64 {
    return f()
}

fn makeClosure(n: i64): move () => i64 {
    let r = newRes(n)
    return move () => r.id
}

fn earlyOut(n: i64): i64 {
    let r = newRes(n)
    if r.id >= 0 {
        return 1
    }
    return 0
}
`;

// Each fragment is self-contained in a block so every value it creates is destroyed
// before main ends. `n` is a distinct id per fragment; ZERO ids are generated on
// purpose, since an all-zero value was exactly the case a value-sniffing drop check
// mistook for "already moved out".
const FRAGMENTS: ((n: number) => string)[] = [
  n => `        let a${n} = newRes(${n})\n        sink = sink + a${n}.id`,
  n => `        sink = sink + newRes(${n}).id`,
  n => `        sink = sink + newRes(${n}).get()`,
  n => `        sink = sink + useRes(newRes(${n}))`,
  n => `        let f${n} = move () => newRes(${n}).id\n        sink = sink + f${n}()`,
  n => `        let r${n} = newRes(${n})\n        let g${n} = move () => r${n}.id\n        sink = sink + g${n}()`,
  n => `        let r${n} = newRes(${n})\n        let h${n} = move () => r${n}.id`,
  n => `        let r${n} = newRes(${n})\n        let k${n} = move () => useRes(r${n})\n        sink = sink + k${n}()`,
  n => `        let r${n} = newRes(${n})\n        sink = sink + callIt(move () => r${n}.id)`,
  n => `        let c${n} = makeClosure(${n})\n        sink = sink + c${n}()`,
  n => `        let r${n} = newRes(${n})\n        let o${n} = move () => {\n            let i${n} = move () => r${n}.id\n            return i${n}()\n        }\n        sink = sink + o${n}()`,
  n => `        var v${n}: Vec<Res> = Vec.new()\n        v${n}.push(newRes(${n}))\n        v${n}.push(newRes(${n}))\n        sink = sink + v${n}.len()`,
  n => `        var m${n}: HashMap<i64, Res> = HashMap.new()\n        m${n}.insert(1, newRes(${n}))\n        m${n}.insert(2, newRes(${n}))\n        sink = sink + m${n}.len()`,
  n => `        let w${n} = Wrap { inner: newRes(${n}) }\n        sink = sink + w${n}.inner.id`,
  n => `        var o${n}: Option<Res> = Option.Some(newRes(${n}))\n        if o${n}.isSome() {\n            sink = sink + 1\n        }`,
  n => `        sink = sink + earlyOut(${n})`,
  n => `        var i${n}: i64 = 0\n        while i${n} < 3 {\n            let r${n} = newRes(${n})\n            let f${n} = move () => r${n}.id\n            sink = sink + f${n}()\n            i${n} = i${n} + 1\n        }`,
  n => `        var i${n}: i64 = 0\n        while i${n} < 5 {\n            let r${n} = newRes(${n})\n            if i${n} == 2 {\n                break\n            }\n            i${n} = i${n} + 1\n        }`,
  n => `        var r${n} = newRes(${n})\n        r${n} = newRes(${n})\n        sink = sink + r${n}.id`,
  n => `        var v${n}: Vec<Res> = Vec.new()\n        v${n}.push(newRes(${n}))\n        v${n}[0] = newRes(${n})\n        sink = sink + v${n}.len()`,
  n => `        var o${n}: Option<Res> = Option.Some(newRes(${n}))\n        match o${n} {\n            Option.Some(r${n}) => {\n                sink = sink + r${n}.id\n            }\n            Option.None => {\n                sink = sink + 0\n            }\n        }`,
  n => `        var v${n}: Vec<Res> = Vec.new()\n        v${n}.push(newRes(${n}))\n        v${n}.push(newRes(${n}))\n        for e${n} in v${n} {\n            sink = sink + e${n}.id\n        }`,
  n => `        let r${n} = newRes(${n})\n        var fs${n}: Vec<move () => i64> = Vec.new()\n        fs${n}.push(move () => r${n}.id)\n        sink = sink + fs${n}.len()`,
  n => `        let r${n} = newRes(${n})\n        let t${n} = Task.spawn(move () => {\n            sink2 = sink2 + r${n}.id\n        })\n        t${n}.join()`,
  n => `        let r${n} = newRes(${n})\n        let p${n} = Promise.blocking(move () => r${n}.id)\n        sink = sink + p${n}.await()!`,
  n => `        var w${n}: Vec<Wrap> = Vec.new()\n        w${n}.push(Wrap { inner: newRes(${n}) })\n        sink = sink + w${n}.len()`,
];

function program(rand: () => number): string {
  const count = 2 + Math.floor(rand() * 4);
  const body: string[] = [];
  for (let i = 0; i < count; i++) {
    const frag = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]!;
    // ids are deliberately small and often zero
    body.push(`    if true {\n${frag(Math.floor(rand() * 3))}\n    }`);
  }
  return `${PRELUDE}
fn main(): void {
    var sink: i64 = 0
${body.join("\n")}
    print(sink)
    print(made.load())
    print(gone.load())
}
`;
}

const dir = mkdtempSync(join(tmpdir(), "milo-fuzz-drops-"));
const rand = rng(SEED);
let checked = 0, buildFails = 0;
const failures: { case: number; made: string; gone: string; src: string }[] = [];

for (let c = 0; c < CASES; c++) {
  const src = program(rand);
  const file = join(dir, `case${c}.milo`);
  writeFileSync(file, src);
  const bin = join(dir, `case${c}`);
  try {
    execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", file, "-o", bin,
      ...(SANITIZE ? ["--sanitize"] : [])], { cwd: ROOT, stdio: "pipe", timeout: 120000 });
  } catch {
    buildFails++;
    continue;
  }
  let out = "";
  try {
    out = execFileSync(bin, [], { encoding: "utf-8", stdio: "pipe", timeout: 60000,
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" } });
  } catch (e: any) {
    out = (e.stdout ?? "") + "\n<crashed>";
  }
  const lines = out.trim().split("\n");
  const made = lines[lines.length - 2] ?? "?";
  const gone = lines[lines.length - 1] ?? "?";
  checked++;
  if (made !== gone || made === "?") {
    failures.push({ case: c, made, gone, src });
    writeFileSync(join(ROOT, `.fuzz-drops-case${c}.milo`), src);
  }
}

// A generator whose programs all fail to build would otherwise report a clean sweep.
// The number that matters is how many were CHECKED, not how many were requested.
console.log(`seed ${SEED}, ${CASES} cases: ${checked} ran, ${buildFails} could not build`);
if (checked < CASES / 2) {
  console.error(`only ${checked}/${CASES} programs built — the generator is producing invalid Milo, not evidence`);
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
if (failures.length > 0) {
  for (const f of failures.slice(0, 5)) {
    console.error(`case ${f.case}: constructed ${f.made}, destroyed ${f.gone} — written to .fuzz-drops-case${f.case}.milo`);
  }
  console.error(`${failures.length}/${checked} programs did not balance`);
  process.exit(1);
}
console.log(`every value constructed was destroyed exactly once, across ${checked} programs`);
if (!KEEP) rmSync(dir, { recursive: true, force: true });
