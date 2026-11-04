// Random Milo program generator for scripts/gen-programs.ts: deterministic from a seed, biased
// to ownership edge cases (moves in branches, field moves, reassigned moved places, closures,
// `?` with live locals, early exits holding owned values, Drop order, green tasks).
//
// The generator tracks which variables are moved (whole or by field) as it goes, so most
// programs are accepted by the checker; the runner still checks each one and drops rejects.
// Loop bodies never move an outer variable unless they reassign it straight away, and every
// loop is bounded, so every program terminates.

export type Ty = "int" | "str" | "vi" | "vs" | "res" | "vr" | "rec" | "os" | "mv" | "pk" | "op";
type Field = "vals" | "tags" | "res";
interface Var { name: string; ty: Ty; mut: boolean; moved: boolean; partial: Set<Field> }
type Env = Var[];
interface Ctx { ret: "main" | "int" | "res"; frozen: Set<string>; loop: boolean; depth: number; budget: { n: number } }
interface Helper { name: string; params: Ty[]; ret: "int" | "res" }

export function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_TEXT: Record<Ty, string> = {
  int: "i64", str: "string", vi: "Vec<i64>", vs: "Vec<string>", res: "Res", vr: "Vec<Res>", rec: "Rec", os: "Option<string>", mv: "move (i64) => i64", pk: "Pkt", op: "Option<Res>",
};
const OWNED: Ty[] = ["vi", "vs", "res", "vr", "rec", "os", "mv", "pk", "op"];
const WORDS = ["a", "bc", "hello", "x y", "q"];

// Prelude pieces, emitted only when a statement used them (so reduced programs stay small).
const PRELUDE: Record<string, { text: string; needs?: string[] }> = {
  Res: { text: `struct Res { id: i64 }\n\nimpl Drop for Res {\n    fn drop(self: &mut Self): void {\n        print("drop ", self.id)\n    }\n}` },
  Rec: { text: `struct Rec { name: string, vals: Vec<i64>, tags: Vec<string>, res: Res, n: i64 }`, needs: ["Res"] },
  sumv: { text: `fn sumv(v: &Vec<i64>): i64 {\n    var s: i64 = 0\n    for x in v {\n        s += x\n    }\n    return s\n}` },
  sumvs: { text: `fn sumvs(v: &Vec<string>): i64 {\n    var s: i64 = 0\n    for x in v {\n        s += x.len\n    }\n    return s\n}` },
  eatVi: { text: `fn eatVi(v: Vec<i64>): i64 {\n    return v.len\n}` },
  eatVs: { text: `fn eatVs(v: Vec<string>): i64 {\n    return v.len\n}` },
  eatRes: { text: `fn eatRes(r: Res): i64 {\n    return r.id\n}`, needs: ["Res"] },
  eatVr: { text: `fn eatVr(v: Vec<Res>): i64 {\n    var t: i64 = 0\n    for r in v {\n        t += r.id\n    }\n    return t\n}`, needs: ["Res"] },
  eatRec: { text: `fn eatRec(r: Rec): i64 {\n    return r.n + r.res.id\n}`, needs: ["Rec"] },
  Pkt: { text: `enum Pkt { A(Res), B(Vec<i64>), C }`, needs: ["Res"] },
  mkRes: { text: `fn mkRes(n: i64): Res {\n    return Res { id: n }\n}`, needs: ["Res"] },
  mkRec: { text: `fn mkRec(n: i64): Rec {\n    return Rec { name: "r", vals: [n], tags: ["t"], res: Res { id: n }, n: n }\n}`, needs: ["Rec"] },
  mk: { text: `fn mk(v: Vec<i64>): move (i64) => i64 {\n    return move (k: i64): i64 => k + sumv(v)\n}`, needs: ["sumv"] },
  callMv: { text: `fn callMv(f: move (i64) => i64, x: i64): i64 {\n    return f(x)\n}` },
  tryA: { text: `fn tryA(x: i64): Result<i64, string> {\n    if x > 5 {\n        return Result.Err($"big {x}")\n    }\n    return Result.Ok(x * 2)\n}` },
};
const EAT: Partial<Record<Ty, string>> = { vi: "eatVi", vs: "eatVs", res: "eatRes", vr: "eatVr", rec: "eatRec" };

export interface Generated { src: string; kind: "owned" | "tasks" }

export function generate(seed: number): Generated {
  const rng = rngOf(seed * 2654435761 + 12345);
  return rng() < 0.12 ? { src: genTasks(rng), kind: "tasks" } : { src: new Gen(rng).program(), kind: "owned" };
}

class Gen {
  private n = 0;
  private resId = 0;
  private used = new Set<string>();
  private helpers: Helper[] = [];
  private fns: string[] = [];
  // Declarations of `var` places are written §name§ and resolved at the end: a var never mutated is a checker error.
  private mutated = new Set<string>();
  private noLit = false;
  private finish(text: string): string { return text.replace(/§(\w+)§/g, (_, n) => (this.mutated.has(n) ? "var" : "let")); }
  constructor(private rng: () => number) {}

  private chance(p: number): boolean { return this.rng() < p; }
  private int(a: number, b: number): number { return a + Math.floor(this.rng() * (b - a + 1)); }
  private pick<T>(xs: T[]): T { return xs[Math.floor(this.rng() * xs.length)]!; }
  private name(p: string): string { return `${p}${++this.n}`; }
  private need(k: string): void {
    if (this.used.has(k)) return;
    this.used.add(k);
    for (const d of PRELUDE[k]!.needs ?? []) this.need(d);
  }

  program(): string {
    const nh = this.int(0, 2);
    for (let i = 0; i < nh; i++) this.helper(i);
    const body: string[] = [];
    const env: Env = [];
    const ctx: Ctx = { ret: "main", frozen: new Set(), loop: false, depth: 0, budget: { n: this.int(6, 12) } };
    // two runtime-valued ints so conditions are not constant
    body.push(`    let a0: i64 = ${this.int(0, 9)}`, `    let a1: i64 = ${this.int(0, 9)}`);
    this.declare(env, "a0", "int", false);
    this.declare(env, "a1", "int", false);
    this.block(env, ctx, body, 1, ctx.budget.n);
    body.push("    return 0");
    const order = Object.keys(PRELUDE).filter(k => this.used.has(k));
    const parts = [...order.map(k => PRELUDE[k]!.text), ...this.fns, `fn main(): i32 {\n${body.join("\n")}\n}`];
    return this.finish(parts.join("\n\n")) + "\n";
  }

  private helper(i: number): void {
    const params: Ty[] = Array.from({ length: this.int(1, 3) }, () => this.pick<Ty>(["int", "str", "vi", "vs", "res", "rec", "vr"]));
    const ret = this.chance(0.4) ? "res" : "int";
    const env: Env = params.map((ty, k) => ({ name: `p${k}`, ty, mut: false, moved: false, partial: new Set<Field>() }));
    for (const ty of params) this.touchType(ty);
    const ctx: Ctx = { ret, frozen: new Set(), loop: false, depth: 0, budget: { n: this.int(3, 6) } };
    const body: string[] = [];
    this.block(env, ctx, body, 1, ctx.budget.n);
    const tail = this.fresh(env, ctx, "int", 1);
    body.push(ret === "res" ? `    return Result.Ok(${tail})` : `    return ${tail}`);
    const name = `f${i}`;
    this.fns.push(`fn ${name}(${params.map((t, k) => `p${k}: ${TYPE_TEXT[t]}`).join(", ")}): ${ret === "res" ? "Result<i64, string>" : "i64"} {\n${body.join("\n")}\n}`);
    this.helpers.push({ name, params, ret });
  }

  private touchType(ty: Ty): void {
    if (ty === "res" || ty === "vr") this.need("Res");
    if (ty === "rec") this.need("Rec");
    if (ty === "mv") this.need("callMv");
  }

  // ---- state helpers
  private cl(e: Env): Env { return e.map(v => ({ ...v, partial: new Set(v.partial) })); }
  private adopt(parent: Env, child: Env): void {
    for (const p of parent) {
      const c = child.find(v => v.name === p.name)!;
      p.moved = p.moved || c.moved;
      for (const f of c.partial) p.partial.add(f);
    }
  }
  private readable(env: Env, ty: Ty): Var[] { return env.filter(v => v.ty === ty && !v.moved && v.partial.size === 0); }
  private movable(env: Env, ctx: Ctx, ty: Ty): Var[] { return this.readable(env, ty).filter(v => !ctx.frozen.has(v.name)); }
  private declare(env: Env, name: string, ty: Ty, mut: boolean): void { env.push({ name, ty, mut, moved: false, partial: new Set() }); }

  // ---- expressions. Using an owned variable by value marks it moved.
  fresh(env: Env, ctx: Ctx, ty: Ty, d: number): string {
    const rng = this.rng;
    switch (ty) {
      case "int": {
        const opts: (() => string)[] = [() => String(this.int(0, 9))];
        const ints = this.readable(env, "int");
        if (ints.length) opts.push(() => this.pick(ints).name, () => this.pick(ints).name, () => this.pick(ints).name);
        if (this.noLit && ints.length) opts.shift();
        if (d < 3) {
          opts.push(() => `${this.fresh(env, ctx, "int", d + 1)} + ${this.fresh(env, ctx, "int", d + 1)}`);
          const vi = this.readable(env, "vi"), vs = this.readable(env, "vs"), vr = this.readable(env, "vr"), st = this.readable(env, "str");
          if (vi.length) opts.push(() => { this.need("sumv"); return `sumv(${this.pick(vi).name})`; }, () => `${this.pick(vi).name}.len`);
          if (vs.length) opts.push(() => `${this.pick(vs).name}.len`, () => { this.need("sumvs"); return `sumvs(${this.pick(vs).name})`; });
          if (vr.length) opts.push(() => `${this.pick(vr).name}.len`);
          if (st.length) opts.push(() => `${this.pick(st).name}.len`);
          const recs = env.filter(v => v.ty === "rec" && !v.moved);
          if (recs.length) opts.push(() => `${this.pick(recs).name}.n`);
          if (this.chance(0.15)) { this.need("mkRec"); opts.push(() => `mkRec(${++this.resId}).res.id`); }
          if (this.chance(0.15)) { this.need("mkRes"); opts.push(() => `mkRes(${++this.resId}).id`); }
          const rs = this.readable(env, "res");
          if (rs.length) opts.push(() => `${this.pick(rs).name}.id`);
          const mvs = env.filter(v => v.ty === "mv" && !v.moved);
          if (mvs.length) opts.push(() => `${this.pick(mvs).name}(${this.int(0, 5)})`);
          const hs = this.helpers.filter(h => h.ret === "int");
          if (hs.length && ctx.ret !== "int") opts.push(() => this.call(this.pick(hs), env, ctx, d));
        }
        return this.pick(opts)();
      }
      case "str": {
        const opts: (() => string)[] = [() => `"${this.pick(WORDS)}"`];
        const st = this.readable(env, "str");
        if (st.length) opts.push(() => this.pick(st).name, () => this.pick(st).name);
        const recs = env.filter(v => v.ty === "rec" && !v.moved);
        if (recs.length) opts.push(() => `${this.pick(recs).name}.name`);
        if (d < 3) {
          opts.push(() => `$"{${this.fresh(env, ctx, "int", d + 1)}}-{${this.fresh(env, ctx, "str", d + 1)}}"`);
          opts.push(() => `${this.fresh(env, ctx, "str", d + 1)} + "${this.pick(WORDS)}"`);
          if (st.length) opts.push(() => `${this.pick(st).name}.clone()`);
        }
        return this.pick(opts)();
      }
      case "vi": case "vs": case "vr": {
        const vars = this.movable(env, ctx, ty);
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        if (ty === "vi" && vars.length && this.chance(0.2)) return `${this.pick(vars).name}.clone()`;
        const el: Ty = ty === "vi" ? "int" : ty === "vs" ? "str" : "res";
        const k = this.int(1, 3);
        return `[${Array.from({ length: k }, () => this.fresh(env, ctx, el, d + 1)).join(", ")}]`;
      }
      case "res": {
        const vars = this.movable(env, ctx, "res");
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        this.need("Res");
        if (this.chance(0.25)) { this.need("mkRes"); return `mkRes(${++this.resId})`; }
        return `Res { id: ${++this.resId} }`;
      }
      case "rec": {
        const vars = this.movable(env, ctx, "rec");
        if (vars.length && this.chance(0.35)) { const v = this.pick(vars); v.moved = true; return v.name; }
        this.need("Rec");
        const f = (t: Ty) => this.fresh(env, ctx, t, d + 1);
        return `Rec { name: ${f("str")}, vals: ${f("vi")}, tags: ${f("vs")}, res: ${f("res")}, n: ${f("int")} }`;
      }
      case "os": {
        const vars = this.movable(env, ctx, "os");
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        return this.chance(0.3) ? "Option.None" : `Option.Some(${this.fresh(env, ctx, "str", d + 1)})`;
      }
      case "pk": {
        const vars = this.movable(env, ctx, "pk");
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        this.need("Pkt");
        const k = this.int(0, 2);
        return k === 0 ? `Pkt.A(${this.fresh(env, ctx, "res", d + 1)})` : k === 1 ? `Pkt.B(${this.fresh(env, ctx, "vi", d + 1)})` : "Pkt.C";
      }
      case "op": {
        const vars = this.movable(env, ctx, "op");
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        this.need("Res");
        return this.chance(0.3) ? "Option.None" : `Option.Some(${this.fresh(env, ctx, "res", d + 1)})`;
      }
      case "mv": {
        const vars = this.movable(env, ctx, "mv");
        if (vars.length && this.chance(0.4)) { const v = this.pick(vars); v.moved = true; return v.name; }
        this.need("mk");
        return `mk(${this.fresh(env, ctx, "vi", d + 1)})`;
      }
    }
    void rng;
    return "0";
  }

  private call(h: Helper, env: Env, ctx: Ctx, d: number): string {
    for (const t of h.params) this.touchType(t);
    return `${h.name}(${h.params.map(t => this.fresh(env, ctx, t, d + 1)).join(", ")})`;
  }

  private cond(env: Env, ctx: Ctx): string {
    // a condition on literals only would leave one branch dead
    this.noLit = true;
    const x = this.fresh(env, ctx, "int", 2);
    this.noLit = false;
    return this.pick([`${x} % 2 == 0`, `${x} > ${this.int(1, 6)}`, `${x} < ${this.int(1, 6)}`, `${x} != ${this.int(0, 4)}`]);
  }

  // ---- statements
  private observe(v: Var, ind: string): string | null {
    const tag = `"o${++this.n} "`;
    switch (v.ty) {
      case "int": return `${ind}print(${tag}, ${v.name})`;
      case "str": return `${ind}print(${tag}, ${v.name}, " ", ${v.name}.len)`;
      case "vi": this.need("sumv"); return `${ind}print(${tag}, sumv(${v.name}), " ", ${v.name}.len)`;
      case "vs": this.need("sumvs"); return `${ind}print(${tag}, sumvs(${v.name}))`;
      case "res": return `${ind}print(${tag}, ${v.name}.id)`;
      case "vr": return `${ind}print(${tag}, ${v.name}.len)`;
      case "mv": return `${ind}print(${tag}, ${v.name}(${this.int(0, 5)}))`;
      case "rec": {
        const parts = [`${v.name}.n`, `${v.name}.name.len`];
        if (!v.partial.has("vals")) { this.need("sumv"); parts.push(`sumv(${v.name}.vals)`); }
        if (!v.partial.has("tags")) { this.need("sumvs"); parts.push(`sumvs(${v.name}.tags)`); }
        if (!v.partial.has("res")) parts.push(`${v.name}.res.id`);
        return `${ind}print(${tag}, ${parts.join(`, " ", `)})`;
      }
      case "os": case "pk": case "op": return null;
    }
  }

  private block(env: Env, ctx: Ctx, out: string[], indent: number, count: number): void {
    const ind = "    ".repeat(indent);
    for (let i = 0; i < count && ctx.budget.n > -40; i++) {
      for (let tries = 0; tries < 12; tries++) if (this.stmt(env, ctx, out, indent, ind)) break;
    }
  }

  // Reassign (or re-fill) what a branch moved, so the branch ends with the place whole again.
  private revive(parent: Env, child: Env, ctx: Ctx, out: string[], ind: string): void {
    for (const p of parent) {
      const c = child.find(v => v.name === p.name)!;
      if (!c.mut || ctx.frozen.has(c.name) && false) continue;
      if (c.moved && !p.moved && c.ty !== "mv" && c.ty !== "os" && c.ty !== "pk" && c.ty !== "op" && this.chance(0.5)) {
        this.mutated.add(c.name);
        out.push(`${ind}${c.name} = ${this.fresh(child, ctx, c.ty, 1)}`);
        c.moved = false;
        c.partial.clear();
      } else if (!c.moved && c.partial.size > 0 && c.ty === "rec" && this.chance(0.5)) {
        for (const f of [...c.partial]) if (!p.partial.has(f)) {
          this.mutated.add(c.name);
          out.push(`${ind}${c.name}.${f} = ${this.fresh(child, ctx, f === "vals" ? "vi" : f === "tags" ? "vs" : "res", 1)}`);
          c.partial.delete(f);
        }
      }
    }
  }

  private sub(env: Env, ctx: Ctx, out: string[], indent: number, extra?: (e: Env) => void, loop = false, frozen?: Set<string>): Env {
    const child = this.cl(env);
    extra?.(child);
    const c2: Ctx = { ...ctx, depth: ctx.depth + 1, loop: ctx.loop || loop, frozen: frozen ?? ctx.frozen };
    this.block(child, c2, out, indent, this.int(1, ctx.depth === 0 ? 4 : 3));
    return child;
  }

  private stmt(env: Env, ctx: Ctx, out: string[], indent: number, ind: string): boolean {
    ctx.budget.n--;
    const deep = ctx.depth >= 3;
    const kinds: [number, () => boolean][] = [
      [5, () => {
        const ty = this.pick<Ty>(["int", "str", "vi", "vs", "res", "vr", "rec", "os", "mv", "pk", "op"]);
        const mut = ty !== "mv" && this.chance(0.5);
        const name = this.name(ty === "int" ? "n" : ty === "str" ? "s" : "v");
        this.touchType(ty);
        const val = this.fresh(env, ctx, ty, 0);
        out.push(ty === "mv" ? `${ind}let ${name} = ${val}` : `${ind}${mut ? `§${name}§` : "let"} ${name}: ${TYPE_TEXT[ty]} = ${val}`);
        this.declare(env, name, ty, mut);
        return true;
      }],
      [4, () => {
        const vs = env.filter(v => !v.moved);
        if (!vs.length) return false;
        const line = this.observe(this.pick(vs), ind);
        if (!line) return false;
        out.push(line);
        return true;
      }],
      [3, () => { // eat: pass an owned value by value to a function, maybe refill the place
        const ty = this.pick<Ty>(["vi", "vs", "res", "vr", "rec", "mv"]);
        const all = this.readable(env, ty);
        const vars = all.filter(v => !ctx.frozen.has(v.name));
        const inLoop = all.filter(v => v.mut);
        const v = vars.length ? this.pick(vars) : inLoop.length && ctx.loop ? this.pick(inLoop) : null;
        if (!v) return false;
        const call = ty === "mv" ? (this.need("callMv"), `callMv(${v.name}, ${this.int(0, 4)})`) : (this.need(EAT[ty]!), `${EAT[ty]}(${v.name})`);
        out.push(`${ind}print("e${++this.n} ", ${call})`);
        v.moved = true;
        if (v.mut && ty !== "mv" && (ctx.frozen.has(v.name) || this.chance(0.4))) { this.mutated.add(v.name); out.push(`${ind}${v.name} = ${this.fresh(env, ctx, ty, 1)}`); v.moved = false; }
        return true;
      }],
      [3, () => { // move into a new binding
        const ty = this.pick<Ty>(OWNED);
        const vars = this.movable(env, ctx, ty);
        if (!vars.length) return false;
        const v = this.pick(vars);
        const name = this.name("m");
        const mut = ty !== "mv" && this.chance(0.4);
        out.push(`${ind}${mut ? `§${name}§` : "let"} ${name} = ${v.name}`);
        v.moved = true;
        this.declare(env, name, ty, mut);
        return true;
      }],
      [3, () => { // move a field out of a struct
        const recs = env.filter(v => v.ty === "rec" && !v.moved && !ctx.frozen.has(v.name));
        if (!recs.length) return false;
        const r = this.pick(recs);
        const fields = (["vals", "tags", "res"] as Field[]).filter(f => !r.partial.has(f));
        if (!fields.length) return false;
        const f = this.pick(fields);
        const ty: Ty = f === "vals" ? "vi" : f === "tags" ? "vs" : "res";
        const name = this.name("f");
        out.push(`${ind}let ${name} = ${r.name}.${f}`);
        r.partial.add(f);
        this.declare(env, name, ty, false);
        return true;
      }],
      [2, () => { // assign a field (fills a moved one, drops an unmoved one)
        const recs = env.filter(v => v.ty === "rec" && v.mut && !v.moved);
        if (!recs.length) return false;
        const r = this.pick(recs);
        this.mutated.add(r.name);
        if (this.chance(0.2)) { out.push(`${ind}${r.name}.n = ${this.fresh(env, ctx, "int", 1)}`); return true; }
        const f = this.pick<Field>(["vals", "tags", "res"]);
        out.push(`${ind}${r.name}.${f} = ${this.fresh(env, ctx, f === "vals" ? "vi" : f === "tags" ? "vs" : "res", 1)}`);
        r.partial.delete(f);
        return true;
      }],
      [3, () => { // assign a whole place (revives a moved one)
        const vars = env.filter(v => v.mut && v.ty !== "mv" && v.ty !== "os" && v.ty !== "op" && v.ty !== "pk" && !(v.partial.size && v.ty === "rec" && false));
        if (!vars.length) return false;
        const v = this.pick(vars);
        this.mutated.add(v.name);
        out.push(`${ind}${v.name} = ${this.fresh(env, ctx, v.ty, 1)}`);
        v.moved = false;
        v.partial.clear();
        return true;
      }],
      [3, () => {
        const ty = this.pick<Ty>(["vi", "vs", "vr"]);
        const vars = this.readable(env, ty).filter(v => v.mut);
        if (!vars.length) return false;
        const v = this.pick(vars);
        this.mutated.add(v.name);
        const el: Ty = ty === "vi" ? "int" : ty === "vs" ? "str" : "res";
        out.push(`${ind}${v.name}.push(${this.fresh(env, ctx, el, 1)})`);
        return true;
      }],
      [1, () => {
        const vars = this.readable(env, "vi");
        if (!vars.length) return false;
        const v = this.pick(vars);
        out.push(`${ind}if ${v.name}.len > 0 {\n${ind}    print("ix${++this.n} ", ${v.name}[0])\n${ind}}`);
        return true;
      }],
      [deep ? 0 : 4, () => { // if / else, moving different things in each branch
        out.push(`${ind}if ${this.cond(env, ctx)} {`);
        const a = this.sub(env, ctx, out, indent + 1);
        this.revive(env, a, ctx, out, ind + "    ");
        const hasElse = this.chance(0.7);
        let b: Env | null = null;
        if (hasElse) { out.push(`${ind}} else {`); b = this.sub(env, ctx, out, indent + 1); this.revive(env, b, ctx, out, ind + "    "); }
        out.push(`${ind}}`);
        this.adopt(env, a);
        if (b) this.adopt(env, b);
        return true;
      }],
      [deep ? 0 : 2, () => { // match on an Option<string> (consumes it)
        const vars = this.movable(env, ctx, "os");
        if (!vars.length) return false;
        const o = this.pick(vars);
        o.moved = true;
        const p = this.name("q");
        out.push(`${ind}match ${o.name} {`, `${ind}    Option.Some(${p}) => {`);
        const a = this.sub(env, ctx, out, indent + 2, e => this.declare(e, p, "str", false));
        out.push(`${ind}    }`, `${ind}    Option.None => {`);
        const b = this.sub(env, ctx, out, indent + 2);
        out.push(`${ind}    }`, `${ind}}`);
        this.adopt(env, a);
        this.adopt(env, b);
        return true;
      }],
      [deep ? 0 : 2, () => { // match on a Result
        this.need("tryA");
        const scrut = this.chance(0.5) && this.helpers.some(h => h.ret === "res") && ctx.ret === "main"
          ? this.call(this.pick(this.helpers.filter(h => h.ret === "res")), env, ctx, 1) : `tryA(${this.fresh(env, ctx, "int", 1)})`;
        const nn = this.name("k"), ee = this.name("e");
        out.push(`${ind}match ${scrut} {`, `${ind}    Result.Ok(${nn}) => {`);
        const a = this.sub(env, ctx, out, indent + 2, e => this.declare(e, nn, "int", false));
        out.push(`${ind}    }`, `${ind}    Result.Err(${ee}) => {`);
        const b = this.sub(env, ctx, out, indent + 2, e => this.declare(e, ee, "str", false));
        out.push(`${ind}    }`, `${ind}}`);
        this.adopt(env, a);
        this.adopt(env, b);
        return true;
      }],
      [deep ? 0 : 2, () => { // while loop
        const i = this.name("i");
        out.push(`${ind}var ${i}: i64 = 0`, `${ind}while ${i} < ${this.int(1, 4)} {`, `${ind}    ${i} += 1`);
        const frozen = new Set([...ctx.frozen, ...env.map(v => v.name)]);
        this.sub(env, ctx, out, indent + 1, e => this.declare(e, i, "int", false), true, frozen);
        out.push(`${ind}}`);
        return true;
      }],
      [deep ? 0 : 2, () => { // for over a range
        const i = this.name("i");
        out.push(`${ind}for ${i} in 0..${this.int(1, 4)} {`);
        const frozen = new Set([...ctx.frozen, ...env.map(v => v.name)]);
        this.sub(env, ctx, out, indent + 1, e => this.declare(e, i, "int", false), true, frozen);
        out.push(`${ind}}`);
        return true;
      }],
      [deep ? 0 : 2, () => { // for over an owned Vec: consumes it, the element is owned
        const ty = this.pick<Ty>(["vi", "vs", "vr"]);
        const vars = this.movable(env, ctx, ty);
        if (!vars.length) return false;
        const v = this.pick(vars);
        v.moved = true;
        const x = this.name("x");
        const el: Ty = ty === "vi" ? "int" : ty === "vs" ? "str" : "res";
        out.push(`${ind}for ${x} in ${v.name} {`);
        const frozen = new Set([...ctx.frozen, ...env.map(w => w.name)]);
        this.sub(env, ctx, out, indent + 1, e => this.declare(e, x, el, false), true, frozen);
        out.push(`${ind}}`);
        return true;
      }],
      [deep ? 0 : 2, () => { // match on a user enum with owned payloads (consumes it)
        const vars = this.movable(env, ctx, "pk");
        if (!vars.length) return false;
        const o = this.pick(vars);
        o.moved = true;
        const r = this.name("r"), w = this.name("w");
        out.push(`${ind}match ${o.name} {`, `${ind}    Pkt.A(${r}) => {`);
        const a = this.sub(env, ctx, out, indent + 2, e => this.declare(e, r, "res", false));
        out.push(`${ind}    }`, `${ind}    Pkt.B(${w}) => {`);
        const b = this.sub(env, ctx, out, indent + 2, e => this.declare(e, w, "vi", false));
        out.push(`${ind}    }`, `${ind}    Pkt.C => {`);
        const c = this.sub(env, ctx, out, indent + 2);
        out.push(`${ind}    }`, `${ind}}`);
        this.adopt(env, a);
        this.adopt(env, b);
        this.adopt(env, c);
        return true;
      }],
      [deep ? 0 : 2, () => { // match on an Option<Res>, or on a pop from a Vec<Res>
        const popFrom = this.readable(env, "vr").filter(v => v.mut && !ctx.frozen.has(v.name) || v.mut);
        let scrut: string;
        if (popFrom.length && this.chance(0.5)) { const v = this.pick(popFrom); this.mutated.add(v.name); scrut = `${v.name}.pop()`; }
        else {
          const vars = this.movable(env, ctx, "op");
          if (!vars.length) return false;
          const o = this.pick(vars);
          o.moved = true;
          scrut = o.name;
        }
        const r = this.name("r");
        out.push(`${ind}match ${scrut} {`, `${ind}    Option.Some(${r}) => {`);
        const a = this.sub(env, ctx, out, indent + 2, e => this.declare(e, r, "res", false));
        out.push(`${ind}    }`, `${ind}    Option.None => {`);
        const b = this.sub(env, ctx, out, indent + 2);
        out.push(`${ind}    }`, `${ind}}`);
        this.adopt(env, a);
        this.adopt(env, b);
        return true;
      }],
      [2, () => { // an if-expression whose branches each move something
        const ty = this.pick<Ty>(["vi", "vs", "res", "rec", "str", "pk"]);
        this.touchType(ty);
        const cond = this.cond(env, ctx);
        const ea = this.cl(env), eb = this.cl(env);
        const va = this.fresh(ea, ctx, ty, 1), vb = this.fresh(eb, ctx, ty, 1);
        this.adopt(env, ea);
        this.adopt(env, eb);
        const name = this.name("x");
        out.push(`${ind}let ${name}: ${TYPE_TEXT[ty]} = if ${cond} { ${va} } else { ${vb} }`);
        this.declare(env, name, ty, false);
        return true;
      }],
      [2, () => { // replace / swap a place, or assign through an index: the old value drops there
        const vr = this.readable(env, "vr").filter(v => v.mut);
        if (vr.length && this.chance(0.4)) {
          const v = this.pick(vr);
          this.mutated.add(v.name);
          out.push(`${ind}if ${v.name}.len > 0 {`, `${ind}    let ${this.name("old")} = replace(${v.name}[0], ${this.fresh(env, ctx, "res", 2)})`, `${ind}}`);
          return true;
        }
        const ty = this.pick<Ty>(["vi", "vs", "res", "rec"]);
        const vars = this.readable(env, ty).filter(v => v.mut);
        if (!vars.length) return false;
        const v = this.pick(vars);
        this.mutated.add(v.name);
        const name = this.name("old");
        out.push(`${ind}let ${name} = replace(${v.name}, ${this.fresh(env, ctx, ty, 1)})`);
        this.declare(env, name, ty, false);
        return true;
      }],
      [deep ? 0 : 1, () => { // while true with a counted break: owned locals live across it
        const i = this.name("i");
        out.push(`${ind}var ${i}: i64 = 0`, `${ind}while true {`, `${ind}    ${i} += 1`);
        const frozen = new Set([...ctx.frozen, ...env.map(v => v.name)]);
        this.sub(env, ctx, out, indent + 1, e => this.declare(e, i, "int", false), true, frozen);
        out.push(`${ind}    if ${i} >= ${this.int(1, 3)} {`, `${ind}        break`, `${ind}    }`, `${ind}}`);
        return true;
      }],
      [2, () => { // closure borrowing a Vec / mutating a captured local, scoped so it dies before the next use
        const vi = this.readable(env, "vi");
        const fn = this.name("c");
        if (vi.length && this.chance(0.5)) {
          const v = this.pick(vi);
          this.need("sumv");
          if (v.mut && this.chance(0.5)) {
            this.mutated.add(v.name);
            out.push(`${ind}if true {`, `${ind}    let ${fn} = (k: i64) => { ${v.name}.push(k) }`, `${ind}    ${fn}(${this.int(0, 5)})`, `${ind}    ${fn}(${this.int(0, 5)})`, `${ind}}`);
          } else {
            out.push(`${ind}let ${fn} = (k: i64): i64 => k + sumv(${v.name})`, `${ind}print("c${++this.n} ", ${fn}(${this.int(0, 5)}), " ", ${fn}(${this.int(0, 5)}))`);
          }
          return true;
        }
        const c = this.name("n");
        out.push(`${ind}var ${c}: i64 = ${this.int(0, 3)}`, `${ind}let ${fn} = () => { ${c} = ${c} + 1 }`, `${ind}${fn}()`, `${ind}${fn}()`, `${ind}print("c${++this.n} ", ${c})`);
        return true;
      }],
      [3, () => { // move closure: takes its captures out of the enclosing scope
        const ty = this.pick<Ty>(["vi", "vs", "res", "rec", "str"]);
        const vars = ty === "str" ? this.readable(env, "str") : this.movable(env, ctx, ty);
        if (!vars.length) return false;
        const v = this.pick(vars);
        const body = { vi: () => (this.need("sumv"), `sumv(${v.name})`), vs: () => (this.need("sumvs"), `sumvs(${v.name})`), res: () => `${v.name}.id`, rec: () => `${v.name}.n + ${v.name}.res.id`, str: () => `${v.name}.len` }[ty as "vi"]();
        const g = this.name("g");
        out.push(`${ind}let ${g} = move (k: i64): i64 => k + ${body}`);
        if (ty !== "str") v.moved = true;
        this.need("callMv");
        this.declare(env, g, "mv", false);
        return true;
      }],
      [2, () => { // string sharing
        const st = this.readable(env, "str");
        if (!st.length) return false;
        const s = this.pick(st);
        const t = this.name("s");
        const form = this.int(0, 2);
        if (form === 0) { out.push(`${ind}var ${t}: string = ${s.name}`, `${ind}${t} = ${t} + "!"`, `${ind}print("t${++this.n} ", ${s.name}, " ", ${t})`); this.declare(env, t, "str", true); }
        else if (form === 1) {
          const vs = this.readable(env, "vs").filter(v => v.mut);
          if (!vs.length) return false;
          const tgt = this.pick(vs);
          this.mutated.add(tgt.name);
          out.push(`${ind}${tgt.name}.push(${s.name})`,`${ind}print("t${++this.n} ", ${s.name}.len)`);
        } else { out.push(`${ind}let ${t} = $"<{${s.name}}>{${s.name}.len}"`, `${ind}print("t${++this.n} ", ${t})`); this.declare(env, t, "str", false); }
        return true;
      }],
      [ctx.ret !== "main" || ctx.depth > 0 ? 2 : 0, () => { // early return while owned locals are live
        const c = this.cond(env, ctx);
        const val = ctx.ret === "res" ? (this.chance(0.5) ? `Result.Err(${this.fresh(env, ctx, "str", 2)})` : `Result.Ok(${this.fresh(env, ctx, "int", 2)})`)
          : ctx.ret === "int" ? this.fresh(env, ctx, "int", 2) : String(this.int(0, 3));
        out.push(`${ind}if ${c} {`, `${ind}    return ${val}`, `${ind}}`);
        return true;
      }],
      [ctx.loop ? 4 : 0, () => {
        out.push(`${ind}if ${this.cond(env, ctx)} {`, `${ind}    ${this.pick(["break", "continue"])}`, `${ind}}`);
        return true;
      }],
      [this.helpers.length && ctx.ret !== "int" ? 3 : 0, () => {
        const hs = this.helpers.filter(h => ctx.ret === "main" || h.ret === "int" || ctx.ret === "res");
        if (!hs.length) return false;
        const h = this.pick(hs);
        if (h.ret === "res" && ctx.ret === "res") { out.push(`${ind}let ${this.name("r")} = ${this.call(h, env, ctx, 1)}?`); return true; }
        if (h.ret === "res") {
          const nn = this.name("k"), ee = this.name("e");
          out.push(`${ind}match ${this.call(h, env, ctx, 1)} {`, `${ind}    Result.Ok(${nn}) => print("h${++this.n} ", ${nn})`, `${ind}    Result.Err(${ee}) => print("h${++this.n} ", ${ee})`, `${ind}}`);
          return true;
        }
        out.push(`${ind}print("h${++this.n} ", ${this.call(h, env, ctx, 1)})`);
        return true;
      }],
      [ctx.ret === "res" ? 4 : 0, () => { // `?` while owned locals are live: they drop on the early exit
        this.need("tryA");
        const nn = this.name("k");
        out.push(`${ind}let ${nn} = tryA(${this.fresh(env, ctx, "int", 1)})?`);
        this.declare(env, nn, "int", false);
        return true;
      }],
    ];
    const total = kinds.reduce((a, k) => a + k[0], 0);
    let r = this.rng() * total;
    for (const [w, f] of kinds) {
      if ((r -= w) < 0) return w > 0 && f();
    }
    return false;
  }
}

// ---- green tasks over channels
function genTasks(rng: () => number): string {
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const chance = (p: number) => rng() < p;
  const producers = int(1, 3), perProducer = int(1, 4), cap = int(1, 4);
  const total = producers * perProducer;
  const early = chance(0.3) ? int(1, total) : total; // the consumer stops early: the rest is dropped undelivered
  const bigCap = early < total ? Math.max(cap, total) : cap; // keep producers from parking forever
  const payload = int(0, 2); // 0: i64, 1: string, 2: a struct with an owned Vec and a Drop
  const ty = ["i64", "string", "Msg"][payload]!;
  const mk = (id: string) => [`${id}`, `$"m{${id}}"`, `Msg { id: ${id}, body: [${id}, ${id} + 1] }`][payload]!;
  const show = (v: string) => [`print("got ", ${v})`, `print("got ", ${v}, " ", ${v}.len)`, `print("got ", ${v}.id, " ", ${v}.body.len)`][payload]!;
  const head: string[] = [];
  const L: string[] = [];
  head.push(`from "std/runtime" import {\n    Task, schedulerRunToCompletion\n}\nfrom "std/sync" import {\n    Channel\n}`);
  if (payload === 2) head.push(`struct Msg { id: i64, body: Vec<i64> }${chance(0.6) ? `\n\nimpl Drop for Msg {\n    fn drop(self: &mut Self): void {\n        print("drop ", self.id)\n    }\n}` : ""}`);
  L.push(`    let ch = Channel<${ty}>.new(${bigCap})!`, `    let done = Channel<i64>.new(4)!`, `    let doneP = done.clone()`);
  const extra = chance(0.5);
  if (extra) L.push(`    var local: Vec<string> = ["a", "b"]`);
  for (let p = 0; p < producers; p++) L.push(`    let tx${p} = ch.clone()`);
  for (let p = 0; p < producers; p++) {
    L.push(`    Task.spawn(move(): void => {`, `        for i in 0..${perProducer} {`, `            let id = ${p * 100} + i`, `            tx${p}.send(${mk("id")})!`, ...(chance(0.5) ? [`            print("sent ", id)`] : []), `        }`, `    })`);
  }
  L.push(`    Task.spawn(move(): void => {`, `        var sum: i64 = 0`, `        for j in 0..${early} {`, `            let m = ch.recv()!`, `            ${show("m")}`, `            sum += j`, `        }`, `        doneP.send(sum)!`, `    })`);
  if (extra) L.push(`    Task.spawn(move(): void => {`, `        local.push("c")`, `        print("local ", local.len)`, `    })`);
  L.push(`    schedulerRunToCompletion()`, `    print("total ", done.recv()!)`, `    return 0`);
  return [...head, `fn main(): i32 {\n${L.join("\n")}\n}`].join("\n\n") + "\n";
}
