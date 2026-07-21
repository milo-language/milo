// Browser-compatible compiler entry point.
// Source → JS string (or error). Eval in browser, capture output.

import { Lexer } from "../../src/lexer";
import { Parser } from "../../src/parser";
import { TypeChecker } from "../../src/checker";
import type { Program } from "../../src/ast";
import type { TargetInfo } from "../../src/target";
import { lower } from "../../src/lower";
import { CodegenJS } from "../../src/codegen-js";
import { formatDiagnostic } from "../../src/diagnostics";

declare const STDLIB_FILES: Record<string, string>;

const BLOCKED = new Set([
  "std/os", "std/thread", "std/sync", "std/sqlite",
  "std/crypto", "std/signal", "std/process", "std/net", "std/http",
]);

function resolveImportsPlayground(program: Program): Program {
  const visited = new Set<string>();
  const structs: typeof program.structs = [];
  const enums: typeof program.enums = [];
  const functions: typeof program.functions = [];
  const traits: typeof program.traits = [];
  const impls: typeof program.impls = [];
  const typeAliases: typeof program.typeAliases = [];
  const interfaces: typeof program.interfaces = [];
  const globals: typeof program.globals = [];

  function processImports(prog: Program) {
    for (const imp of prog.imports) {
      const normPath = imp.path.replace(/\.milo$/, "");
      if (BLOCKED.has(normPath)) {
        throw new Error(`'${imp.path}' is not available in the playground`);
      }
      const key = normPath + ".milo";
      if (visited.has(key)) continue;
      visited.add(key);

      const content = STDLIB_FILES[key];
      if (content === undefined) {
        throw new Error(`cannot resolve '${imp.path}' in playground`);
      }

      const tokens = new Lexer(content).tokenize();
      const imported = new Parser(tokens).parse();

      if (imp.names) {
        const available = new Set<string>();
        for (const s of imported.structs) available.add(s.name);
        for (const e of imported.enums) available.add(e.name);
        for (const f of imported.functions) available.add(f.name);
        for (const t of imported.traits) available.add(t.name);
        for (const name of imp.names) {
          if (!available.has(name)) {
            throw new Error(`'${name}' not found in '${imp.path}'`);
          }
        }
      }

      structs.push(...imported.structs);
      enums.push(...imported.enums);
      functions.push(...imported.functions);
      traits.push(...imported.traits);
      impls.push(...imported.impls);
      typeAliases.push(...imported.typeAliases);
      interfaces.push(...imported.interfaces);
      globals.push(...imported.globals);
      processImports(imported);
    }
  }

  // prelude
  const preludeKey = "std/prelude.milo";
  if (STDLIB_FILES[preludeKey] && !visited.has(preludeKey)) {
    visited.add(preludeKey);
    const prelude = new Parser(new Lexer(STDLIB_FILES[preludeKey]).tokenize()).parse();
    structs.push(...prelude.structs);
    enums.push(...prelude.enums);
    functions.push(...prelude.functions);
    traits.push(...prelude.traits);
    impls.push(...prelude.impls);
    typeAliases.push(...prelude.typeAliases);
    interfaces.push(...prelude.interfaces);
    globals.push(...prelude.globals);
    processImports(prelude);
  }

  structs.push(...program.structs);
  enums.push(...program.enums);
  functions.push(...program.functions);
  traits.push(...program.traits);
  impls.push(...program.impls);
  typeAliases.push(...program.typeAliases);
  interfaces.push(...program.interfaces);
  globals.push(...program.globals);
  processImports(program);

  function dedup<T extends { name: string }>(arr: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!seen.has(arr[i].name)) {
        seen.add(arr[i].name);
        result.unshift(arr[i]);
      }
    }
    return result;
  }

  return { structs: dedup(structs), enums: dedup(enums), functions: dedup(functions), imports: [], traits: dedup(traits), impls, typeAliases: dedup(typeAliases), interfaces: dedup(interfaces), globals };
}

export interface CompileResult {
  ok: boolean;
  js?: string;
  output?: string;
  error?: string;
  runtime?: boolean;   // error came from executing the program, not compiling it
}

export function compile(source: string): CompileResult {
  try {
    const tokens = new Lexer(source).tokenize();
    const program = new Parser(tokens).parse();
    const resolved = resolveImportsPlayground(program);
    const checked = new TypeChecker().check(resolved);

    const errors = checked.diagnostics.filter(d => d.severity === "error");
    if (errors.length > 0) {
      const formatted = errors.map(d => formatDiagnostic(d, source)).join("\n\n");
      return { ok: false, error: formatted };
    }

    const hirModule = lower(resolved, checked, "/playground");
    const js = new CodegenJS(true).generate(hirModule);
    return { ok: true, js };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

export function compileAndRun(source: string): CompileResult {
  try {
    const tokens = new Lexer(source).tokenize();
    const program = new Parser(tokens).parse();
    const resolved = resolveImportsPlayground(program);
    const checked = new TypeChecker().check(resolved);

    const errors = checked.diagnostics.filter(d => d.severity === "error");
    if (errors.length > 0) {
      const formatted = errors.map(d => formatDiagnostic(d, source)).join("\n\n");
      return { ok: false, error: formatted };
    }

    const hirModule = lower(resolved, checked, "/playground");
    const fullJs = new CodegenJS(true).generate(hirModule);
    const bodyJs = new CodegenJS(true).generateBody(hirModule);

    const captured: string[] = [];
    const runtime = `
      const __out = [];
      // eager: push each line straight to __captured so output printed before a
      // runtime abort (e.g. a violated contract) still shows.
      function __print(s) { __captured.push(String(s)); }
      function __flush() { if (__out.length) { __captured.push(__out.join('')); __out.length = 0; } }
      function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
      function __fmtG(x) { if (!isFinite(x)) return String(x); if (x === 0) return '0'; let s = x.toPrecision(6); if (s.indexOf('e') >= 0) { s = Number(s).toExponential(); return s.replace(/e([+-])(\\d)$/, 'e$10$2'); } if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\\.$/, ''); return s; }
      function __propagate(r) { if (r.tag !== 0) throw { __milo_prop: r }; return r.data[0]; }
      function __eprint(s) { __out.push(String(s)); __flush(); }
      function __displayVal(v) { if (typeof v === 'string') return JSON.stringify(v); if (typeof v === 'boolean') return String(v); if (typeof v === 'number') return Number.isInteger(v) ? String(v) : __fmtG(v); if (v && typeof v === 'object' && v.constructor && v.constructor.name !== 'Object') return __displayStruct(v); return String(v); }
      function __displayStruct(v) { const ks = Object.keys(v); return v.constructor.name + ' { ' + ks.map(k => k + ': ' + __displayVal(v[k])).join(', ') + ' }'; }
      function __displayEnum(v, name) { const e = __enumMeta[name][v.tag]; return e[1] === 0 ? e[0] : e[0] + '(' + v.data.map(__displayVal).join(', ') + ')'; }
      function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }
      function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }
    `;
    const fn = new Function("__captured", runtime + bodyJs);
    // Separate runtime failures (aborts, contract violations) from compile-time
    // ones so the UI can label them correctly.
    try {
      fn(captured);
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), runtime: true, output: captured.join("") };
    }
    return { ok: true, js: fullJs, output: captured.join("") };
  } catch (e: any) {
    if (e.message) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: String(e) };
  }
}

(globalThis as any).MiloPlayground = { compile, compileAndRun };
