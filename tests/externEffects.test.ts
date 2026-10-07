// The extern effect catalog (src/extern-effects.ts) describes every extern std declares,
// and every description it gives turns into a record/replay wrapper on each target.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import type { Function, Program } from "../src/ast";
import { EXTERN_EFFECTS, externEffect, parseOutSpec } from "../src/extern-effects";
import { planReplayWrappers } from "../src/replay-externs";

const STD = join(import.meta.dir, "..", "std");
const OSES = ["darwin", "linux", "windows"] as const;

// Every std file's extern declarations, by the target whose build reads that file.
function stdExterns(): Map<string, { os: string[]; fn: Function; file: string }[]> {
  const out = new Map<string, { os: string[]; fn: Function; file: string }[]>();
  for (const f of readdirSync(STD).filter(f => f.endsWith(".milo"))) {
    const m = f.match(/\.(darwin|linux|windows|wasm)\.milo$/);
    const os = m ? [m[1]] : [...OSES];
    if (m?.[1] === "wasm") continue;
    const src = readFileSync(join(STD, f), "utf8");
    const prog = new Parser(new Lexer(src).tokenize(), src, join(STD, f)).parse();
    for (const fn of prog.functions) {
      if (!fn.isExtern) continue;
      const list = out.get(fn.name) ?? [];
      list.push({ os, fn, file: f });
      out.set(fn.name, list);
    }
  }
  return out;
}

test("every extern std declares has a catalog entry", () => {
  const missing = [...stdExterns().keys()].filter(n => !externEffect(n));
  expect(missing).toEqual([]);
});

test("the catalog describes nothing std does not declare, and every spec parses", () => {
  const declared = stdExterns();
  const stale = Object.keys(EXTERN_EFFECTS).filter(n => !declared.has(n));
  expect(stale).toEqual([]);
  const bad: string[] = [];
  for (const [name, e] of Object.entries(EXTERN_EFFECTS)) {
    for (const o of e.out ?? []) if (typeof parseOutSpec(o) === "string") bad.push(`${name}: ${o}`);
    if (e.effect === "hole" && !e.why) bad.push(`${name}: a hole needs a why`);
    if (!e.src) bad.push(`${name}: no source`);
  }
  expect(bad).toEqual([]);
});

// A description the generator cannot turn into a wrapper (a size with no value on that
// target, an output through a non-pointer) would silently become a hole; this is what
// makes it a test failure instead.
test("every recorded extern's description generates a wrapper on every target it is declared for", () => {
  const failures: string[] = [];
  for (const os of OSES) {
    for (const arch of os === "linux" ? ["x86_64", "aarch64"] : ["x86_64"]) {
      const fns: Function[] = [];
      const calls: string[] = [];
      for (const [name, decls] of stdExterns()) {
        const d = decls.find(x => x.os.includes(os));
        if (!d) continue;
        fns.push(d.fn);
        const n = d.fn.params.length;
        calls.push(`${name}(${Array.from({ length: n }, () => "0").join(", ")})`);
      }
      // A caller per extern, so every one is planned; the bodies are never checked.
      const src = `fn caller() {\n${calls.map(c => `  ${c}`).join("\n")}\n}\n`;
      const caller = new Parser(new Lexer(src).tokenize(), src, "caller.milo").parse();
      const prog: Program = { ...caller, functions: [...fns, ...caller.functions] };
      const planned = planReplayWrappers([prog], { os, arch });
      for (const [name, plan] of planned?.plans ?? []) {
        if (plan.hole?.includes("cannot be recorded on")) failures.push(`${os}-${arch}: ${name}`);
      }
      // The generated source has to parse; the checker sees it in every recorded build.
      expect(() => new Parser(new Lexer(planned!.source).tokenize(), planned!.source, "<w>").parse()).not.toThrow();
    }
  }
  expect(failures).toEqual([]);
});

// std is held to the holes it documents: a std fn that calls an extern nobody records
// (and that is not one of std's own recording wrappers, `@replayHooked`) shows up here.
// The allowed ones are the dynamic loader, whose loaded code is invisible by nature.
test("std's own extern calls have no replay holes but the documented ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "milo-stdholes-"));
  try {
    for (const [target, os] of [["", "darwin"], ["linux-x64", "linux"], ["windows-x64", "windows"]] as const) {
      // One import per std module available on the target, so every std fn is checked.
      const imports: string[] = [];
      for (const f of readdirSync(STD).filter(f => f.endsWith(".milo"))) {
        const m = f.match(/^(\w+)(?:\.(darwin|linux|windows|wasm))?\.milo$/);
        if (!m || (m[2] && m[2] !== os) || m[1] === "prelude") continue;
        if (!m[2] && existsSync(join(STD, `${m[1]}.${os}.milo`))) continue;
        const first = readFileSync(join(STD, f), "utf8").match(/^pub (?:fn|struct|enum) (\w+)/m);
        if (first) imports.push(`from "std/${m[1]}" import { ${first[1]} }`);
      }
      const file = join(dir, `all-${os}.milo`);
      writeFileSync(file, imports.join("\n") + "\n\nfn main() {\n}\n");
      const args = ["run", join(import.meta.dir, "..", "src", "main.ts"), "check", ...(target ? ["--target", target] : []), "--replay-holes", file];
      const r = spawnSync("bun", args, { encoding: "utf-8" });
      const holes = new Set([...r.stderr.matchAll(/warning\[replay-hole\][^\n]*?'(\w+)' is not recorded/g)].map(m => m[1]));
      expect({ os, holes: [...holes].sort() }).toEqual({ os, holes: os === "windows" ? [] : ["dlopen", "dlsym"] });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
