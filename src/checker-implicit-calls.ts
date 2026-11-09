// The implicit-call model, in the portable subset: plain data in, answers out. A call through a
// fn-typed value runs whatever the value may hold, an interface call runs any impl, a dying value
// runs its Drop, and a lazy global's first read runs its initializer; none of those is spelled in
// the source. What a name holds depends on the scope the walk is in (the names a binder has
// shadowed so far, and what one call site passed each parameter), so a pass asks this model with
// its CURRENT scope while it walks. Checker facts (resolved callees, fn types, drop fns) arrive as
// NodeFact/FnFact keyed by node id, numbered the way the walker numbers nodes; the model owns
// everything that needs a scope: parameter value sets and their fixpoint, closure numbering,
// call-through-value targets and the reachable fn set.
// The checker's own copy is implicitCalls in src/checker-program-passes.ts, still used by its
// other passes; this one answers the same questions for the thread-boundary pass.
import type { Span } from "./ast";

export const INDIRECT = "<indirect>";
export const FOREIGN = "<foreign>";
// A name's value: not a parameter, or anything at all, or an index into the model's value sets.
export const V_NONE = -1;
export const V_ANY = -2;

export interface ArgFact { id: number; closure: boolean; ident: string; fnTyped: boolean }

// indirectMode: 0 an ordinary call; 1 a call of a variable (`func` names it); 2 a call through a
// fn-typed field (nothing bounds it); 3 a builtin or extern handed fn values (they are `args`).
export interface NodeFact {
  id: number;
  span: Span | undefined;
  binds: string[];
  declares: string;
  closure: boolean;
  callish: boolean;
  indirectMode: number;
  cfn: boolean;
  fnTyped: boolean;
  ident: string;
  func: string;
  callee: string;
  iface: string;
  lazyInit: string;
  critical: boolean;
  critArg: boolean;
  entry: string;
  drops: string[];
  ownDrops: string[];
  writes: string[];
  args: ArgFact[];
}

// `opaque`: callable from somewhere no call site records (external linkage, trait impl, interface
// method target). `root`: runs without a visible call (not a generic instance, a trait impl, a C entry).
export interface FnFact { name: string; sourceName: string; params: string[]; paramFnTyped: boolean[]; opaque: boolean; root: boolean }

// Where a name is looked up: `fn` owns the parameters; `env`, when not -1, replaces the owner's
// context-insensitive parameter sets with the ones one call site passed; `shadow` holds every name
// a binder introduced (flat, never popped: a name shadowed anywhere earlier resolves to unknown,
// the fail-closed direction). `log` is the same names in order, so a snapshot is a prefix copy.
export class Scope {
  shadow = new Set<string>();
  log: string[] = [];
  constructor(public owner: string, public env: number) {}

  // A class has no Clone in Milo, so the walk reuses one Scope and resets it per body.
  reset(owner: string, env: number): void {
    this.owner = owner;
    this.env = env;
    this.shadow = new Set<string>();
    this.log = [];
  }

  bind(name: string): void {
    this.shadow.add(name);
    this.log.push(name);
  }
}

export function copyBinds(dst: Scope, log: string[]): void {
  let i = 0;
  while (i < log.length) {
    dst.bind(log[i]);
    i++;
  }
}

function endsWith(s: string, suffix: string): boolean {
  if (s.length < suffix.length) { return false; }
  return s.slice(s.length - suffix.length, s.length) === suffix;
}

export class ImplicitModel {
  fnIdx = new Map<string, number>();
  // Names a source identifier may denote: a fn's own name and the name it was written as.
  instIdx = new Map<string, number>();
  instLists: string[][] = [];
  factIdx = new Map<number, number>();

  // Value sets, by index. A parameter slot is V_ANY or an index here.
  setItems: string[][] = [];
  paramSlot: number[] = [];
  paramBase: number[] = [];
  solved = false;

  envNames: string[][] = [];
  envVals: number[][] = [];

  // Closure literals in pre-order: `<closure#k>`, the node it sits at, its fact, the fn it sits in
  // and the names shadowed where it was written.
  closureNode: number[] = [];
  closureFact: number[] = [];
  closureFn: string[] = [];
  closureShadow: string[][] = [];
  closureOfNode = new Map<number, number>();
  closureOfId = new Map<string, number>();
  fnValues: string[] = [];
  fnValueSet = new Set<string>();

  // Direct calls passing a fn-typed argument: the fact, the callee, the fn it is in and the shadow.
  siteFact: number[] = [];
  siteCallee: string[] = [];
  siteOwner: string[] = [];
  siteLog: string[][] = [];

  reach = new Set<string>();
  reachQueue: string[] = [];

  // Plain data only: the input also carries AST bodies, which have no Clone in Milo.
  constructor(public fns: FnFact[], public facts: NodeFact[]) {}

  index(): void {
    let i = 0;
    while (i < this.fns.length) {
      const f = this.fns[i];
      this.fnIdx.set(f.name, i);
      this.addInstance(f.name, f.name);
      if (f.sourceName !== "" && f.sourceName !== f.name) { this.addInstance(f.sourceName, f.name); }
      i++;
    }
    let k = 0;
    while (k < this.facts.length) {
      this.factIdx.set(this.facts[k].id, k);
      k++;
    }
  }

  addInstance(key: string, name: string): void {
    const got = this.instIdx.get(key);
    if (got !== undefined) {
      this.instLists[got].push(name);
    } else {
      this.instIdx.set(key, this.instLists.length);
      const l: string[] = [];
      l.push(name);
      this.instLists.push(l);
    }
  }

  fnIndexOf(name: string): number {
    const got = this.fnIdx.get(name);
    if (got !== undefined) { return got; }
    return -1;
  }

  factAt(id: number): number {
    const got = this.factIdx.get(id);
    if (got !== undefined) { return got; }
    return -1;
  }

  closureIdOf(k: number): string {
    return `<closure#${k}>`;
  }

  // ---- value sets ----

  newSet(): number {
    const l: string[] = [];
    this.setItems.push(l);
    return this.setItems.length - 1;
  }

  setHas(s: number, v: string): boolean {
    const items = this.setItems[s];
    let i = 0;
    while (i < items.length) {
      if (items[i] === v) { return true; }
      i++;
    }
    return false;
  }

  setAdd(s: number, v: string): boolean {
    if (this.setHas(s, v)) { return false; }
    this.setItems[s].push(v);
    return true;
  }

  // ---- scope lookups ----

  resolve(name: string, sc: Scope): number {
    if (sc.shadow.has(name)) { return V_ANY; }
    if (sc.env >= 0) {
      const names = this.envNames[sc.env];
      let i = 0;
      while (i < names.length) {
        if (names[i] === name) { return this.envVals[sc.env][i]; }
        i++;
      }
      return V_NONE;
    }
    const fi = this.fnIdx.get(sc.owner);
    if (fi !== undefined) {
      const params = this.fns[fi].params;
      let j = 0;
      while (j < params.length) {
        // Before the fixpoint has run nothing bounds a parameter.
        if (params[j] === name) {
          if (!this.solved) { return V_ANY; }
          return this.paramSlot[this.paramBase[fi] + j];
        }
        j++;
      }
    }
    return V_NONE;
  }

  instancesValue(name: string): number {
    const got = this.instIdx.get(name);
    if (got !== undefined) {
      const s = this.newSet();
      const l = this.instLists[got];
      let i = 0;
      while (i < l.length) {
        this.setAdd(s, l[i]);
        i++;
      }
      return s;
    }
    return V_ANY;
  }

  // What a fn-typed argument may be: a closure literal, a name the scope knows, a named fn, or unknown.
  valuesOfArg(a: ArgFact, sc: Scope): number {
    if (a.closure) {
      const k = this.closureOfNode.get(a.id);
      if (k !== undefined) {
        const s = this.newSet();
        this.setAdd(s, this.closureIdOf(k));
        return s;
      }
      return V_ANY;
    }
    if (a.ident !== "") {
      const r = this.resolve(a.ident, sc);
      if (r !== V_NONE) { return r; }
      return this.instancesValue(a.ident);
    }
    return V_ANY;
  }

  // ---- collect, then solve ----

  // Called by the walk over every fn body and global value, once per fact, after the scope took its binds.
  collect(at: number, id: number, sc: Scope): void {
    const f = this.facts[at];
    if (f.closure) {
      const k = this.closureNode.length;
      this.closureNode.push(id);
      this.closureFact.push(at);
      this.closureFn.push(sc.owner);
      this.closureShadow.push(this.copyLog(sc));
      this.closureOfNode.set(id, k);
      this.closureOfId.set(this.closureIdOf(k), k);
    }
    if (f.ident !== "" && f.fnTyped && this.resolve(f.ident, sc) === V_NONE) {
      const got = this.instIdx.get(f.ident);
      if (got !== undefined) {
        const l = this.instLists[got];
        let i = 0;
        while (i < l.length) {
          this.addFnValue(l[i]);
          i++;
        }
      }
    }
    if (f.callish && f.indirectMode === 0 && f.callee !== "" && this.fnIdx.has(f.callee) && this.anyFnTypedArg(f)) {
      this.siteFact.push(at);
      this.siteCallee.push(f.callee);
      this.siteOwner.push(sc.owner);
      this.siteLog.push(this.copyLog(sc));
    }
  }

  addFnValue(name: string): void {
    if (this.fnValueSet.has(name)) { return; }
    this.fnValueSet.add(name);
    this.fnValues.push(name);
  }

  anyFnTypedArg(f: NodeFact): boolean {
    let i = 0;
    while (i < f.args.length) {
      if (f.args[i].fnTyped) { return true; }
      i++;
    }
    return false;
  }

  copyLog(sc: Scope): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < sc.log.length) {
      out.push(sc.log[i]);
      i++;
    }
    return out;
  }

  // The scope a closure body was written in, for walking it from a call through a value: the
  // caller makes `dst` with `closureFn[k]` and this fills in the names shadowed there.
  fillClosureScope(k: number, dst: Scope): void {
    copyBinds(dst, this.closureShadow[k]);
  }

  offsetFor(callee: string, nargs: number): number {
    const fi = this.fnIdx.get(callee);
    if (fi !== undefined) {
      const n = this.fns[fi].params.length;
      if (n === nargs) { return 0; }
      if (n === nargs + 1) { return 1; }
    }
    return -1;
  }

  // A fn-typed parameter holds what its direct call sites pass, unless the fn can be called from
  // somewhere no site records: then every parameter is unbounded.
  // `sc` is scratch: each site's scope is rebuilt in it to read the values its arguments hold.
  solve(sc: Scope): void {
    let i = 0;
    while (i < this.fns.length) {
      const f = this.fns[i];
      this.paramBase.push(this.paramSlot.length);
      const opaque = f.opaque || this.fnValueSet.has(f.name);
      let j = 0;
      while (j < f.params.length) {
        if (!opaque && f.paramFnTyped[j]) { this.paramSlot.push(this.newSet()); } else { this.paramSlot.push(V_ANY); }
        j++;
      }
      i++;
    }
    this.solved = true;
    let changed = true;
    while (changed) {
      changed = false;
      let s = 0;
      while (s < this.siteFact.length) {
        const callee = this.siteCallee[s];
        const fi = this.fnIndexOf(callee);
        let nparams = 0;
        if (fi >= 0) { nparams = this.fns[fi].params.length; }
        const args = this.facts[this.siteFact[s]].args;
        const off = this.offsetFor(callee, args.length);
        sc.reset(this.siteOwner[s], -1);
        copyBinds(sc, this.siteLog[s]);
        let j = 0;
        while (j < nparams) {
          const slot = this.paramBase[fi] + j;
          if (this.paramSlot[slot] !== V_ANY) {
            let v = this.newSet();
            if (off < 0) { v = V_ANY; } else if (j - off >= 0 && j - off < args.length) { v = this.valuesOfArg(args[j - off], sc); }
            if (v === V_ANY) {
              this.paramSlot[slot] = V_ANY;
              changed = true;
            } else {
              const items = this.setItems[v];
              let x = 0;
              while (x < items.length) {
                if (this.setAdd(this.paramSlot[slot], items[x])) { changed = true; }
                x++;
              }
            }
          }
          j++;
        }
        s++;
      }
    }
  }

  // ---- answers ----

  // The parameter env a direct call passes its callee, or -1 when the arguments do not line up
  // with the parameters (the callee's own sets then apply).
  envFor(callee: string, at: number, sc: Scope): number {
    const fi = this.fnIndexOf(callee);
    const args = this.facts[at].args;
    const off = this.offsetFor(callee, args.length);
    if (fi < 0 || off < 0) { return -1; }
    const params = this.fns[fi].params;
    const names: string[] = [];
    const vals: number[] = [];
    let j = 0;
    while (j < params.length) {
      names.push(params[j]);
      if (j - off >= 0 && args[j - off].fnTyped) { vals.push(this.valuesOfArg(args[j - off], sc)); } else { vals.push(V_ANY); }
      j++;
    }
    this.envNames.push(names);
    this.envVals.push(vals);
    return this.envNames.length - 1;
  }

  // Canonical text of what a parameter env holds, so two calls passing the same values share one walk.
  envKey(env: number): string {
    if (env < 0) { return ""; }
    let out = "";
    const names = this.envNames[env];
    let i = 0;
    while (i < names.length) {
      out += `${names[i]}=`;
      const v = this.envVals[env][i];
      if (v === V_ANY) {
        out += "*";
      } else {
        const members = this.setItems[v];
        const sorted = this.sortedIds(members);
        let x = 0;
        while (x < sorted.length) {
          out += `${sorted[x]},`;
          x++;
        }
      }
      out += ";";
      i++;
    }
    return out;
  }

  // Strings cannot be ordered here; fn names and closure ids are interned to ints and those sorted.
  internIdx = new Map<string, number>();
  internN = 0;
  sortedIds(items: string[]): number[] {
    const ids: number[] = [];
    let i = 0;
    while (i < items.length) {
      const got = this.internIdx.get(items[i]);
      if (got !== undefined) {
        ids.push(got);
      } else {
        this.internIdx.set(items[i], this.internN);
        ids.push(this.internN);
        this.internN++;
      }
      i++;
    }
    let a = 1;
    while (a < ids.length) {
      const x = ids[a];
      let b = a - 1;
      while (b >= 0 && ids[b] > x) {
        ids[b + 1] = ids[b];
        b--;
      }
      ids[b + 1] = x;
      a++;
    }
    return ids;
  }

  // The fn values a builtin was handed, or what a call of a variable may hold.
  indirectTargets(at: number, sc: Scope, out: string[]): void {
    const f = this.facts[at];
    let v = V_ANY;
    if (f.indirectMode === 1) {
      v = this.resolve(f.func, sc);
      if (v === V_NONE) { v = V_ANY; }
    } else if (f.indirectMode === 3) {
      const acc = this.newSet();
      let i = 0;
      while (i < f.args.length) {
        const a = f.args[i];
        if (!a.closure && a.fnTyped) {
          const av = this.valuesOfArg(a, sc);
          if (av === V_ANY) { v = V_ANY; i = f.args.length + 1; } else {
            const items = this.setItems[av];
            let x = 0;
            while (x < items.length) {
              this.setAdd(acc, items[x]);
              x++;
            }
          }
        }
        i++;
      }
      if (i === f.args.length) { v = acc; }
    }
    if (v === V_ANY) {
      out.push(INDIRECT);
    } else {
      const items = this.setItems[v];
      let x = 0;
      while (x < items.length) {
        out.push(items[x]);
        x++;
      }
    }
  }

  // The Drop fns the closures in `v` may run when they die: only what those literals own.
  closureDropsOf(v: number, out: string[]): void {
    const items = this.setItems[v];
    const got: string[] = [];
    let i = 0;
    while (i < items.length) {
      const k = this.closureOfId.get(items[i]);
      if (k !== undefined) {
        const own = this.facts[this.closureFact[k]].ownDrops;
        let x = 0;
        while (x < own.length) {
          this.pushOnce(got, own[x]);
          x++;
        }
      }
      i++;
    }
    let y = 0;
    while (y < got.length) {
      out.push(got[y]);
      y++;
    }
  }

  pushOnce(list: string[], v: string): void {
    let i = 0;
    while (i < list.length) {
      if (list[i] === v) { return; }
      i++;
    }
    list.push(v);
  }

  // The callees fact `at` runs that its resolved callee does not name: what a call through a
  // value may run (INDIRECT when unbounded), an interface method's impls, a lazy initializer and
  // the Drop fns of what the node may destroy.
  implicitTargets(at: number, sc: Scope, out: string[]): void {
    const f = this.facts[at];
    if (f.indirectMode > 0) { this.indirectTargets(at, sc, out); }
    if (f.cfn) { out.push(FOREIGN); }
    if (f.iface !== "") {
      const suffix = `$${f.iface}`;
      let i = 0;
      while (i < this.fns.length) {
        if (endsWith(this.fns[i].name, suffix)) { out.push(this.fns[i].name); }
        i++;
      }
    }
    if (f.ident !== "" && f.lazyInit !== "" && this.resolve(f.ident, sc) === V_NONE) { out.push(f.lazyInit); }
    if (f.closure) {
      let x = 0;
      while (x < f.ownDrops.length) {
        out.push(f.ownDrops[x]);
        x++;
      }
    } else if (f.ident !== "" && f.fnTyped) {
      const v = this.valuesOfArg({ id: -1, closure: false, ident: f.ident, fnTyped: true }, sc);
      if (v === V_ANY) { this.pushAll(out, f.drops); } else { this.closureDropsOf(v, out); }
    } else {
      this.pushAll(out, f.drops);
    }
  }

  pushAll(out: string[], items: string[]): void {
    let i = 0;
    while (i < items.length) {
      out.push(items[i]);
      i++;
    }
  }

  // ---- reachability ----

  reachAdd(t: string): void {
    if (this.fnIdx.has(t) && !this.reach.has(t)) {
      this.reach.add(t);
      this.reachQueue.push(t);
    }
  }

  // Roots are every fn a program can run without a visible call.
  reachRoots(): void {
    let i = 0;
    while (i < this.fns.length) {
      if (this.fns[i].root) {
        const nm = this.fns[i].name;
        this.reachAdd(nm);
      }
      i++;
    }
  }

  // One node of a reachability scan: the fns it names, calls, or may call through a value.
  reachNode(at: number, sc: Scope): void {
    const f = this.facts[at];
    if (f.callish && f.indirectMode === 0 && f.callee !== "") { this.reachAdd(f.callee); }
    const ts: string[] = [];
    this.implicitTargets(at, sc, ts);
    let i = 0;
    while (i < ts.length) {
      if (ts[i] === INDIRECT) {
        let v = 0;
        while (v < this.fnValues.length) {
          const fv = this.fnValues[v];
          this.reachAdd(fv);
          v++;
        }
      } else {
        this.reachAdd(ts[i]);
      }
      i++;
    }
    // A fn named as a value may be called by whoever receives it.
    if (f.ident !== "" && f.fnTyped) {
      const got = this.instIdx.get(f.ident);
      if (got !== undefined) {
        const l = this.instLists[got];
        let x = 0;
        while (x < l.length) {
          this.reachAdd(l[x]);
          x++;
        }
      }
    }
  }
}
