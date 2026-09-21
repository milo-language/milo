import { test, expect, describe } from "bun:test";
import { splitModule } from "../src/cgu";

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
