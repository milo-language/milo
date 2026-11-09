// Debug oracles for two rules no type can state: the AST is never written once the resolver
// returns it, and a node the checker rewrote (CheckResult.rewrites) is only ever read through
// `rewritten`. Off unless MILO_AST_ORACLE is set; scripts/ast-oracle.ts sweeps the corpus with it.
//   MILO_AST_ORACLE=writes   every write to a node of the program handed to the checker is noted
//                            with the writing site
//   MILO_AST_ORACLE=stale    after a rewrite is recorded, every property read of the replaced node
//                            and every use of it as a table key is noted with the reading site
// MILO_AST_ORACLE_LOG names the file the noted sites are appended to (stderr otherwise).
import { appendFileSync } from "fs";
import type { Program } from "./ast";

const sites = new Map<string, number>();
let armed = false;
// True while applyRewrites runs: its writes are the rewrites, not a checker write.
let applying = false;
// Nodes whose rewrite is recorded and not yet applied (the stale window).
let stale = new WeakSet<object>();

function note(what: string): void {
  if (applying) return;
  const frames = (new Error().stack ?? "").split("\n").slice(1).filter((l) => !l.includes("ast-oracle.ts"));
  // A native frame (Object.entries, a spread) has no file: the first frame that has one is the site.
  // MILO_AST_ORACLE_DEPTH=n names the n innermost callers too (site<-caller<-...), to find who held the node.
  const depth = Number(process.env.MILO_AST_ORACLE_DEPTH ?? "1");
  const at = frames.map((l) => /([^/\s(]+\.ts:\d+)/.exec(l)?.[1]).filter((m) => m !== undefined).slice(0, depth).join("<-") || "?";
  const key = `${at} ${what}`;
  sites.set(key, (sites.get(key) ?? 0) + 1);
}

function flush(): void {
  noteShapeChanges();
  if (sites.size === 0) return;
  const text = [...sites].map(([k, n]) => `${k} x${n}`).join("\n") + "\n";
  const log = process.env.MILO_AST_ORACLE_LOG;
  if (log) appendFileSync(log, text); else process.stderr.write(text);
  sites.clear();
}

// Each node's keys (an array's length) as the program came out of the resolver: a property added
// or deleted afterwards trips no accessor, so the exit report compares against these.
const shapes = new Map<object, string>();
const shapeOf = (x: object): string => (Array.isArray(x) ? `length ${x.length}` : Object.keys(x).join(","));
const ARRAY_WRITERS = ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill"] as const;

// Every property becomes an accessor that notes a write and then performs it, so one run lists
// every writing site instead of stopping at the first (which Object.freeze would).
function watchWrites(root: unknown): void {
  const work: unknown[] = [root];
  while (work.length > 0) {
    const x = work.pop();
    if (x === null || typeof x !== "object" || shapes.has(x)) continue;
    // No Map or Set under a program holds a node the passes write; only their values are walked.
    if (x instanceof Map || x instanceof Set) { shapes.set(x, ""); for (const v of x.values()) work.push(v); continue; }
    for (const k of Object.keys(x)) {
      let v = (x as Record<string, unknown>)[k];
      work.push(v);
      Object.defineProperty(x, k, { enumerable: true, configurable: true, get() { return v; }, set(nv) { note(`write .${k}`); v = nv; } });
    }
    if (Array.isArray(x)) {
      for (const m of ARRAY_WRITERS) {
        Object.defineProperty(x, m, { enumerable: false, configurable: true, value(...a: unknown[]) { note(`write ${m}()`); try { return (Array.prototype[m] as (...a: unknown[]) => unknown).apply(x, a); } finally { shapes.set(x as object, shapeOf(x as object)); } } });
      }
    }
    shapes.set(x, shapeOf(x));
  }
}

function noteShapeChanges(): void {
  for (const [x, was] of shapes) {
    if (x instanceof Map || x instanceof Set || shapeOf(x) === was) continue;
    const key = `? keys of ${(x as { kind?: string }).kind ?? (Array.isArray(x) ? "array" : "object")}: ${was} -> ${shapeOf(x)}`;
    sites.set(key, (sites.get(key) ?? 0) + 1);
  }
}

// The replaced node keeps its values, so a run goes on as it would have; each read is only noted.
function markStale(node: object): void {
  for (const k of Object.keys(node)) {
    let v = (node as Record<string, unknown>)[k];
    Object.defineProperty(node, k, { enumerable: true, configurable: true, get() { note(`read .${k}`); return v; }, set(nv) { note(`write .${k}`); v = nv; } });
  }
}

// Runs the apply step: the writes it makes are not noted, and the shape snapshot is taken again after it
// so only writes made before it show up as shape changes. The stale window closes here.
export function applyWindow(fn: () => void): void {
  if (!armed) { fn(); return; }
  noteShapeChanges();
  applying = true;
  try { fn(); } finally {
    applying = false;
    for (const x of shapes.keys()) if (!(x instanceof Map || x instanceof Set)) shapes.set(x, shapeOf(x));
    stale = new WeakSet<object>();
  }
}

// `checker` is the TypeChecker about to run; its tables are reached by name because they are private.
export function armAstOracle(mode: string, program: Program, checker: object): void {
  if (!armed) { armed = true; process.on("exit", flush); }
  if (mode === "writes") { watchWrites(program); return; }
  if (mode !== "stale") throw new Error(`MILO_AST_ORACLE: unknown mode '${mode}' (writes, stale)`);
  stale = new WeakSet<object>();
  const fields = checker as Record<string, unknown>;
  const tables: [string, Map<object, unknown> | Set<object>][] = [];
  const rewrites = fields.rewrites as Map<object, object>;
  if (!(rewrites instanceof Map)) throw new Error("MILO_AST_ORACLE: the checker has no rewrites table");
  for (const [name, table] of Object.entries(fields)) {
    if (table === rewrites || !(table instanceof Map || table instanceof Set)) continue;
    tables.push([name, table as Map<object, unknown> | Set<object>]);
    for (const op of ["get", "has", "set", "add", "delete"] as const) {
      const real = (table as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof real !== "function") continue;
      (table as unknown as Record<string, unknown>)[op] = function (this: unknown, ...a: unknown[]) {
        if (a[0] !== null && typeof a[0] === "object" && stale.has(a[0])) note(`key ${name}.${op}`);
        return real.apply(this, a);
      };
    }
  }
  const set = rewrites.set;
  rewrites.set = function (k, v) {
    // A fact filed under the node before it was replaced: every later lookup goes through the replacement and misses it.
    for (const [name, table] of tables) if (table.has(k)) note(`orphan ${name}`);
    const r = set.call(this, k, v);
    stale.add(k);
    markStale(k);
    return r;
  };
}
