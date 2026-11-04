// The process scaffold around the program's functions, as an LLVM-dialect module
// (`milo.scaffold`, folded into the program by milo-opt's milo-merge-scaffold):
//   - the process entry: argc/argv, record/replay start, stdout line buffering, the hash
//     seed's mode, global init, and `main` itself when main runs as a green task;
//   - the panic routines the lowering calls (bounds, overflow, contract, message), with the
//     panic hook and abort tail;
//   - stdout/stderr writes of a string, the hash seed source;
//   - the lazy-global machinery (src/lazy-globals.ts places the guards);
//   - a shim per extern passing a struct by value, which does the C ABI's coercion.
// Everything is defined on demand (src/mlir-llvm.ts): milo-opt deletes what nothing uses.
import type { FnDecl } from "./backend-program";
import { LlvmModule, type LlvmFn, type LVal, type LTy, type Callee, type ArgAttrs, I1, I8, I32, I64, PTR } from "./mlir-llvm";
import type { ModuleCtx } from "./mlir-ctx";
import { processGlobalNames } from "./mlir-ctx";
import { GLOBAL_INIT_FN, GREEN_RUN_MAIN_FN, MAIN_BODY_FN, PROCESS_INIT_FN } from "./startup";
import { LAZY_GUARD_PREFIX, LAZY_INIT_PREFIX } from "./lazy-globals";
import { display } from "./mangle";

export const HASH_SEED_FN = "__milo_hash_seed";

const MAIN_TASK_FN = "__milo_main_task";
const MAIN_EXIT_GLOBAL = "_milo_main_exit";
const LINE_BUF_INIT_FN = "__milo_line_buffer_init";
const RR_HASH_INIT_FN = "__milo_rr_hash_init";
const RR_HASH_SEED_GLOBAL = "__milo_rr_hseed";

// The bounds-check message: its `%lld`s take the index and length.
const BOUNDS_ERR_MSG = "milo: array index out of bounds: %lld/%lld at %s:%d\n";
const PANIC_FN = ["noreturn", "cold", "noinline"];
const STRING_REF: ArgAttrs = ["llvm.nonnull", "llvm.dereferenceable = 24 : i64", "llvm.align = 8 : i64"];

export interface ScaffoldFacts {
  /** Some body calls the hash seed source (a HashMap is built). */
  hashSeed: boolean;
}

export function scaffoldModule(cx: ModuleCtx, facts: ScaffoldFacts): string {
  const s = new Scaffold(cx, facts);
  s.build();
  return s.m.text();
}

class Scaffold {
  readonly m: LlvmModule;
  private readonly os: string;
  private readonly windows: boolean;
  // Freestanding: no libc, no fds; one output sink (the embedded runtime's printf).
  private readonly none: boolean;
  // Bare metal and wasm run one thread: plain loads and stores, no thread-local storage.
  private readonly bare: boolean;

  constructor(private readonly cx: ModuleCtx, private readonly facts: ScaffoldFacts) {
    this.m = new LlvmModule();
    this.os = cx.target.os;
    this.windows = this.os === "windows";
    this.none = this.os === "none";
    this.bare = !!cx.target.bareMetal;
  }

  build(): void {
    const g = processGlobalNames;
    this.m.global(g.argc, I32);
    this.m.global(g.argv, PTR);
    // thread_local: each OS thread gets its own scheduler slot, so a pthread never observes
    // the main thread's scheduler and misreads green context.
    this.m.global(g.scheduler, PTR, { threadLocal: true });
    this.m.global(g.panicHook, PTR, { threadLocal: true });
    this.processInit();
    if (this.cx.plan.greenMain) this.greenMain();
    this.panicRoutines();
    this.writes();
    this.hashSeed();
    if (this.cx.plan.lazyGlobals.size > 0) this.lazyGlobals();
    for (const name of this.cx.cAbiShims) this.cAbiShim(name);
  }

  // ── externals ──

  /** A Milo function the scaffold calls, declared with the type its definition lowers to. */
  private milo(name: string): Callee {
    const sig = this.cx.fnSigs.get(name);
    if (!sig) throw new Error(`scaffold: no signature for ${name}`);
    return this.m.extern(name, sig.paramTypes.map(t => this.cx.dialectType(t)!), this.cx.dialectType(sig.retType));
  }
  private libc(name: string, params: LTy[], ret: LTy | null, variadic = false, passthrough?: string[]): Callee {
    return this.m.extern(name, params, ret, { variadic, passthrough });
  }
  private get stdoutSymbol(): string { return this.os === "darwin" ? "__stdoutp" : "stdout"; }
  private get stderrSymbol(): string { return this.os === "darwin" ? "__stderrp" : "stderr"; }
  // MSVC's stdio streams are not data symbols: `stdout` is the macro `__acrt_iob_func(1)`.
  private stream(f: LlvmFn, fd: 1 | 2): LVal {
    if (this.windows) return f.call(this.libc("__acrt_iob_func", [I32], PTR), [f.int(I32, fd)])!;
    const sym = fd === 1 ? this.stdoutSymbol : this.stderrSymbol;
    this.m.externGlobal(sym, PTR);
    return f.load(PTR, f.addr(sym));
  }

  // dprintf(fd, fmt, ...) has no UCRT equivalent, so Windows writes through fprintf onto the
  // stream. Freestanding targets have one output sink, whatever printf the embedded runtime
  // provides; `nobuiltin` keeps LLVM from turning a constant message into a puts call, which
  // the embedded runtime does not have.
  private fdPrintf(f: LlvmFn, fd: 1 | 2, fmt: LVal, args: LVal[]): void {
    if (this.none) { f.call(this.libc("printf", [PTR], I32, true), [fmt, ...args], { nobuiltin: true }); return; }
    if (this.windows) { f.call(this.libc("fprintf", [PTR, PTR], I32, true), [this.stream(f, fd), fmt, ...args]); return; }
    f.call(this.libc("dprintf", [I32, PTR], I32, true), [f.int(I32, fd), fmt, ...args]);
  }

  // Byte-exact write of `n` bytes at `d` to a fd. MSVC's _write is LLP64: its count is an
  // unsigned int, so the length is truncated (as the C call itself would).
  private fdWrite(f: LlvmFn, fd: number, d: LVal, n: LVal): void {
    if (this.windows) f.call(this.libc("_write", [I32, PTR, I32], I32), [f.int(I32, fd), d, f.trunc(n, I32)]);
    else f.call(this.libc("write", [I32, PTR, I64], I64), [f.int(I32, fd), d, n]);
  }

  // Through stdio's buffer: fwrite is length-counted, so it is as NUL-correct as write(), and
  // it shares stdout's buffer with printf, so nothing is left to order by hand. Buffering is
  // C's: line-buffered on a TTY, block-buffered on a pipe, drained by exit() and by the
  // explicit fflush in the panic tail. stderr is unbuffered, so a string written this way
  // and dprintf calls around it reach fd 2 in program order.
  private streamWrite(f: LlvmFn, fd: 1 | 2, d: LVal, n: LVal): void {
    f.call(this.libc("fwrite", [PTR, I64, I64, PTR], I64), [d, f.int(I64, 1), n, this.stream(f, fd)]);
  }

  // A panic terminates via abort() (SIGABRT), not exit(1): a supervisor can tell an abnormal
  // exit from an ordinary error, the OS can drop a core dump, and lldb/gdb break at the
  // fault. The caller ends the block with `unreachable`.
  private panicTail(f: LlvmFn): void {
    // Freestanding: no abort()/fflush(); the embedded runtime's exit (semihosting SYS_EXIT).
    if (this.none) { f.call(this.libc("exit", [I32], null, false, ["noreturn"]), [f.int(I32, 1)]); return; }
    // A panic inside a lazy global's initializer names the global, and ends the process even
    // on a green task: retiring just the task would leave the global marked as being
    // initialized, and every later reader would wait for it forever.
    if (this.cx.plan.lazyGlobals.size > 0) f.call(this.m.callee("__milo_lazy_panic_note"), []);
    // abort() does not flush stdio, and the message may sit in a block-buffered stdout.
    f.call(this.libc("fflush", [PTR], I32), [f.null()]);
    // The panic hook (std/runtime sets it when a scheduler starts) retires the panicking
    // green task and never returns, so one task's panic costs that task, not the process.
    // It returns when there is no task to retire, and the panic aborts as before.
    const hook = f.load(PTR, f.addr(processGlobalNames.panicHook));
    const noHook = f.icmp("eq", hook, f.null());
    const call = f.block("panic.hook"), abort = f.block("panic.abort");
    f.condBr(noHook, abort, call);
    f.at(call);
    f.callPtr(hook, [], null);
    f.br(abort);
    f.at(abort);
    f.call(this.libc("abort", [], null, false, ["noreturn"]), []);
  }

  // ── the process entry ──

  // What runs on the OS stack before main's body: argc/argv first (a global initializer may
  // read them), then record/replay's start (under MILO_RECORD or MILO_REPLAY it restarts the
  // process with ASLR off and turns the fixed-address heap on, so initializers' allocations
  // already land where they will on replay), stdout's buffering and the hash seed's mode
  // (an initializer may print, or build a HashMap), then global init.
  private processInit(): void {
    const f = this.m.fn(PROCESS_INIT_FN, [{ ty: I32 }, { ty: PTR }], null);
    const [argc, argv] = f.params;
    f.store(argc, f.addr(processGlobalNames.argc));
    f.store(argv, f.addr(processGlobalNames.argv));
    if (!this.none) {
      if (this.cx.fnSigs.has("miloReplayStart")) f.call(this.milo("miloReplayStart"), [argv]);
      this.lineBufferInit();
      f.call(this.m.callee(LINE_BUF_INIT_FN), []);
      this.rrHashInit();
      f.call(this.m.callee(RR_HASH_INIT_FN), []);
    }
    if (this.cx.plan.initFns.some(i => i.name === GLOBAL_INIT_FN)) f.call(this.m.extern(GLOBAL_INIT_FN, [], null), []);
    f.ret();
    f.done();
  }

  // The real `main` when main runs as a green task: the entry-point work that must happen on
  // the OS stack, then the body handed to the scheduler, and whatever exit code it produced.
  private greenMain(): void {
    this.m.global(MAIN_EXIT_GLOBAL, I32);
    // spawnWithStack calls the task through the closure ABI, which passes an env pointer.
    const t = this.m.fn(MAIN_TASK_FN, [{ ty: PTR }], null);
    t.store(t.call(this.m.extern(MAIN_BODY_FN, [], I32), [])!, t.addr(MAIN_EXIT_GLOBAL));
    t.ret();
    t.done();
    const f = this.m.fn("main", [{ ty: I32 }, { ty: PTR }], I32, { external: true });
    f.call(this.m.callee(PROCESS_INIT_FN), f.params);
    f.call(this.milo(GREEN_RUN_MAIN_FN), [f.addr(MAIN_TASK_FN)]);
    f.ret(f.load(I32, f.addr(MAIN_EXIT_GLOBAL)));
    f.done();
  }

  // A SIGKILL cannot flush stdio, so a program killed by a watchdog (scripts/guard.ts, a CI
  // timeout) with a piped stdout loses every line it printed, precisely where that output is
  // the only evidence of where it hung. Block buffering on a pipe is still the right default
  // for throughput, so line buffering is opt-in and belongs to whoever might do the killing:
  // MILO_LINE_BUFFERED pays a write per line to get output up to the hang.
  //
  // Its own function: the call is skipped, not made harmless, when the variable is unset.
  // There is no no-op setvbuf: MSVC's validates size > 0 for _IOFBF/_IOLBF and routes a 0 to
  // the invalid-parameter handler, which terminates the process (a branchless select between
  // _IONBF and _IOFBF killed every Windows binary at startup).
  private lineBufferInit(): void {
    const f = this.m.fn(LINE_BUF_INIT_FN, [], null);
    const env = f.call(this.libc("getenv", [PTR], PTR), [f.addr(this.m.str("MILO_LINE_BUFFERED"))])!;
    const set = f.block("linebuf.set"), done = f.block("linebuf.done");
    f.condBr(f.icmp("ne", env, f.null()), set, done);
    f.at(set);
    // MSVC maps _IOLBF onto _IOFBF, so line buffering there does nothing; _IONBF (4) is the
    // mode that reaches the fd per write.
    f.call(this.libc("setvbuf", [PTR, PTR, I32, I64], I32), [this.stream(f, 1), f.null(), f.int(I32, this.windows ? 4 : 1), f.int(I64, 0)]);
    f.br(done);
    f.at(done);
    f.ret();
    f.done();
  }

  // HashMap seeds are entropy, and they decide iteration order, which a program can print.
  // Under record/replay (MILO_RECORD / MILO_REPLAY, std/replay) seeds come from a fixed
  // sequence instead, so a recorded run and its replay iterate every map the same way
  // without a trace record per map. Decided at process start: std/replay removes both
  // variables from the environment once it has read them (so child processes do not write
  // into the parent's trace).
  private rrHashInit(): void {
    const f = this.m.fn(RR_HASH_INIT_FN, [], null);
    // A program with no HashMap has no seed to fix; its startup stays a bare call.
    if (this.facts.hashSeed) {
      const det = f.block("rr.det"), done = f.block("rr.done");
      // Set and non-empty, matching std/replay, which treats an empty value as unset.
      const vars = ["MILO_RECORD", "MILO_REPLAY"];
      vars.forEach((name, i) => {
        const next = i + 1 < vars.length ? f.block(`rr.check${i + 1}`) : done;
        const v = f.call(this.libc("getenv", [PTR], PTR), [f.addr(this.m.str(name))])!;
        const byte = f.block(`rr.byte${i}`);
        f.condBr(f.icmp("eq", v, f.null()), next, byte);
        f.at(byte);
        f.condBr(f.icmp("eq", f.load(I8, v), f.int(I8, 0)), next, det);
        if (next !== done) f.at(next);
      });
      f.at(det);
      // Any nonzero start works; this one spells "milorr".
      f.store(f.int(I64, 120364506550898n), f.addr(this.m.global(RR_HASH_SEED_GLOBAL, I64)));
      f.br(done);
      f.at(done);
    }
    f.ret();
    f.done();
  }

  // std/hashmap's insert calls this through _mapSeed on a map's first insert.
  private hashSeed(): void {
    const seed = this.m.global(RR_HASH_SEED_GLOBAL, I64);
    const f = this.m.fn(HASH_SEED_FN, [], I64);
    const buf = f.alloca(I64, 8);
    const det = f.block("seed.det"), os = f.block("seed.os");
    f.condBr(f.icmp("ne", f.load(I64, f.addr(seed)), f.int(I64, 0)), det, os);
    f.at(det);
    // Golden-ratio step (0x9E3779B97F4A7C15): consecutive maps get well-spread seeds. Atomic
    // because maps can be built on Promise.blocking threads too; the sequence is only
    // reproducible for maps built in a reproducible order, which is the main thread's.
    const step = f.int(I64, -7046029254386353131n);
    f.ret(f.bin("add", f.atomicAdd(f.addr(seed), step), step));
    f.at(os);
    // 2 = BCRYPT_USE_SYSTEM_PREFERRED_RNG, which is what permits the NULL algorithm handle;
    // the length is a 32-bit ULONG here, not getentropy's size_t. Returns an NTSTATUS.
    if (this.windows) f.call(this.libc("BCryptGenRandom", [PTR, PTR, I32, I32], I32), [f.null(), buf, f.int(I32, 8), f.int(I32, 2)]);
    else f.call(this.libc("getentropy", [PTR, I64], I32), [buf, f.int(I64, 8)]);
    f.ret(f.load(I64, buf));
    f.done();
  }

  // ── panics and writes ──

  private panicRoutines(): void {
    const routine = (name: string, params: LTy[], fmt: (f: LlvmFn) => LVal, args: (f: LlvmFn) => LVal[]) => {
      const f = this.m.fn(name, params.map(ty => ({ ty })), null, { passthrough: PANIC_FN });
      this.fdPrintf(f, 2, fmt(f), args(f));
      this.panicTail(f);
      f.unreachable();
      f.done();
    };
    if (this.cx.plan.lazyGlobals.size > 0) this.lazyPanicNote();
    // The message is the whole format (a milo.panic_if); up to three `%lld` values follow it
    // and printf ignores the slots it does not name.
    routine("__milo_mlir_panic", [PTR], f => f.params[0], () => []);
    routine("__milo_mlir_panic_v3", [PTR, I64, I64, I64], f => f.params[0], f => f.params.slice(1));
    routine("__milo_bounds_fail", [I64, I64, PTR, I32], f => f.addr(this.m.str(BOUNDS_ERR_MSG)), f => f.params);
    routine("__milo_overflow_fail", [PTR, I32], f => f.addr(this.m.str("runtime error: integer overflow at %s:%d\n")), f => f.params);
    routine("__milo_contract_fail", [PTR, PTR, I32], f => f.addr(this.m.str("runtime error: %s clause violated at %s:%d\n")), f => f.params);
    // milo.panic.text(s): the whole message, a string, written by length; never returns.
    const f = this.m.fn("milo.panic.text", [{ ty: PTR, attrs: STRING_REF }], null, { passthrough: PANIC_FN });
    const [s] = f.params;
    const d = f.load(PTR, s), n = f.load(I64, f.offset(s, 8));
    if (this.none) this.fdWrite(f, 2, d, n);
    else this.streamWrite(f, 2, d, n);
    this.panicTail(f);
    f.unreachable();
    f.done();
  }

  // milo.out.write(s) / milo.err.write(s): the string's bytes to stdout or stderr, then its
  // buffer freed: the string is print's scratch, held by nobody else.
  private writes(): void {
    for (const stderr of [false, true]) {
      const f = this.m.fn(stderr ? "milo.err.write" : "milo.out.write", [{ ty: PTR, attrs: STRING_REF }], null);
      const [s] = f.params;
      const d = f.load(PTR, s), n = f.load(I64, f.offset(s, 8)), c = f.load(I64, f.offset(s, 16));
      if (this.none) {
        // By length, so a NUL in the text is written too; a C int's worth at a time is plenty.
        f.call(this.libc("printf", [PTR], I32, true), [f.addr(this.m.str("%.*s")), f.trunc(n, I32), d], { nobuiltin: true });
      } else this.streamWrite(f, stderr ? 2 : 1, d, n);
      const free = f.block("free"), done = f.block("done");
      f.condBr(f.icmp("sgt", c, f.int(I64, 0)), free, done);
      f.at(free);
      f.call(this.m.extern("rtStrFree", [PTR], null), [d]);
      f.br(done);
      f.at(done);
      f.ret();
      f.done();
    }
  }

  // ── lazy globals ──
  //
  // Per global G: a state word (0 not started, 1 initializer running, 2 done), the token of
  // whoever is running the initializer, and `__milo.lazy.G`, the guard every read goes
  // through: one acquire load and a branch once G is initialized, which is the whole cost of
  // laziness on the hot path. The first reader wins a compare-and-swap, runs
  // `__milo.lazyinit.G` and publishes with a release store; a reader that loses waits.
  //
  // The token tells "another task or thread is initializing G" (wait for it) from "this task
  // is, and has come back round to G" (an initialization cycle: waiting would never end, so
  // it panics, naming G). It is the running green task when there is one, since two tasks
  // share an OS thread, and otherwise the address of a thread-local byte, which is distinct
  // per thread. Waiting yields to the scheduler on a green task, drives it on a main thread
  // that has one (the initializer may be a parked task), and yields the CPU on a plain
  // thread. Without std/runtime in the program there are no green tasks, and without threads
  // (a bare-metal target) a busy G can only be a cycle.
  //
  // A global declared `thread_local` gets thread-local state too: each thread initializes
  // its own copy on its own first read.
  private lazyGlobals(): void {
    const bare = this.bare;
    const tls = !bare;
    const has = (n: string) => this.cx.fns.get(n)?.isExtern === false;
    const green = !bare && has("schedulerCurrent") && has("schedulerYield") && has("schedulerExists") && has("schedulerPollMain");
    const tid = this.m.global("__milo_lazy_tid", I8, { threadLocal: tls });
    // What this thread is initializing, for the panic note. Values, not a list of frames:
    // green tasks interleave on one thread, so this can go stale, and a stale name pointer
    // is still a valid constant (the token check keeps it from misleading).
    const curName = this.m.global("__milo_lazy_cur_name", PTR, { threadLocal: tls });
    const curTok = this.m.global("__milo_lazy_cur_tok", I64, { threadLocal: tls });
    const slowParams = [PTR, PTR, PTR, PTR, PTR];
    const slow = this.m.extern("__milo_lazy_slow", slowParams, null);
    for (const [name, g] of this.cx.plan.lazyGlobals) {
      const gtls = !!g.threadLocal && !bare;
      const st = this.m.global(`${name}.lazy`, I64, { threadLocal: gtls });
      const own = this.m.global(`${name}.lazyown`, I64, { threadLocal: gtls });
      const thr = this.m.global(`${name}.lazythr`, I64, { threadLocal: gtls });
      const init = this.m.extern(`${LAZY_INIT_PREFIX}${name}`, [], null);
      const f = this.m.fn(`${LAZY_GUARD_PREFIX}${name}`, [], null);
      const s = f.load(I64, f.addr(st), bare ? { align: 8 } : { align: 8, atomic: "acquire" });
      const slowB = f.block("slow"), done = f.block("done");
      f.condBr(f.icmp("eq", s, f.int(I64, 2)), done, slowB);
      f.at(slowB);
      f.call(slow, [f.addr(st), f.addr(own), f.addr(thr), f.addr(this.m.str(display(this.cx.displayNames, name))), f.addr(init.name)]);
      f.br(done);
      f.at(done);
      f.ret();
      f.done();
    }

    const sched = (n: string) => this.milo(n);
    const thread = this.m.fn("__milo_lazy_thread", [], I64);
    thread.ret(thread.bin("or", thread.ptrToInt(thread.addr(tid)), thread.int(I64, 1)));
    thread.done();
    const token = this.m.fn("__milo_lazy_token", [], I64);
    if (green) {
      const t = token.call(sched("schedulerCurrent"), [])!;
      const threadB = token.block("thread"), task = token.block("task");
      token.condBr(token.icmp("eq", t, token.null()), threadB, task);
      token.at(task);
      token.ret(token.ptrToInt(t));
      token.at(threadB);
    }
    token.ret(token.call(this.m.callee("__milo_lazy_thread"), []));
    token.done();

    // Waiting for an initializer another task on THIS thread is running: that task is parked
    // (it could not have let us run otherwise), so this one has to let the scheduler run, by
    // yielding from a task or by driving it from the main thread. The checker charges that
    // park to the read, because the initializer itself parks. An initializer on ANOTHER
    // thread needs nothing from this one, so that wait only yields the CPU and never lets
    // another green task in: a read of a global whose initializer does not park must never park.
    if (!bare) {
      const w = this.m.fn("__milo_lazy_wait", [{ ty: I1 }], null);
      const schedB = w.block("sched"), osB = w.block("os");
      w.condBr(w.params[0], schedB, osB);
      w.at(schedB);
      if (green) {
        const t = w.call(sched("schedulerCurrent"), [])!;
        const notTask = w.block("nottask"), task = w.block("task"), drive = w.block("drive");
        w.condBr(w.icmp("eq", t, w.null()), notTask, task);
        w.at(task);
        w.call(sched("schedulerYield"), []);
        w.ret();
        w.at(notTask);
        w.condBr(w.call(sched("schedulerExists"), [])!, drive, osB);
        w.at(drive);
        w.call(sched("schedulerPollMain"), []);
        w.ret();
      } else {
        w.br(osB);
      }
      w.at(osB);
      if (!this.windows) w.call(this.libc("sched_yield", [], I32), []);
      w.ret();
      w.done();
    }

    const f = this.m.fn("__milo_lazy_slow", slowParams.map(ty => ({ ty })), null, { passthrough: ["noinline"] });
    const [st, own, thr, nm, init] = f.params;
    const tok = f.call(this.m.callee("__milo_lazy_token"), [])!;
    const me = f.call(this.m.callee("__milo_lazy_thread"), [])!;
    const tryB = f.block("try"), run = f.block("run"), lost = f.block("lost"), out = f.block("out"), cycle = f.block("cycle"), by = f.block("by"), die = f.block("die");
    f.br(tryB);
    f.at(tryB);
    let old: LVal;
    if (bare) {
      old = f.load(I64, st, { align: 8 });
      const claim = f.block("claim");
      f.condBr(f.icmp("eq", old, f.int(I64, 0)), claim, lost);
      f.at(claim);
      f.store(f.int(I64, 1), st, { align: 8 });
      f.br(run);
    } else {
      const r = f.cmpxchg(st, f.int(I64, 0), f.int(I64, 1), 8);
      old = r.old;
      f.condBr(r.won, run, lost);
    }
    f.at(run);
    const rel = bare ? { align: 8 } : { align: 8, atomic: "release" as const };
    f.store(tok, own, rel);
    f.store(me, thr, rel);
    const pn = f.load(PTR, f.addr(curName)), pt = f.load(I64, f.addr(curTok));
    f.store(nm, f.addr(curName));
    f.store(tok, f.addr(curTok));
    f.callPtr(init, [], null);
    f.store(pn, f.addr(curName));
    f.store(pt, f.addr(curTok));
    f.store(f.int(I64, 2), st, rel);
    f.ret();
    f.at(lost);
    // On a target with no threads and no scheduler, nobody else can be running it.
    const busy = bare ? cycle : f.block("busy");
    f.condBr(f.icmp("eq", old, f.int(I64, 2)), out, busy);
    if (!bare) {
      const wait = f.block("wait");
      f.at(busy);
      const o = f.load(I64, own, { align: 8, atomic: "acquire" });
      f.condBr(f.icmp("eq", o, tok), cycle, wait);
      f.at(wait);
      const ot = f.load(I64, thr, { align: 8, atomic: "acquire" });
      f.call(this.m.callee("__milo_lazy_wait"), [f.icmp("eq", ot, me)]);
      f.br(tryB);
    }
    f.at(cycle);
    this.fdPrintf(f, 2, f.addr(this.m.str("error: initialization cycle: global '%s' is read while its own initializer is running\n")), [nm]);
    const cn = f.load(PTR, f.addr(curName)), ct = f.load(I64, f.addr(curTok));
    const c1 = f.bin("and", f.icmp("ne", cn, f.null()), f.icmp("eq", ct, tok));
    f.condBr(f.bin("and", c1, f.icmp("ne", cn, nm)), by, die);
    f.at(by);
    this.fdPrintf(f, 2, f.addr(this.m.str("  (read by the initializer of '%s')\n")), [cn]);
    f.br(die);
    f.at(die);
    // The note would repeat what was just said.
    f.store(f.null(), f.addr(curName));
    this.panicTail(f);
    f.unreachable();
    f.at(out);
    f.ret();
    f.done();
  }

  private lazyPanicNote(): void {
    const curName = this.m.global("__milo_lazy_cur_name", PTR, { threadLocal: !this.bare });
    const curTok = this.m.global("__milo_lazy_cur_tok", I64, { threadLocal: !this.bare });
    this.m.extern("__milo_lazy_token", [], I64);
    const f = this.m.fn("__milo_lazy_panic_note", [], null);
    const cn = f.load(PTR, f.addr(curName));
    const check = f.block("check"), note = f.block("note"), out = f.block("out");
    f.condBr(f.icmp("ne", cn, f.null()), check, out);
    f.at(check);
    const same = f.icmp("eq", f.load(I64, f.addr(curTok)), f.call(this.m.callee("__milo_lazy_token"), [])!);
    f.condBr(same, note, out);
    f.at(note);
    this.fdPrintf(f, 2, f.addr(this.m.str("note: this panic happened while initializing global '%s' (it is initialized on first read)\n")), [cn]);
    if (!this.none) {
      f.call(this.libc("fflush", [PTR], I32), [f.null()]);
      f.call(this.libc("abort", [], null, false, ["noreturn"]), []);
    } else {
      f.call(this.libc("exit", [I32], null, false, ["noreturn"]), [f.int(I32, 1)]);
    }
    f.unreachable();
    f.at(out);
    f.ret();
    f.done();
  }

  // ── the C ABI of a struct by value ──

  // `milo.cabi.<f>` takes extern f's arguments as Milo passes them (a struct by value as its
  // %T) and calls f across the C ABI: a struct coerced into registers is staged in an i64
  // array at least its size (so the register loads stay in bounds), one passed indirectly is
  // a private copy (byval on SysV), and an sret result is a caller buffer. The byval/sret
  // attributes go on the declaration and the call alike: on x86_64 one present on only one
  // side silently miscompiles.
  private cAbiShim(name: string): void {
    const cx = this.cx;
    const abi = cx.externAbi.get(name)!;
    const sig = cx.fnSigs.get(name)!;
    const fn = cx.fns.get(name) as FnDecl;
    const ty = (t: string) => cx.dialectType(t)!;
    const align = (t: string) => cx.layout.typeAlign(t);
    const params: LTy[] = [], attrs: (ArgAttrs | null)[] = [];
    let ret: LTy | null = cx.dialectType(sig.retType);
    if (abi.ret.kind === "sret") {
      params.push(PTR);
      attrs.push([`llvm.sret = ${ty(`%${abi.ret.name}`)}`, `llvm.align = ${abi.ret.align} : i64`]);
      ret = null;
    } else if (abi.ret.kind === "coerce") ret = ty(abi.ret.retTy);
    sig.paramTypes.forEach((t, i) => {
      const c = abi.args[i];
      if (!c || c.kind === "direct") { params.push(ty(t)); attrs.push(null); return; }
      if (c.kind === "coerce") { for (const r of c.regs) { params.push(ty(r.ty)); attrs.push(null); } return; }
      params.push(PTR);
      attrs.push(c.byval ? [`llvm.byval = ${ty(`%${c.name}`)}`, `llvm.align = ${c.align} : i64`] : null);
    });
    const callee = this.m.extern(fn.linkName ?? name, params, ret, { variadic: fn.isVariadic, paramAttrs: attrs });
    const f = this.m.fn(`milo.cabi.${name}`, sig.paramTypes.map(t => ({ ty: ty(t) })), cx.dialectType(sig.retType));
    const args: LVal[] = [];
    let sret: LVal | null = null;
    if (abi.ret.kind === "sret") args.push(sret = f.alloca(ty(`%${abi.ret.name}`), align(`%${abi.ret.name}`)));
    sig.paramTypes.forEach((_t, i) => {
      const c = abi.args[i];
      const a = f.params[i];
      if (!c || c.kind === "direct") { args.push(a); return; }
      if (c.kind === "coerce") {
        const buf = f.alloca(`!llvm.array<${c.container / 8} x i64>`, 8);
        f.store(a, buf);
        for (const r of c.regs) args.push(f.load(ty(r.ty), f.offset(buf, r.offset)));
        return;
      }
      const buf = f.alloca(ty(`%${c.name}`), align(`%${c.name}`));
      f.store(a, buf);
      args.push(buf);
    });
    const r = f.call(callee, args, { argAttrs: attrs });
    if (sret) f.ret(f.load(ty(sig.retType), sret));
    else if (abi.ret.kind === "coerce") {
      const buf = f.alloca(`!llvm.array<${abi.ret.container / 8} x i64>`, 8);
      f.store(r!, buf);
      f.ret(f.load(ty(sig.retType), buf));
    } else f.ret(r);
    f.done();
  }
}
