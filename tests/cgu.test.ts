import { test, expect, describe } from "bun:test";
import { splitModule, selectHot, type SplitStats } from "../src/cgu";

// A module with enough functions to clear splitModule's "too small to bother" floor
// (units * 4). Bodies differ in length so the bin packer has something to balance.
function synth(fnCount: number, opts: { shared?: boolean; embed?: boolean } = {}): string {
  const out: string[] = [`target triple = "arm64-apple-macosx26.0.0"`, `%String = type { ptr, i64, i64 }`];
  out.push(`@.str.shared = private unnamed_addr constant [6 x i8] c"hi\\00\\00\\00\\00"`);
  if (opts.embed) {
    // A byte payload containing an `@` and a `c"` lookalike: rewriting inside it would
    // corrupt the program's own data.
    out.push(`@.asset = private unnamed_addr constant [9 x i8] c"a@b c\\22d\\00\\00"`);
  }
  out.push(`declare i32 @puts(ptr)`);
  for (let i = 0; i < fnCount; i++) {
    out.push(`define internal i32 @fn${i}(ptr %p) {`);
    out.push(`entry:`);
    // Every function touches the same private constant, so it must be promoted.
    if (opts.shared) out.push(`  %s = getelementptr [6 x i8], ptr @.str.shared, i64 0, i64 0`);
    for (let j = 0; j < (i % 5) + 1; j++) out.push(`  %v${j} = add i32 ${i}, ${j}`);
    // Cross-references so some callee lands in another unit.
    if (i > 0) out.push(`  %c = call i32 @fn${i - 1}(ptr %p)`);
    out.push(`  ret i32 0`);
    out.push(`}`);
  }
  out.push(`define i32 @main() {`, `entry:`, `  %r = call i32 @fn0(ptr null)`, `  ret i32 %r`, `}`);
  return out.join("\n") + "\n";
}

// `synth` with a module prefix on the first `count` functions: `json$fn0`, `json$fn1`, ...
function synthModule(fnCount: number, count: number, name = "json"): string {
  return synth(fnCount).replace(/@fn(\d+)\b/g, (whole, n: string) => (Number(n) < count ? `@${name}$fn${n}` : whole));
}

const DEFINE_RE = /^define\b.*?@([-a-zA-Z$._][-a-zA-Z$._0-9]*)\s*\(/gm;

function definedIn(mod: string): string[] {
  return [...mod.matchAll(DEFINE_RE)].map(m => m[1]!);
}

describe("cgu splitter", () => {
  test("every function is defined in exactly one unit", () => {
    const mods = splitModule(synth(40), 4)!;
    expect(mods).not.toBeNull();
    const all = mods.flatMap(definedIn);
    expect(all.length).toBe(41); // 40 + main
    expect(new Set(all).size).toBe(all.length);
  });

  test("a symbol a unit calls but does not define is declared there", () => {
    const mods = splitModule(synth(40), 4)!;
    for (const mod of mods) {
      const defined = new Set(definedIn(mod));
      const declared = new Set([...mod.matchAll(/^declare\b.*?@([-a-zA-Z$._][-a-zA-Z$._0-9]*)\s*\(/gm)].map(m => m[1]!));
      for (const m of mod.matchAll(/call \w[\w<>{} *]*? @([-a-zA-Z$._][-a-zA-Z$._0-9]*)\(/g)) {
        const callee = m[1]!;
        expect(defined.has(callee) || declared.has(callee)).toBe(true);
      }
    }
  });

  // The reason promotion renames rather than just dropping `internal`: an internal Milo
  // function can share a name with a libc symbol, and making it globally visible under
  // that name would let the linker resolve someone else's call into it.
  test("a promoted symbol keeps module-local linkage nowhere and is renamed everywhere", () => {
    const mods = splitModule(synth(40, { shared: true }), 4)!;
    const joined = mods.join("\n");
    expect(joined).toContain("@__milo_cgu..str.shared");
    // No unit may still define it as private/internal — that would leave the other units
    // referencing a symbol the linker cannot see.
    expect(joined).not.toMatch(/@__milo_cgu\.\.str\.shared = (?:private|internal)\b/);
    // Exactly one definition, the rest declarations.
    const defs = [...joined.matchAll(/^@__milo_cgu\.\.str\.shared = (?!external)/gm)];
    expect(defs.length).toBe(1);
  });

  test("byte-string payloads are copied verbatim", () => {
    const mods = splitModule(synth(40, { embed: true }), 4)!;
    const payload = `c"a@b c\\22d\\00\\00"`;
    const carriers = mods.filter(m => m.includes(payload));
    expect(carriers.length).toBe(1);
    // The `@b` inside the payload must not have been treated as a symbol reference.
    expect(mods.join("\n")).not.toContain("@__milo_cgu.b");
  });

  // A trait object's itable is a global whose initializer names functions. The unit that
  // holds the itable must be able to see each of them.
  test("a function named only by a global's initializer is visible in that global's unit", () => {
    const ir = synth(40).replace(`declare i32 @puts(ptr)`, `@itable = private unnamed_addr constant { ptr, ptr } { ptr @fn5, ptr null }\ndeclare i32 @puts(ptr)`)
      .replace(`%r = call i32 @fn0(ptr null)`, `%r = call i32 @fn0(ptr @itable)`);
    for (let units = 2; units <= 8; units++) {
      const mods = splitModule(ir, units)!;
      const holder = mods.find(m => /^@itable = /m.test(m))!;
      const fn5 = /@(__milo_cgu\.)?fn5\b/.exec(holder.match(/^@itable = .*$/m)![0])![0].slice(1);
      expect(definedIn(holder).includes(fn5) || new RegExp(`^declare .*@${fn5.replace(/\./g, "\\.")}\\(`, "m").test(holder)).toBe(true);
    }
  });

  test("declines rather than dropping an unrecognized top-level construct", () => {
    const ir = synth(40) + `\nmodule asm "nop"\n`;
    expect(splitModule(ir, 4)).toBeNull();
  });

  test("declines when there is not enough work to divide", () => {
    expect(splitModule(synth(4), 4)).toBeNull();
    expect(splitModule(synth(40), 1)).toBeNull();
  });

  test("aggregate types survive the extern-declaration rewrite", () => {
    const mods = splitModule(synth(40, { shared: true }), 4)!;
    // `[6 x i8]` must arrive intact — a naive \S+ type scan yields `[6` and the unit does
    // not parse.
    for (const mod of mods) {
      for (const m of mod.matchAll(/^@\S+ = external .*$/gm)) {
        expect(m[0]).toMatch(/\[6 x i8\]$/);
      }
    }
  });

  test("units are balanced by body size, not function count", () => {
    const mods = splitModule(synth(80), 4)!;
    const sizes = mods.map(m => m.split("\n").length);
    const spread = Math.max(...sizes) / Math.min(...sizes);
    expect(spread).toBeLessThan(1.5);
  });

  // Promotion renames a module-local symbol to `__milo_cgu.<name>`, so strip that before
  // reading the module prefix.
  const unitsOf = (mods: string[], prefix: string) =>
    new Set(mods.flatMap((m, u) => definedIn(m).some(n => n.replace(/^__milo_cgu\./, "").startsWith(`${prefix}$`)) ? [u] : []));

  test("functions of one small module share a unit", () => {
    // 10 of 80 functions are `json$...`: well under a unit's share, so they stay together.
    const mods = splitModule(synthModule(80, 10), 4)!;
    expect(unitsOf(mods, "json").size).toBe(1);
  });

  test("an oversize module is split and units remain balanced", () => {
    // 60 of 80 functions in one module: placing it whole would put ~75% of the program on
    // one unit, so it falls back to per-function packing.
    const mods = splitModule(synthModule(80, 60), 4)!;
    expect(unitsOf(mods, "json").size).toBeGreaterThan(1);
    const sizes = mods.map(m => m.split("\n").length);
    const spread = Math.max(...sizes) / Math.min(...sizes);
    expect(spread).toBeLessThan(1.5);
  });
});

describe("hot unit", () => {
  const fns = (spec: [string, string, number][]) => spec.map(([name, text, lineCount]) => ({ name, text, lineCount }));
  // 8 functions at 4 units; with 10-line bodies the share is 20 lines and the cap 10.
  const base = fns(Array.from({ length: 8 }, (_, i) => [`f${i}`, `body${i}`, 10] as [string, string, number]));
  const edit = (fs: typeof base, name: string, text: string) => fs.map(f => f.name === name ? { ...f, text } : f);

  test("no previous state makes nothing hot", () => {
    expect(selectHot(base, 4, null).hot).toEqual([]);
  });

  test("a changed or new function becomes hot, most recent last", () => {
    // 1-line bodies at 2 units: cap 2 lines, room for two hot functions.
    const small = base.map(f => ({ ...f, lineCount: 1 }));
    const s0 = selectHot(small, 2, null);
    const s1 = selectHot(edit(small, "f3", "edited"), 2, s0);
    expect(s1.hot).toEqual(["f3"]);
    const added = [...edit(small, "f3", "edited"), { name: "g", text: "new", lineCount: 1 }];
    const s2 = selectHot(added, 2, s1);
    expect(s2.hot).toEqual(["f3", "g"]);
    // Re-editing f3 moves it to the back.
    const s3 = selectHot(edit(added, "f3", "again"), 2, s2);
    expect(s3.hot).toEqual(["g", "f3"]);
    // A deleted function drops out.
    const s4 = selectHot(edit(small, "f3", "again"), 2, s3);
    expect(s4.hot).toEqual(["f3"]);
  });

  test("the oldest hot functions are evicted past the line cap", () => {
    // 6-line functions against a 12-line cap (48 lines, 2 units): two fit, not three.
    const sized = base.map(f => ({ ...f, lineCount: 6 }));
    let s = selectHot(sized, 2, null);
    s = selectHot(edit(sized, "f1", "a"), 2, s);
    s = selectHot(edit(sized, "f2", "b"), 2, s);
    expect(s.hot).toEqual(["f1", "f2"]);
    s = selectHot(edit(sized, "f3", "c"), 2, s);
    expect(s.hot).toEqual(["f2", "f3"]);
  });

  test("the hot set holds at most 64 functions", () => {
    const many = fns(Array.from({ length: 400 }, (_, i) => [`f${i}`, `b${i}`, 1] as [string, string, number]));
    let s = selectHot(many, 2, null);
    for (let i = 0; i < 70; i++) s = selectHot(edit(many, `f${i}`, `e${i}`), 2, s);
    expect(s.hot.length).toBe(64);
    expect(s.hot[0]).toBe("f6");
    expect(s.hot[63]).toBe("f69");
  });

  test("a change larger than the bounds clears the hot set", () => {
    let s = selectHot(base, 4, null);
    s = selectHot(edit(base, "f0", "x"), 4, s);
    expect(s.hot).toEqual(["f0"]);
    // Every body changes at once: 80 lines against a 10-line cap.
    s = selectHot(base.map(f => ({ ...f, text: f.text + "!" })), 4, s);
    expect(s.hot).toEqual([]);
  });

  test("an empty hot set produces exactly the output of the no-hot path", () => {
    const ir = synth(40, { shared: true });
    const plain = splitModule(ir, 4)!;
    const st: { out?: SplitStats } = {};
    expect(splitModule(ir, 4, st, undefined, { prev: null, enabled: true })).toEqual(plain);
    expect(st.out!.hot!.hot).toEqual([]);
    // Unchanged program with a previous state: still nothing hot, still identical.
    const again = splitModule(ir, 4, undefined, st.out!.placement, { prev: st.out!.hot!, enabled: true });
    expect(again).toEqual(splitModule(ir, 4, undefined, st.out!.placement)!);
  });

  const stripPromo = (n: string) => n.replace(/^__milo_cgu\./, "");
  const homeOf = (mods: string[]) => new Map(mods.flatMap((m, u) => definedIn(m).map(n => [stripPromo(n), u] as const)));
  // Changes fn7's body and nothing else.
  const editFn7 = (ir: string, k = 99) => ir.replace("%v0 = add i32 7, 0", `%v0 = add i32 7, ${k}`);

  test("a hot function moves to an extra unit and every other function stays put", () => {
    const ir = synth(40, { shared: true });
    const st: { out?: SplitStats } = {};
    const before = splitModule(ir, 4, st, undefined, { prev: null, enabled: true })!;
    const st2: { out?: SplitStats } = {};
    const after = splitModule(editFn7(ir), 4, st2, st.out!.placement, { prev: st.out!.hot!, enabled: true })!;
    expect(st2.out!.hot!.hot).toEqual(["fn7"]);
    expect(st2.out!.units).toBe(5);
    expect(after.length).toBe(5);
    expect(definedIn(after[4]!).map(stripPromo)).toEqual(["fn7"]);
    const h0 = homeOf(before), h1 = homeOf(after);
    for (const [name, u] of h0) if (name !== "fn7") expect(h1.get(name)).toBe(u);
    // A second edit to fn7 changes the hot unit and nothing else.
    const after2 = splitModule(editFn7(ir, 98), 4, undefined, st2.out!.placement, { prev: st2.out!.hot!, enabled: true })!;
    for (let u = 0; u < 4; u++) expect(after2[u]).toBe(after[u]!);
    expect(after2[4]).not.toBe(after[4]!);
  });

  test("disabled places nothing hot and forgets the hot set", () => {
    const ir = synth(40);
    const st: { out?: SplitStats } = {};
    splitModule(ir, 4, st, undefined, { prev: null, enabled: true });
    const st2: { out?: SplitStats } = {};
    const off = splitModule(editFn7(ir), 4, st2, st.out!.placement, { prev: st.out!.hot!, enabled: false })!;
    expect(off.length).toBe(4);
    expect(st2.out!.hot!.hot).toEqual([]);
  });

  test("an evicted function returns to the unit it left", () => {
    const ir = synth(40);
    const st: { out?: SplitStats } = {};
    const before = splitModule(ir, 4, st, undefined, { prev: null, enabled: true })!;
    const st2: { out?: SplitStats } = {};
    splitModule(editFn7(ir), 4, st2, st.out!.placement, { prev: st.out!.hot!, enabled: true });
    // The stored placement still remembers fn7's old unit while fn7 is hot; packing would
    // otherwise treat it as new and send it to whichever unit is least loaded.
    expect(st2.out!.placement!.get("fn7")).toBe(st.out!.placement!.get("fn7"));
    // The original source with the hot set disabled: every unit byte-identical to the
    // first build, so all of their objects are cache hits.
    const back = splitModule(ir, 4, undefined, st2.out!.placement, { prev: st2.out!.hot!, enabled: false })!;
    expect(back).toEqual(before);
  });
});
