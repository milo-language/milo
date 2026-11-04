// A typed builder for MLIR's LLVM dialect, as text: the scaffold (src/scaffold.ts) writes its
// functions and globals through it. Values carry their types, so an op is spelled from its
// operands' types and a mismatch is a TypeScript error or a milo-opt verifier error, never
// a silently wrong line.
//
// Symbols are on demand: a function called through `extern(...)` is declared the first time
// a body calls it, and every symbol the builder defines is marked `milo.on_demand`, so
// milo-opt deletes the ones nothing uses (mlir/Link.cpp).

export type LTy = string;
export const I1 = "i1", I8 = "i8", I32 = "i32", I64 = "i64", F32 = "f32", F64 = "f64", PTR = "!llvm.ptr";

export interface LVal { readonly ref: string; readonly ty: LTy }

/** A callable symbol: what a call needs to spell its type. */
export interface Callee { readonly name: string; readonly params: readonly LTy[]; readonly ret: LTy | null; readonly variadic: boolean }

/** An argument attribute dictionary entry, `llvm.nonnull` or `llvm.align = 8 : i64`. */
export type ArgAttrs = readonly string[];

/** `s` as an MLIR string literal body: printable ASCII as is, every other byte as `\XX`. */
export function mlirStringBody(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

export function quoteSym(name: string): string { return /^[A-Za-z_][\w$.]*$/.test(name) ? `@${name}` : `@"${name.replace(/\\/g, "\\5C").replace(/"/g, "\\22")}"`; }

const attrDict = (a: ArgAttrs | undefined) => a && a.length ? ` {${a.join(", ")}}` : "";

export class LlvmModule {
  private readonly items: string[] = [];
  private readonly symbols = new Map<string, Callee | "global">();
  private readonly strings = new Map<string, string>();
  private readonly decls = new Map<string, number>();


  has(name: string): boolean { return this.symbols.has(name); }

  /**
   * Function `name`, declared on its first use unless this module defines it; a second use
   * must agree on its type. The program or the runtime defines what stays a declaration.
   */
  extern(name: string, params: readonly LTy[], ret: LTy | null, opts: { variadic?: boolean; passthrough?: string[]; paramAttrs?: (ArgAttrs | null)[] } = {}): Callee {
    const known = this.symbols.get(name);
    const c: Callee = { name, params, ret, variadic: !!opts.variadic };
    if (known && known !== "global") {
      if (known.params.join() !== params.join() || known.ret !== ret || known.variadic !== c.variadic) throw new Error(`scaffold: ${name} declared with two types`);
      return known;
    }
    if (known) throw new Error(`scaffold: ${name} is a global`);
    this.symbols.set(name, c);
    const ps = [...params.map((p, i) => `${p}${attrDict(opts.paramAttrs?.[i] ?? undefined)}`), ...(opts.variadic ? ["..."] : [])].join(", ");
    const attrs = ["milo.on_demand", ...(opts.passthrough?.length ? [`passthrough = [${opts.passthrough.map(p => `"${p}"`).join(", ")}]`] : [])];
    this.decls.set(name, this.items.length);
    this.items.push(`  llvm.func ${quoteSym(name)}(${ps})${ret ? ` -> ${ret}` : ""} attributes {${attrs.join(", ")}}`);
    return c;
  }

  /** An external data symbol (libc's stdout), declared once. */
  externGlobal(name: string, ty: LTy): string {
    if (this.symbols.has(name)) return name;
    this.symbols.set(name, "global");
    this.items.push(`  llvm.mlir.global external ${quoteSym(name)}() {addr_space = 0 : i32, milo.on_demand} : ${ty}`);
    return name;
  }

  /** A global of scalar type `ty` with initial value `init` (0, or null for a pointer). */
  global(name: string, ty: LTy, opts: { threadLocal?: boolean } = {}): string {
    if (this.symbols.has(name)) return name;
    this.symbols.set(name, "global");
    const tl = opts.threadLocal ? "thread_local " : "";
    if (ty === PTR) {
      this.items.push(`  llvm.mlir.global internal ${tl}${quoteSym(name)}() {addr_space = 0 : i32, milo.on_demand} : ${PTR} {`,
        `    %0 = llvm.mlir.zero : ${PTR}`, `    llvm.return %0 : ${PTR}`, `  }`);
    } else {
      this.items.push(`  llvm.mlir.global internal ${tl}${quoteSym(name)}(0 : ${ty}) {addr_space = 0 : i32, milo.on_demand} : ${ty}`);
    }
    return name;
  }

  /** A NUL-terminated private constant holding `text` (UTF-8), one per distinct text. */
  str(text: string): string {
    const known = this.strings.get(text);
    if (known) return known;
    const name = `milo.scaffold.s.${this.strings.size}`;
    this.strings.set(text, name);
    this.symbols.set(name, "global");
    const bytes = new TextEncoder().encode(text + "\0");
    this.items.push(`  llvm.mlir.global private unnamed_addr constant ${quoteSym(name)}("${mlirStringBody(bytes)}") {addr_space = 0 : i32, milo.on_demand}`);
    return name;
  }

  /**
   * A function defined here. `internal` unless `external` (the process entry); `keep` leaves
   * it out of the on-demand set (something outside the module's text calls it).
   */
  fn(name: string, params: { ty: LTy; attrs?: ArgAttrs }[], ret: LTy | null, opts: { external?: boolean; passthrough?: string[]; keep?: boolean } = {}): LlvmFn {
    const c: Callee = { name, params: params.map(p => p.ty), ret, variadic: false };
    // A body that called it first declared it; the definition replaces that declaration.
    const decl = this.decls.get(name);
    if (decl !== undefined) {
      const known = this.symbols.get(name) as Callee;
      if (known.params.join() !== c.params.join() || known.ret !== ret) throw new Error(`scaffold: ${name} declared and defined with two types`);
      this.items[decl] = "";
      this.decls.delete(name);
    } else if (this.symbols.has(name)) throw new Error(`scaffold: ${name} defined twice`);
    this.symbols.set(name, c);
    const f = new LlvmFn(c);
    const attrs = [...(opts.keep || opts.external ? [] : ["milo.on_demand"]), ...(opts.passthrough?.length ? [`passthrough = [${opts.passthrough.map(p => `"${p}"`).join(", ")}]`] : [])];
    f.head = `  llvm.func ${opts.external ? "" : "internal "}${quoteSym(name)}(${params.map((p, i) => `%a${i}: ${p.ty}${attrDict(p.attrs)}`).join(", ")})${ret ? ` -> ${ret}` : ""}${attrs.length ? ` attributes {${attrs.join(", ")}}` : ""} {`;
    f.onDone = text => this.items.push(text);
    return f;
  }

  /** The callee of a function this module defines or declares. */
  callee(name: string): Callee {
    const c = this.symbols.get(name);
    if (!c || c === "global") throw new Error(`scaffold: no function ${name}`);
    return c;
  }

  text(): string { return `  module @milo.scaffold {\n${this.items.filter(l => l).map(l => `  ${l}`).join("\n")}\n  }\n`; }
}

export class LlvmFn {
  head = "";
  onDone: (text: string) => void = () => {};
  private readonly lines: string[] = [];
  private n = 0;
  private blocks = 0;
  readonly params: LVal[];

  constructor(readonly callee: Callee) {
    this.params = callee.params.map((ty, i) => ({ ref: `%a${i}`, ty }));
  }

  private op(text: string): void { this.lines.push(`    ${text}`); }
  private def(text: string, ty: LTy): LVal {
    const ref = `%v${this.n++}`;
    this.op(`${ref} = ${text}`);
    return { ref, ty };
  }

  /** A fresh block label; the entry block is the function's first and has none. */
  block(hint: string): string { return `^${hint.replace(/[^\w]/g, "_")}${this.blocks++}`; }
  at(label: string): void { this.lines.push(`  ${label}:`); }

  int(ty: LTy, v: number | bigint): LVal { return this.def(`llvm.mlir.constant(${v} : ${ty}) : ${ty}`, ty); }
  null(): LVal { return this.def(`llvm.mlir.zero : ${PTR}`, PTR); }
  addr(sym: string): LVal { return this.def(`llvm.mlir.addressof ${quoteSym(sym)} : ${PTR}`, PTR); }

  load(ty: LTy, p: LVal, o: { align?: number; atomic?: "acquire" | "seq_cst" } = {}): LVal {
    const atomic = o.atomic ? ` atomic ${o.atomic}` : "";
    const align = o.align ? ` {alignment = ${o.align} : i64}` : "";
    return this.def(`llvm.load ${p.ref}${atomic}${align} : ${PTR} -> ${ty}`, ty);
  }
  store(v: LVal, p: LVal, o: { align?: number; atomic?: "release" | "seq_cst" } = {}): void {
    const atomic = o.atomic ? ` atomic ${o.atomic}` : "";
    const align = o.align ? ` {alignment = ${o.align} : i64}` : "";
    this.op(`llvm.store ${v.ref}, ${p.ref}${atomic}${align} : ${v.ty}, ${PTR}`);
  }
  icmp(pred: "eq" | "ne" | "sgt" | "slt" | "sge", a: LVal, b: LVal): LVal { return this.def(`llvm.icmp "${pred}" ${a.ref}, ${b.ref} : ${a.ty}`, I1); }
  bin(op: "add" | "sub" | "and" | "or", a: LVal, b: LVal): LVal { return this.def(`llvm.${op} ${a.ref}, ${b.ref} : ${a.ty}`, a.ty); }
  trunc(v: LVal, ty: LTy): LVal { return this.def(`llvm.trunc ${v.ref} : ${v.ty} to ${ty}`, ty); }
  ptrToInt(v: LVal): LVal { return this.def(`llvm.ptrtoint ${v.ref} : ${PTR} to ${I64}`, I64); }
  extract(v: LVal, i: number, ty: LTy): LVal { return this.def(`llvm.extractvalue ${v.ref}[${i}] : ${v.ty}`, ty); }
  /** A sequentially consistent compare-and-swap: `{ old, won }`. */
  cmpxchg(p: LVal, cmp: LVal, next: LVal, align: number): { old: LVal; won: LVal } {
    const pair = this.def(`llvm.cmpxchg ${p.ref}, ${cmp.ref}, ${next.ref} seq_cst seq_cst {alignment = ${align} : i64} : ${PTR}, ${cmp.ty}`, `!llvm.struct<(${cmp.ty}, i1)>`);
    return { old: this.extract(pair, 0, cmp.ty), won: this.extract(pair, 1, I1) };
  }
  atomicAdd(p: LVal, v: LVal): LVal { return this.def(`llvm.atomicrmw add ${p.ref}, ${v.ref} monotonic : ${PTR}, ${v.ty}`, v.ty); }
  alloca(ty: LTy, align: number): LVal {
    const one = this.int(I64, 1);
    return this.def(`llvm.alloca ${one.ref} x ${ty} {alignment = ${align} : i64} : (${I64}) -> ${PTR}`, PTR);
  }
  /** `p` plus `bytes`. */
  offset(p: LVal, bytes: number): LVal { return bytes === 0 ? p : this.def(`llvm.getelementptr inbounds ${p.ref}[${bytes}] : (${PTR}) -> ${PTR}, i8`, PTR); }

  call(c: Callee, args: LVal[], o: { argAttrs?: (ArgAttrs | null)[]; nobuiltin?: boolean } = {}): LVal | null {
    const fixed = args.slice(0, c.params.length);
    fixed.forEach((a, i) => { if (a.ty !== c.params[i]) throw new Error(`scaffold: ${c.name} arg ${i} is ${a.ty}, wants ${c.params[i]}`); });
    if (args.length !== c.params.length && !c.variadic) throw new Error(`scaffold: ${c.name} takes ${c.params.length} args`);
    const vararg = c.variadic ? ` vararg(!llvm.func<${c.ret ?? "void"} (${[...c.params.map(t => t === PTR ? "ptr" : t), "..."].join(", ")})>)` : "";
    const extra: string[] = [];
    if (o.argAttrs) extra.push(`arg_attrs = [${args.map((_, i) => `{${(o.argAttrs![i] ?? []).join(", ")}}`).join(", ")}]`);
    if (o.nobuiltin) extra.push("nobuiltin");
    const text = `llvm.call ${quoteSym(c.name)}(${args.map(a => a.ref).join(", ")})${vararg}${extra.length ? ` {${extra.join(", ")}}` : ""} : (${args.map(a => a.ty).join(", ")}) -> ${c.ret ?? "()"}`;
    if (c.ret === null) { this.op(text); return null; }
    return this.def(text, c.ret);
  }
  /** A call through a code pointer. */
  callPtr(fp: LVal, args: LVal[], ret: LTy | null): LVal | null {
    const text = `llvm.call ${fp.ref}(${args.map(a => a.ref).join(", ")}) : ${PTR}, (${args.map(a => a.ty).join(", ")}) -> ${ret ?? "()"}`;
    if (ret === null) { this.op(text); return null; }
    return this.def(text, ret);
  }

  br(label: string): void { this.op(`llvm.br ${label}`); }
  condBr(c: LVal, t: string, f: string): void { this.op(`llvm.cond_br ${c.ref}, ${t}, ${f}`); }
  ret(v?: LVal | null): void { this.op(v ? `llvm.return ${v.ref} : ${v.ty}` : "llvm.return"); }
  unreachable(): void { this.op("llvm.unreachable"); }

  done(): void { this.onDone([this.head, ...this.lines, "  }"].join("\n")); }
}
