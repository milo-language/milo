#!/usr/bin/env bun
// Generates src/interp-gen.ts: a generator twin (`name$g`) of every interpreter function that can
// reach a task switch, so the task interpreter (src/interp-co.ts) can suspend a task anywhere in the
// middle of an expression without a second hand-written evaluator. The plain interpreter keeps its
// plain functions, so a program with no tasks pays nothing.
//
//   bun scripts/gen-interp-co.ts           # rewrite src/interp-gen.ts
//   bun scripts/gen-interp-co.ts --check   # exit 1 if it is stale (the gate in tests/interp.test.ts)
//
// A "unit" is a method of class Interp (src/interp.ts) or a top-level `function` in
// src/interp-natives.ts. A unit is a "suspender" when it calls `runNative` (the one place a task
// operation runs) or calls another suspender; every call to a suspender inside a suspender becomes
// `(yield* callee$g(...))`. A suspender called from inside an arrow function cannot yield, so the
// script fails there: rewrite the source as a loop, or as a thunk `() => this.f(x)` handed to a
// local named in THUNK_PARAMS or called as `arm.run()` (the twin's thunk returns the generator and the
// consumer yields it through runThunk, which also accepts a plain value).
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const OUT = join(SRC, "interp-gen.ts");
const SEEDS = new Set(["runNative"]);
// user Drop bodies run as plain calls: a drop that parks its task is reported unsupported
const EXCLUDE = new Set(["userDrop", "globalSlot", "run", "runMain"]);
// parameters / locals holding a thunk that returns a generator in the twin
const THUNK_PARAMS = new Set(["arg0", "recv"]);
// calls of a thunk stored in a property: `arm.run()`
const THUNK_CALL = /^arm\.run\(/;

interface Unit { name: string; file: "interp" | "interp-natives"; kind: "method" | "fn"; text: string; exported: boolean }

function findUnits(file: "interp" | "interp-natives"): Unit[] {
  const lines = readFileSync(join(SRC, file + ".ts"), "utf-8").split("\n");
  const units: Unit[] = [];
  let inClass = file === "interp-natives";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (file === "interp" && /^export class Interp \{/.test(l)) { inClass = true; continue; }
    if (file === "interp" && inClass && l === "}") inClass = false;
    if (!inClass) continue;
    const m = file === "interp"
      ? /^  (?:private )?([A-Za-z_$][\w$]*)(?:<[^>]*>)?\(/.exec(l)
      : /^(export )?function ([A-Za-z_$][\w$]*)(?:<[^>]*>)?\(/.exec(l);
    if (!m) continue;
    const name = file === "interp" ? m[1]! : m[2]!;
    if (name === "constructor") continue;
    const end = file === "interp" ? "  }" : "}";
    let j = i;
    if (!/\{\s*$/.test(l)) { if (!/\}\s*$/.test(l)) throw new Error(`${file}:${i + 1}: signature of ${name} spans lines`); }
    else { j = i + 1; while (lines[j] !== end) j++; }
    units.push({ name, file, kind: file === "interp" ? "method" : "fn", text: lines.slice(i, j + 1).join("\n"), exported: file === "interp" ? true : !!m[1] });
    i = j;
  }
  return units;
}

// index of the `)` matching the `(` at `open`, skipping strings, template literals and comments
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"') { for (i++; s[i] !== c; i++) if (s[i] === "\\") i++; }
    else if (c === "`") { i = skipTemplate(s, i); }
    else if (c === "/" && s[i + 1] === "/") { while (s[i] !== "\n") i++; }
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Error("unbalanced paren");
}
function skipTemplate(s: string, start: number): number {
  let i = start + 1;
  for (; s[i] !== "`"; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "$" && s[i + 1] === "{") { let d = 0; for (i++; ; i++) { if (s[i] === "{") d++; else if (s[i] === "}" && --d === 0) break; } }
  }
  return i;
}

// ranges [start,end) of arrow-function bodies in `s`
function arrowBodies(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = s.indexOf("=>"); i >= 0; i = s.indexOf("=>", i + 2)) {
    let b = i + 2;
    while (s[b] === " ") b++;
    let e = b, depth = 0;
    if (s[b] === "{") { e = b; for (; ; e++) { if (s[e] === "{") depth++; else if (s[e] === "}" && --depth === 0) { e++; break; } } }
    else {
      for (; e < s.length; e++) {
        const c = s[e]!;
        if (c === "'" || c === '"') { for (e++; s[e] !== c; e++) if (s[e] === "\\") e++; }
        else if (c === "`") e = skipTemplate(s, e);
        else if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
        else if ((c === "," || c === ";") && depth === 0) break;
      }
    }
    out.push([b, e]);
  }
  return out;
}

function generate(): string {
  const units = [...findUnits("interp"), ...findUnits("interp-natives")];
  const byName = new Map<string, Unit>();
  for (const u of units) { if (byName.has(u.name)) throw new Error(`duplicate unit ${u.name}`); byName.set(u.name, u); }
  const suspend = new Set<string>(SEEDS);
  // a seed is any method whose name is a seed; callers of units already in the set join it
  for (let changed = true; changed;) {
    changed = false;
    for (const u of units) {
      if (suspend.has(u.name) || EXCLUDE.has(u.name)) continue;
      for (const s of suspend) {
        const callee = byName.get(s);
        // methods are called as this.x( / it.x(; free functions as x( with the interpreter as an argument
        const re = callee?.kind === "fn" ? new RegExp(`(?<![.\\w$])${s}\\(`) : new RegExp(`\\b(?:this|it)\\.${s}\\(`);
        if (re.test(u.text)) { suspend.add(u.name); changed = true; break; }
      }
    }
  }
  if (process.env.GEN_DEBUG) console.error([...suspend].join(" "));
  for (const s of SEEDS) if (!byName.has(s)) throw new Error(`seed ${s} not found`);

  const twinCall = (text: string, errs: string[], who: string): string => {
    const arrows = arrowBodies(text);
    let out = "";
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const tc = THUNK_CALL.exec(rest);
      if (tc && (i === 0 || !/[\w$.]/.test(text[i - 1]!))) {
        const open = i + tc[0].length - 1;
        const close = matchParen(text, open);
        out += "(yield* runThunk(" + text.slice(i, open + 1) + twinCall(text.slice(open + 1, close), errs, who) + ")))";
        i = close + 1;
        continue;
      }
      const m = /^(?:(?:this|it)\.([A-Za-z_$][\w$]*)|(?<![.\w$])([A-Za-z_$][\w$]*))(?:<[A-Za-z_$][\w$<>\[\]{}:;, |&.]*>)?\(/.exec(rest);
      const prevOk = i === 0 || !/[\w$.]/.test(text[i - 1]!) || m?.[0].startsWith("this.") || m?.[0].startsWith("it.");
      const name = m ? m[1] ?? m[2]! : "";
      const callee = m && prevOk ? byName.get(name) : undefined;
      const isMethodCall = !!m && (m[0].startsWith("this.") || m[0].startsWith("it."));
      const hit = callee && suspend.has(name) && (isMethodCall ? callee.kind === "method" : callee.kind === "fn");
      const thunk = m && prevOk && !isMethodCall && THUNK_PARAMS.has(name);
      if (m && prevOk && (hit || thunk)) {
        const open = i + m[0].length - 1;
        const close = matchParen(text, open);
        const inner = twinCall(text.slice(open + 1, close), errs, who);
        const inArrow = arrows.some(([a, b]) => i >= a && i < b);
        if (hit && inArrow) {
          // `() => this.f(x)` as a whole thunk body is fine: it returns the generator
          const [a, b] = arrows.filter(([a2, b2]) => i >= a2 && i < b2).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))[0]!;
          const callText = text.slice(i, close + 1).trim(), bodyText = text.slice(a, b).trim();
          const whole = bodyText.startsWith(callText) && /^\s*(as \w+\s*)?$/.test(bodyText.slice(callText.length));
          if (!whole) errs.push(`${who}: ${name}() inside an arrow function`);
          out += (isMethodCall ? m[0].replace(name, name + "$g") : name + "$g(") + inner + ")";
        } else if (hit) {
          out += "(yield* " + (isMethodCall ? m[0].replace(name, name + "$g") : name + "$g(") + inner + "))";
        } else out += "(yield* runThunk(" + name + "(" + inner + ")))";
        i = close + 1;
        continue;
      }
      out += text[i];
      i++;
    }
    return out;
  };

  const errs: string[] = [];
  const methods: string[] = [];
  const fns: string[] = [];
  for (const u of units) {
    if (!suspend.has(u.name) || SEEDS.has(u.name)) continue;
    const lines = u.text.split("\n");
    const sig = lines[0]!;
    const body = twinCall(lines.slice(1).join("\n"), errs, u.name);
    // signature: rename, drop the return type, make it a generator
    const rename = (s: string) => s.replace(new RegExp(`\\b${u.name}(<[^>]*>)?\\(`), `${u.name}$g(`);
    let head = rename(sig).replace(/^(\s*)(?:private )?/, "$1").replace(/^(\s*)(export )?function /, "$1$2function* ");
    if (u.kind === "method") head = head.replace(/^(\s*)/, "$1*");
    head = head.replace(/\): [^{]*\{(.*)$/, ") : Gen {$1".replace(") :", "):"));
    // a single-line unit keeps its body on the signature line
    if (lines.length === 1) { errs.push(`${u.name}: single-line suspender: expand it in the source`); continue; }
    (u.kind === "method" ? methods : fns).push([head.replace(/\(it: Interp,/, "(it: InterpGen,").replace(/\bR\b/g, "any"), body.replace(/\$g<[^()]*?>\(/g, "$g(")].join("\n"));
  }
  // A call the rewrite missed would run the plain version and hand a generator back as a value.
  for (const t of [...methods, ...fns]) {
    for (const s of suspend) {
      const left = new RegExp(`\\b(?:this|it)\\.${s}\\b(?!\\$g)`).exec(t);
      if (left && !SEEDS.has(s)) errs.push(`a plain call of ${s} is left in a twin: ${t.split("\n")[0]!.trim()}`);
    }
  }
  if (errs.length) throw new Error("cannot generate:\n  " + errs.join("\n  "));

  // import every module-level name the twins mention from the file declaring it
  const topLevel = (file: string): Map<string, boolean> => {
    const m = new Map<string, boolean>();
    for (const l of readFileSync(join(SRC, file + ".ts"), "utf-8").split("\n")) {
      const d = /^(export )?(?:abstract )?(?:declare )?(const|let|var|function\*?|class|interface|type|enum) ([A-Za-z_$][\w$]*)/.exec(l);
      if (d) { m.set(d[3]!, !!d[1]); if (d[2] === "interface" || d[2] === "type") typeNames.add(d[3]!); }
    }
    return m;
  };
  const typeNames = new Set<string>();
  // the one place a native runs: the task interpreter overrides this stand-in to yield for a task operation
  methods.unshift("  *runNative$g(nat: Native, args: Value[], e?: Expr): Gen { return this.runNative(nat, args, e); }");
  const code = [...methods, ...fns].join("\n");
  // names inside strings and comments do not count as uses
  const bare = code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\/.*$/gm, '""');
  const imports: string[] = [];
  const missing: string[] = [];
  for (const file of ["interp", "interp-natives", "interp-values"] as const) {
    const names = [...topLevel(file)].filter(([n]) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}\\b`).test(bare) && !(file === "interp" && n === "Interp"));
    for (const [n, exp] of names) if (!exp && !suspend.has(n)) missing.push(`${file}.ts: export ${n}`);
    const ok = names.filter(([n, e]) => e && !suspend.has(n) && n !== "nat").map(([n]) => n);
    const types = ok.filter(n => typeNames.has(n)), values = ok.filter(n => !typeNames.has(n));
    if (values.length) imports.push(`import { ${values.join(", ")} } from "./${file}";`);
    if (types.length) imports.push(`import type { ${types.join(", ")} } from "./${file}";`);
  }
  if (missing.length) throw new Error("add `export` to:\n  " + missing.join("\n  "));
  // the original's imports, cut down to the names the twins use (an unused import is a type error under noUnusedLocals)
  const used = (n: string) => new RegExp(`(?<![\\w$.])${n}\\b`).test(bare);
  const outside = /^import (?:type )?\{[^}]*\} from "(?:\.\/(?:ast|types|checker|interp-mem|interp-sys)|path)";$/gm;
  const valueImports = [...new Set(["interp", "interp-natives"].flatMap(f => readFileSync(join(SRC, f + ".ts"), "utf-8").match(outside) ?? []))].flatMap(stmt => {
    const kept = /\{([^}]*)\}/.exec(stmt)![1]!.split(",").map(x => x.trim()).filter(x => x && used(x.replace(/^type /, "").split(" as ").pop()!));
    const spec = /from "([^"]+)"/.exec(stmt)![1]!;
    return kept.map(k => ({ spec, name: stmt.startsWith("import type") && !k.startsWith("type ") ? `type ${k}` : k }));
  });
  // one import per module, each name once (a name both files import is kept once, as a value if either does)
  const byModule = new Map<string, Map<string, string>>();
  for (const { spec, name } of valueImports) {
    const key = name.replace(/^type /, "");
    const m = byModule.get(spec) ?? new Map<string, string>();
    if (!m.has(key) || m.get(key)!.startsWith("type ")) m.set(key, name);
    byModule.set(spec, m);
  }
  const mergedImports = [...byModule].map(([spec, m]) => `import { ${[...m.values()].join(", ")} } from "${spec}";`);
  return `// GENERATED by scripts/gen-interp-co.ts from src/interp.ts and src/interp-natives.ts. Do not edit.
// Generator twins (\`name$g\`) of every function that can reach a task switch; see the script header.
${mergedImports.join("\n")}

import { Interp } from "./interp";
${imports.join("\n")}

export type Gen<T = any> = Generator<unknown, T, unknown>;
// a thunk handed to a consumer returns a generator in the twin, or a plain value when it had nothing to suspend on
function* runThunk(v: any): Gen { return v && typeof v === "object" && typeof v.next === "function" && typeof v.throw === "function" ? yield* v : v; }

export class InterpGen extends Interp {
${methods.join("\n")}
}

${fns.join("\n")}
`;
}

if (import.meta.main) {
const text = generate();
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(OUT, "utf-8"); } catch { /* missing */ }
  if (cur !== text) { console.error("src/interp-gen.ts is stale: bun scripts/gen-interp-co.ts"); process.exit(1); }
} else writeFileSync(OUT, text);
}
