// What runs before and around `main`, decided on the HIR: which module globals are filled
// at startup or on first read (the init functions the build compiles like any other), and
// whether main runs on a green task of its own. src/scaffold.ts emits the entry point and
// the lazy-global machinery from this plan.
import type { HIRFunction, HIRGlobal, HIRModule } from "./hir";
import type { TargetInfo } from "./target";
import { isFullyConstInit } from "./const-fold";
import { guardLazyGlobals, LAZY_INIT_PREFIX } from "./lazy-globals";
import type { Layout } from "./layout";

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
  initFns: HIRFunction[];
  /** Globals filled on first read, by `__milo.lazyinit.<G>` behind the guard `__milo.lazy.<G>`. */
  lazyGlobals: Map<string, HIRGlobal>;
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
// record/replay that way), so that initializer still runs before main, in `module.globals`
// order, which the checker sorted by dependency.
export function planStartup(module: HIRModule, layout: Layout, target: TargetInfo): StartupPlan {
  const functions = module.functions.filter(f => !f.isExtern);
  const runtimeInit = module.globals.filter(g => !isFullyConstInit(g, layout.structLayouts));
  const initFns: HIRFunction[] = runtimeInit.map(g => ({
    name: `${LAZY_INIT_PREFIX}${g.name}`,
    params: [],
    retType: { tag: "void" },
    body: [{
      kind: "Assign" as const,
      target: { kind: "Ident" as const, name: g.name, type: g.type },
      value: g.value,
      isInit: true,
    }],
    isExtern: false,
    isVariadic: false,
    ...(g.sourceFile && { sourceFile: g.sourceFile }),
  }));
  const read = guardLazyGlobals([...functions, ...initFns], new Set(runtimeInit.map(g => g.name)));
  const lazyInit = initFns.filter((_f, i) => read.has(runtimeInit[i]!.name));
  const eager = initFns.filter((_f, i) => !read.has(runtimeInit[i]!.name));
  const startupFns = eager.length === 0 ? lazyInit : [...lazyInit, {
    name: GLOBAL_INIT_FN,
    params: [],
    retType: { tag: "void" as const },
    body: eager.flatMap(f => f.body),
    isExtern: false,
    isVariadic: false,
  }];
  return {
    initFns: startupFns,
    lazyGlobals: new Map(runtimeInit.filter(g => read.has(g.name)).map(g => [g.name, g])),
    startupGlobals: runtimeInit.filter(g => !read.has(g.name)).map(g => g.name),
    greenMain: mainCanSpawnGreenTasks(target, functions, startupFns),
  };
}

function collectCallees(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectCallees(child, out);
    return;
  }
  const n = node as Record<string, unknown>;
  if (n.kind === "Call" && typeof n.func === "string") out.add(n.func);
  for (const v of Object.values(n)) collectCallees(v, out);
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
function mainCanSpawnGreenTasks(target: TargetInfo, functions: HIRFunction[], initFns: HIRFunction[]): boolean {
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
    const callees = new Set<string>();
    collectCallees(fn.body, callees);
    for (const c of callees) if (!seen.has(c)) stack.push(c);
  }
  return false;
}
