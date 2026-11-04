// What runs before and around `main`: which module globals are filled at startup or on first
// read (the init functions the build compiles like any other), and whether main runs on a
// green task of its own. src/scaffold.ts emits the entry point and the lazy-global
// machinery from this plan.
import type { BackendProgram, FnDecl, GlobalDecl } from "./backend-program";
import type { TargetInfo } from "./target";
import { isFullyConstInit } from "./const-fold";
import { lazyMentions, LAZY_INIT_PREFIX } from "./lazy-globals";
import type { Layout } from "./layout";
import { directCallee, walkAst } from "./emit-forms";

// `.` can't appear in a Milo identifier, so this never collides with a user function.
export const GLOBAL_INIT_FN = "__milo.global_init";
// main's own body, once the entry point becomes the wrapper that runs it on a green task.
export const MAIN_BODY_FN = "__milo_main_body";
// What main calls first (src/scaffold.ts): argc/argv, stdio, record/replay, global init.
export const PROCESS_INIT_FN = "__milo_process_init";
export const GREEN_SPAWN_FN = "Task$spawnWithStack";
export const GREEN_RUN_MAIN_FN = "schedulerRunMainRaw";

export interface StartupPlan {
  /** The init functions to compile: one per lazy global, then GLOBAL_INIT_FN if any global is filled at startup. */
  initFns: FnDecl[];
  /** Globals filled on first read, by `__milo.lazyinit.<G>` behind the guard `__milo.lazy.<G>`. */
  lazyGlobals: Map<string, GlobalDecl>;
  /** Runtime-initialized globals nothing reads, filled before main by GLOBAL_INIT_FN. */
  startupGlobals: string[];
  /** main runs as a green task (schedulerRunMainRaw) behind a wrapper entry point. */
  greenMain: boolean;
}

// A global whose initializer needs to run code (an arena, a populated Vec, a parsed table)
// is zeroed at load and filled on first read, by its own init function: lazy, so a program
// pays only for the globals it touches, and initializers run in the order reads need them
// rather than an order computed ahead of time. A constant initializer stays static with no
// guard at all.
//
// A global that nothing reads exists for what its initializer does (std/replay boots
// record/replay that way), so that initializer still runs before main, in `globals` order,
// which the checker sorted by dependency.
export function planStartup(module: BackendProgram, layout: Layout, target: TargetInfo): StartupPlan {
  const fx = module.facts;
  const functions = module.functions.filter(f => !f.isExtern);
  const runtimeInit = module.globals.filter(g => !isFullyConstInit(g, layout.structLayouts, fx));
  const lazy = new Set(runtimeInit.map(g => g.name));
  // The globals something reads: a mention anywhere in a body, a contract or another
  // global's initializer (the initializer's own `G = value` target is no read of G).
  const read = new Set<string>();
  for (const f of functions) {
    if (f.ast) lazyMentions([f.ast.body, f.ast.contracts.filter(c => c.kind === "requires" || c.kind === "ensures" || c.kind === "invariant")], lazy, read, true);
  }
  for (const g of runtimeInit) lazyMentions(g.value, lazy, read, true);
  const initFn = (name: string, inits: GlobalDecl[], sourceFile?: string): FnDecl => ({
    name, params: [], retType: { tag: "void" }, isExtern: false, isVariadic: false, inits, ...(sourceFile && { sourceFile }),
  });
  const lazyInit = runtimeInit.filter(g => read.has(g.name)).map(g => initFn(`${LAZY_INIT_PREFIX}${g.name}`, [g], g.sourceFile));
  const eager = runtimeInit.filter(g => !read.has(g.name));
  const startupFns = eager.length === 0 ? lazyInit : [...lazyInit, initFn(GLOBAL_INIT_FN, eager)];
  return {
    initFns: startupFns,
    lazyGlobals: new Map(runtimeInit.filter(g => read.has(g.name)).map(g => [g.name, g])),
    startupGlobals: eager.map(g => g.name),
    greenMain: mainCanSpawnGreenTasks(target, module, functions, startupFns),
  };
}

// Every blocking std call picks its strategy from `schedulerCurrent()`, and `main` was never
// a green task: that read returned 0 and the call blocked the single OS thread the
// cooperative scheduler runs on, starving the tasks that would have satisfied it. `accept`
// in `main` with the peer in a `Task.spawn` hung forever, with no error and no timeout.
//
// The fix is to leave the OS stack to the scheduler loop and run `main` on a task of its own
// (Go's g0/m0 split), which is what `schedulerRunMainRaw` does. Doing that unconditionally
// would pull the ucontext scheduler into every hello-world, and wasm/bare-metal have no
// stackful coroutines at all. So it happens only when the program can actually create a
// green task: `Task$spawnWithStack` reachable from `main` or from a global initializer.
//
// The walk over-approximates on purpose (any call in a reachable body is an edge, closures
// included), but it is not total: a spawn reached only through a function pointer would
// leave the program unwrapped, i.e. a hang, never a miscompile.
function mainCanSpawnGreenTasks(target: TargetInfo, module: BackendProgram, functions: FnDecl[], initFns: FnDecl[]): boolean {
  // wasm's makecontext is an abort stub and bare metal has no scheduler at all: a program
  // targeting them that spawns is already broken, and wrapping would break the ones that don't.
  if (target.os !== "darwin" && target.os !== "linux" && target.os !== "windows") return false;
  // A lazy global's initializer runs on whatever task first reads it, main's included, so
  // its init fn is a root as much as main is.
  const byName = new Map([...functions, ...initFns].map(f => [f.name, f]));
  if (!byName.has(GREEN_RUN_MAIN_FN)) return false;
  // The wrapper calls the body with no arguments.
  if ((byName.get("main")?.params.length ?? 0) > 0) return false;
  const seen = new Set<string>();
  const stack = ["main", ...initFns.map(f => f.name)];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === GREEN_SPAWN_FN) return true;
    const fn = byName.get(name);
    if (!fn) continue;
    const callees = module.callees.get(fn.name);
    walkAst(fn.ast ? fn.ast.body : (fn.inits ?? []).map(g => g.value), n => {
      const c = directCallee(module.facts, n as never, { ret: fn.retType });
      const to = c === null ? null : callees?.get(n as never) ?? c;
      if (to !== null && !seen.has(to)) stack.push(to);
    });
  }
  return false;
}
