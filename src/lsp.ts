// milod — Milo Language Server
// Speaks LSP over JSON-RPC/stdio. Provides diagnostics, hover, go-to-definition.

import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker, type CheckResult } from "./checker";
import { resolveImports } from "./resolver";
import { ParseError, type Diagnostic } from "./diagnostics";
import type { Program, Function, Stmt, Expr, Span } from "./ast";
import { declaredType } from "./ast";
import { typeName as formatTypeName } from "./types";
import { getHostTarget } from "./target";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, readFileSync, readdirSync } from "fs";
import { STDLIB_DIR, stdExists, readStd, materializeStd } from "./stdlibBundle";
import { spawnSync } from "child_process";

const hostTarget = getHostTarget();

// Verbose LSP tracing — off by default so the output channel stays quiet.
// `MILO_LSP_DEBUG=1` logs request/notification params and handler results,
// which is how you find why a hover/definition came back empty.
const LSP_DEBUG = process.env.MILO_LSP_DEBUG === "1";
function lspDebug(msg: string) { if (LSP_DEBUG) process.stderr.write(`milod[dbg]: ${msg}\n`); }

// ── Formatter ──
// bin/milo-fmt is the source of truth (same binary `milo fmt` uses); build it on
// first use rather than silently formatting differently from the CLI. If it can't
// be built we leave the document untouched — never fall back to a divergent
// formatter, which would silently rewrite the file (e.g. hex→decimal) on save.
const lspRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fmtBinaryPath = resolve(lspRoot, "bin", "milo-fmt");
let fmtBinaryReady: boolean | null = null;

function ensureMiloFmt(): boolean {
  if (fmtBinaryReady !== null) return fmtBinaryReady;
  if (existsSync(fmtBinaryPath)) return (fmtBinaryReady = true);
  const build = spawnSync(process.execPath, [
    resolve(lspRoot, "src", "main.ts"), "build",
    resolve(lspRoot, "examples", "cli-tools", "fmt.milo"), "-o", fmtBinaryPath,
  ], { encoding: "utf-8" });
  fmtBinaryReady = build.status === 0 && existsSync(fmtBinaryPath);
  if (!fmtBinaryReady) process.stderr.write("milod: could not build bin/milo-fmt; formatting disabled\n");
  return fmtBinaryReady;
}

function formatSource(source: string): string {
  if (ensureMiloFmt()) {
    const result = spawnSync(fmtBinaryPath, [], { input: source, encoding: "utf-8", timeout: 30000 });
    if (result.status === 0 && result.stdout) return result.stdout;
  }
  return source; // native binary unavailable → no-op (formatting handler emits no edits)
}

// ── JSON-RPC transport ──

function send(msg: object) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

function sendResponse(id: number | string, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: unknown) {
  send({ jsonrpc: "2.0", method, params });
}

// ── Document store ──

const documents = new Map<string, string>();
// Project root from `initialize`; enables whole-project references/rename beyond
// the currently-open buffers. Null when the client sends no root (single-file).
let workspaceRoot: string | null = null;

// ── Symbol index (rebuilt on each change) ──

interface SymbolInfo {
  name: string;
  kind: "function" | "struct" | "enum" | "variable";
  span?: Span;
  type?: string;
  uri: string;
}

let symbolIndex: SymbolInfo[] = [];

function buildSymbolIndex(uri: string, program: Program) {
  const symbols: SymbolInfo[] = [];
  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    symbols.push({ name: fn.name, kind: "function", uri });
    // index params as variables within this function
    for (const p of fn.params) {
      symbols.push({ name: p.name, kind: "variable", type: declaredType(p).name, uri });
    }
  }
  for (const s of program.structs) {
    symbols.push({ name: s.name, kind: "struct", uri });
  }
  for (const e of program.enums) {
    symbols.push({ name: e.name, kind: "enum", uri });
  }
  symbolIndex = symbols;
}

// ── Type info for hover ──

interface TypeInfo {
  line: number;
  col: number;
  endCol: number;
  text: string;
}

function collectTypeInfo(program: Program): TypeInfo[] {
  const infos: TypeInfo[] = [];

  for (const fn of program.functions) {
    if (fn.isExtern) continue;
    for (const stmt of fn.body) collectStmtTypeInfo(stmt, fn, infos);
  }
  return infos;
}

function collectStmtTypeInfo(stmt: Stmt, fn: Function, infos: TypeInfo[]) {
  switch (stmt.kind) {
    case "LetDecl":
    case "VarDecl":
      if (stmt.span) {
        const declType = (stmt.type ? formatMiloType(stmt.type) : null) ?? inferLiteralType(stmt.value);
        if (declType) {
          // span points to 'let'/'var', name starts after that + space
          infos.push({
            line: stmt.span.line,
            col: stmt.span.col,
            endCol: stmt.span.col + (stmt.kind === "LetDecl" ? 3 : 3) + 1 + stmt.name.length,
            text: `${stmt.kind === "LetDecl" ? "let" : "var"} ${stmt.name}: ${declType}`,
          });
        }
      }
      break;
    case "IfStmt":
      for (const s of stmt.thenBody) collectStmtTypeInfo(s, fn, infos);
      if (stmt.elseBody) for (const s of stmt.elseBody) collectStmtTypeInfo(s, fn, infos);
      break;
    case "WhileStmt":
      for (const s of stmt.body) collectStmtTypeInfo(s, fn, infos);
      break;
    case "MatchStmt":
      for (const arm of stmt.arms) {
        for (const s of arm.body) collectStmtTypeInfo(s, fn, infos);
      }
      break;
    case "ForInStmt":
      for (const s of stmt.body) collectStmtTypeInfo(s, fn, infos);
      break;
    case "UnsafeBlock":
      for (const s of stmt.body) collectStmtTypeInfo(s, fn, infos);
      break;
  }
}

function inferLiteralType(expr: Expr): string | null {
  switch (expr.kind) {
    case "IntLit": return "i64";  // context-free int literals default to i64
    case "FloatLit": return "f64";
    case "BoolLit": return "bool";
    case "StringLit": return "*i8";
    default: return null;
  }
}

// ── Type formatting ──

function formatMiloType(t: import("./ast").MiloType): string {
  if (t.isFn && t.fnParams && t.fnRet) {
    return `(${t.fnParams.map(formatMiloType).join(", ")}) => ${formatMiloType(t.fnRet)}`;
  }
  let base = t.name;
  if (t.rangeMin !== undefined && t.rangeMax !== undefined) {
    base += `(${t.rangeMin}..${t.rangeMax})`;
  }
  if (t.typeArgs?.length) {
    base += `<${t.typeArgs.map(formatMiloType).join(", ")}>`;
  }
  if (t.isArray) {
    return t.arraySize !== null ? `[${base}; ${t.arraySize}]` : `[${base}]`;
  }
  if (t.isRef) return `&${base}`;
  if (t.isRefMut) return `&mut ${base}`;
  if (t.isPtr) return `${"*".repeat(t.ptrDepth ?? 1)}${base}`;
  return base;
}

// Byte width of the scalar primitives, for spelling out `[T; N]` in plain terms.
const SCALAR_BYTES: Record<string, number> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, bool: 1,
};

// A `[u8; 64]` hover means nothing to a reader who doesn't know the `[element; count]`
// spelling. Append a plain-English gloss: how many of what, and total bytes if the
// element size is known. Returns "" for non-fixed-array code lines.
function arrayHoverNote(codeLine: string): string {
  const m = codeLine.match(/\[([A-Za-z_][\w]*)(<[^\]]*>)?;\s*(\d+)\]/);
  if (!m) return "";
  const elem = m[1], n = parseInt(m[3]);
  let note = `Fixed-size array — **${n.toLocaleString("en-US")}** × \`${elem}${m[2] ?? ""}\``;
  const eb = SCALAR_BYTES[elem];
  if (eb !== undefined && !m[2]) {
    const total = eb * n;
    note += ` (${eb} byte${eb === 1 ? "" : "s"} each) — ${total.toLocaleString("en-US")} bytes`;
    if (total >= 1024) {
      const kib = total / 1024;
      note += kib >= 1024 ? ` (${(kib / 1024).toFixed(1)} MiB)` : ` (${kib % 1 === 0 ? kib : kib.toFixed(1)} KiB)`;
    }
  }
  return `\n\n---\n\n${note}`;
}

// ── Doc comment extraction ──

function extractDocComment(source: string, declLineIndex: number): string | null {
  const lines = source.split("\n");
  const comments: string[] = [];
  let i = declLineIndex - 1;
  // Skip the decl's attribute block (`@ derive(...)` etc.) so the doc comment
  // above it still attaches — an attribute is part of the decl, not a separator.
  // Blanks interleaved with the attributes are skipped too, but a lone blank with
  // no attribute stays a hard stop (a blank-separated comment is not a doc).
  let j = i, sawAttr = false;
  while (j >= 0 && (lines[j].trim() === "" || lines[j].trim().startsWith("@"))) {
    if (lines[j].trim().startsWith("@")) sawAttr = true;
    j--;
  }
  if (sawAttr) i = j;
  for (; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      if (trimmed.includes("──")) break;
      comments.unshift(trimmed.replace(/^\/\/\s?/, ""));
    } else {
      break;
    }
  }
  return comments.length > 0 ? comments.join("\n") : null;
}

function findSymbolDoc(source: string, word: string, kind: "fn" | "struct" | "enum"): string | null {
  const lines = source.split("\n");
  const re = kind === "fn"
    ? new RegExp(`\\bfn\\s+${word}\\s*[<(]`)
    : new RegExp(`\\b${kind}\\s+${word}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      return extractDocComment(source, i);
    }
  }
  return null;
}

function symbolExistsInSource(source: string, word: string, kind: "fn" | "struct" | "enum"): boolean {
  const re = kind === "fn"
    ? new RegExp(`\\bfn\\s+${word}\\s*[<(]`)
    : new RegExp(`\\b${kind}\\s+${word}\\b`);
  return re.test(source);
}

function findDocInImports(parsed: Program, sourceDir: string, word: string, kind: "fn" | "struct" | "enum", visited: Set<string> = new Set()): { doc: string | null, module: string } | null {
  for (const imp of parsed.imports) {
    const absPath = resolveImportPath(sourceDir, imp.path);
    if (!absPath) continue;
    // Guard against cyclic imports (e.g. std/os <-> std/runtime) — without this
    // the transitive walk recurses forever and pins a CPU at 100%.
    if (visited.has(absPath)) continue;
    visited.add(absPath);
    const fileSource = readStd(absPath);
    if (fileSource === null) continue;

    if (symbolExistsInSource(fileSource, word, kind)) {
      return { doc: findSymbolDoc(fileSource, word, kind), module: imp.path };
    }

    try {
      const tokens = new Lexer(fileSource).tokenize();
      const importedParsed = new Parser(tokens).parse();
      const transResult = findDocInImports(importedParsed, dirname(absPath), word, kind, visited);
      if (transResult) return transResult;
    } catch {}
  }
  return null;
}

function appendDocAndModule(hover: string, source: string, parsed: Program, sourceDir: string, word: string, kind: "fn" | "struct" | "enum"): string {
  if (symbolExistsInSource(source, word, kind)) {
    const doc = findSymbolDoc(source, word, kind);
    return doc ? hover + `\n\n---\n\n${doc}` : hover;
  }
  const imported = findDocInImports(parsed, sourceDir, word, kind);
  if (imported) {
    let suffix = "\n\n---\n\n";
    if (imported.doc) suffix += imported.doc + "\n\n";
    suffix += `*from \`${imported.module}\`*`;
    return hover + suffix;
  }
  return hover;
}

// ── Diagnostics ──

function validateDocument(uri: string) {
  const source = documents.get(uri);
  if (!source) return;

  let diagnostics: Diagnostic[] = [];
  try {
    const tokens = new Lexer(source).tokenize();
    const parsed = new Parser(tokens).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);
    diagnostics = new TypeChecker().check(program).diagnostics;
    buildSymbolIndex(uri, program);
  } catch (e: any) {
    // Parse errors carry a structured Diagnostic (span + hint) — use it directly.
    if (e instanceof ParseError) {
      // An error from an imported file has a span in THAT file — don't squiggle an
      // unrelated line of this document; surface it at the top with the real location.
      const docPath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
      if (e.filePath && e.filePath !== docPath) {
        const loc = e.diagnostic.span ? `:${e.diagnostic.span.line}:${e.diagnostic.span.col}` : "";
        diagnostics = [{
          severity: "error",
          span: { line: 1, col: 1 },
          message: `in imported file ${e.filePath}${loc}: ${e.diagnostic.message}`,
          hint: e.diagnostic.hint,
        }];
      } else {
        diagnostics = [e.diagnostic];
      }
    } else {
      // Other lex/parse errors — extract line:col from the message.
      const match = e.message?.match(/(\d+):(\d+):\s*(.+)/);
      if (match) {
        diagnostics = [{
          severity: "error",
          span: { line: parseInt(match[1]), col: parseInt(match[2]) },
          message: match[3],
        }];
      } else {
        diagnostics = [{ severity: "error", message: e.message ?? "unknown error" }];
      }
    }
  }

  sendNotification("textDocument/publishDiagnostics", {
    uri,
    diagnostics: diagnostics.map(d => ({
      range: d.span ? {
        start: { line: d.span.line - 1, character: d.span.col - 1 },
        end: { line: d.span.line - 1, character: d.span.col - 1 + Math.max(1, d.len ?? 1) },
      } : { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: d.severity === "error" ? 1 : d.severity === "warning" ? 2 : 3,
      source: "milo",
      message: d.hint ? `${d.message}\nhint: ${d.hint}` : d.message,
    })),
  });
}

// ── Hover ──

function handleHover(uri: string, line: number, character: number): object | null {
  const source = documents.get(uri);
  if (!source) return null;

  try {
    const tokens = new Lexer(source).tokenize();
    const parsed = new Parser(tokens).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);
    let checkResult: CheckResult | null = null;
    try { checkResult = new TypeChecker().check(program); } catch {}
    const exprTypes = checkResult?.exprTypes ?? new Map();
    const word = getWordAt(source, line, character);
    lspDebug(`hover ${line}:${character} word=${JSON.stringify(word)}`);

    // Variable declarations — only when hovering on the variable name itself.
    // Include impl methods (Function[] in program.impls) so decl-site hover works
    // inside method bodies, not just free functions.
    for (const fn of [...program.functions, ...program.impls.flatMap(i => i.methods)]) {
      if (fn.isExtern) continue;
      for (const stmt of fn.body) {
        const info = findHoverInStmt(stmt, line + 1, character + 1, exprTypes, word);
        if (info) return { contents: { kind: "markdown", value: `\`\`\`milo\n${info}\n\`\`\`${arrayHoverNote(info)}` } };
      }
    }

    // Free functions
    const f = program.functions.find(fn => fn.name === word && !fn.isExtern);
    if (f) {
      const params = f.params.map(p => `${p.name}: ${formatMiloType(declaredType(p))}`).join(", ");
      const sig = `fn ${f.name}(${params}): ${formatMiloType(f.retType)}`;
      let hover = `\`\`\`milo\n${sig}\n\`\`\``;
      hover = appendDocAndModule(hover, source, parsed, sourceDir, word, "fn");
      return { contents: { kind: "markdown", value: hover } };
    }

    // Impl methods
    for (const impl of program.impls) {
      for (const method of impl.methods) {
        if (method.name === word) {
          const params = method.params
            .filter(p => p.name !== "self")
            .map(p => `${p.name}: ${formatMiloType(declaredType(p))}`).join(", ");
          const sig = `fn ${impl.typeName}.${method.name}(${params}): ${formatMiloType(method.retType)}`;
          let hover = `\`\`\`milo\n${sig}\n\`\`\``;
          hover = appendDocAndModule(hover, source, parsed, sourceDir, word, "fn");
          return { contents: { kind: "markdown", value: hover } };
        }
      }
    }

    // Builtin instance methods (Vec.pop / .push / .len / …) — resolved in the
    // checker, so plain symbol lookup misses them. Gated on a real MethodCall of
    // this name on the line, so it won't hijack a same-named field or free fn.
    const methodHover = findBuiltinMethodHover(source, word, line, exprTypes);
    if (methodHover) return { contents: { kind: "markdown", value: methodHover } };

    // Enums and variants
    const enumHover = findEnumHover(source, program, word, line, character, parsed, sourceDir);
    if (enumHover) return { contents: { kind: "markdown", value: enumHover } };

    // Builtin collection types + their static constructors (Vec.new, HashMap.new, …)
    const builtinHover = findBuiltinTypeHover(source, word, line);
    if (builtinHover) return { contents: { kind: "markdown", value: builtinHover } };

    // Scalar primitives + raw pointers (`u8`, `i32`, `*u8`, …)
    const primHover = findPrimitiveHover(source, word, line, character);
    if (primHover) return { contents: { kind: "markdown", value: primHover } };

    // Type aliases
    for (const ta of program.typeAliases) {
      if (ta.name === word) {
        return { contents: { kind: "markdown", value: `\`\`\`milo\ntype ${ta.name} = ${formatMiloType(ta.type)}\n\`\`\`` } };
      }
    }

    // Structs
    for (const s of program.structs) {
      if (s.name === word) {
        const tparams = s.typeParams.length ? `<${s.typeParams.map(t => t.name).join(", ")}>` : "";
        const fields = s.fields.map(f => `    ${f.name}: ${formatMiloType(f.type)},`).join("\n");
        let hover = `\`\`\`milo\nstruct ${s.name}${tparams} {\n${fields}\n}\n\`\`\``;
        hover = appendDocAndModule(hover, source, parsed, sourceDir, word, "struct");
        return { contents: { kind: "markdown", value: hover } };
      }
    }

    // Struct fields
    const lineText = source.split("\n")[line] ?? "";
    const fieldMatches: { s: import("./ast").StructDecl; f: import("./ast").StructField }[] = [];
    for (const s of program.structs) {
      for (const f of s.fields) {
        if (f.name === word) fieldMatches.push({ s, f });
      }
    }
    if (fieldMatches.length === 1) {
      const { s, f } = fieldMatches[0];
      return { contents: { kind: "markdown", value: `\`\`\`milo\n${s.name}.${f.name}: ${formatMiloType(f.type)}\n\`\`\`` } };
    } else if (fieldMatches.length > 1) {
      for (const { s, f } of fieldMatches) {
        if (lineText.includes(s.name)) {
          return { contents: { kind: "markdown", value: `\`\`\`milo\n${s.name}.${f.name}: ${formatMiloType(f.type)}\n\`\`\`` } };
        }
      }
    }

    // Interfaces
    for (const iface of program.interfaces) {
      if (iface.name === word) {
        const methods = iface.methods.map(m => {
          const params = m.params.map(p => `${p.name}: ${formatMiloType(declaredType(p))}`).join(", ");
          return `    fn ${m.name}(${params}): ${formatMiloType(m.retType)}`;
        }).join("\n");
        return { contents: { kind: "markdown", value: `\`\`\`milo\ninterface ${iface.name} {\n${methods}\n}\n\`\`\`` } };
      }
    }

    // Variable references (params and locals in enclosing function)
    const enclosing = findEnclosingFn(source, program, line);
    if (enclosing) {
      for (const p of enclosing.fn.params) {
        if (p.name === word) {
          return { contents: { kind: "markdown", value: `\`\`\`milo\n${p.name}: ${formatMiloType(declaredType(p))}\n\`\`\`` } };
        }
      }
      const bindTypes = checkResult?.patternBindingTypes ?? new Map();
      const varHover = findVarHover(enclosing.fn.body, word, exprTypes, bindTypes);
      if (varHover) return { contents: { kind: "markdown", value: `\`\`\`milo\n${varHover}\n\`\`\`${arrayHoverNote(varHover)}` } };
    }

    // Global variables — checked after params/locals so a same-named local
    // shadows; also fires at top level (no enclosing fn) for the decl site.
    for (const g of program.globals) {
      if (g.name !== word) continue;
      let ty = g.type ? formatMiloType(g.type) : null;
      if (!ty) { const tk = exprTypes.get(g.value); if (tk) ty = formatTypeName(tk); }
      const kw = g.mutable ? "var" : "let";
      const line = `${kw} ${g.name}: ${ty ?? "?"}`;
      return { contents: { kind: "markdown", value: `\`\`\`milo\n${line}\n\`\`\`${arrayHoverNote(line)}` } };
    }
    lspDebug(`hover word=${JSON.stringify(word)} → no match (globals=${program.globals.length})`);
  } catch (e) {
    process.stderr.write(`milod: hover parse error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  return null;
}

function findVarHover(
  stmts: Stmt[],
  word: string,
  exprTypes: Map<Expr, import("./types").TypeKind>,
  bindTypes: Map<import("./ast").Pattern, import("./types").TypeKind[]>,
): string | null {
  // A payload binding from an enum pattern (`Option.Some(n)` binds `n`).
  const patternBindHover = (pattern: import("./ast").Pattern): string | null => {
    if (pattern.kind !== "EnumPattern") return null;
    const i = pattern.bindings.indexOf(word);
    if (i < 0) return null;
    const tk = bindTypes.get(pattern)?.[i];
    return `let ${word}: ${tk ? formatTypeName(tk) : "?"}`;
  };
  for (const stmt of stmts) {
    if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.name === word) {
      let resolved = (stmt.type ? formatMiloType(stmt.type) : null) ?? inferLiteralType(stmt.value);
      if (!resolved) {
        const tk = exprTypes.get(stmt.value);
        if (tk) resolved = formatTypeName(tk);
      }
      if (resolved) return `${stmt.kind === "LetDecl" ? "let" : "var"} ${stmt.name}: ${resolved}`;
    }
    if (stmt.kind === "IfStmt") {
      const r = findVarHover(stmt.thenBody, word, exprTypes, bindTypes); if (r) return r;
      if (stmt.elseBody) { const r2 = findVarHover(stmt.elseBody, word, exprTypes, bindTypes); if (r2) return r2; }
    }
    if (stmt.kind === "IfLetStmt") {
      const b = patternBindHover(stmt.pattern); if (b) return b;
      const r = findVarHover(stmt.thenBody, word, exprTypes, bindTypes); if (r) return r;
      if (stmt.elseBody) { const r2 = findVarHover(stmt.elseBody, word, exprTypes, bindTypes); if (r2) return r2; }
    }
    if (stmt.kind === "LetElseStmt") {
      const b = patternBindHover(stmt.pattern); if (b) return b;
      const r = findVarHover(stmt.elseBody, word, exprTypes, bindTypes); if (r) return r;
    }
    if (stmt.kind === "WhileStmt") {
      const r = findVarHover(stmt.body, word, exprTypes, bindTypes); if (r) return r;
    }
    if (stmt.kind === "MatchStmt") {
      for (const arm of stmt.arms) {
        const b = patternBindHover(arm.pattern); if (b) return b;
        const r = findVarHover(arm.body, word, exprTypes, bindTypes); if (r) return r;
      }
    }
    if (stmt.kind === "ForInStmt") {
      if (stmt.varName === word) return `let ${stmt.varName}: (loop variable)`;
      if (stmt.varName2 && stmt.varName2 === word) return `let ${stmt.varName2}: (loop variable)`;
      const r = findVarHover(stmt.body, word, exprTypes, bindTypes); if (r) return r;
    }
    if (stmt.kind === "UnsafeBlock") {
      const r = findVarHover(stmt.body, word, exprTypes, bindTypes); if (r) return r;
    }
  }
  return null;
}

function findHoverInStmt(stmt: Stmt, line: number, col: number, exprTypes: Map<Expr, import("./types").TypeKind>, word: string): string | null {
  if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.span?.line === line && stmt.name === word) {
    let resolved = (stmt.type ? formatMiloType(stmt.type) : null) ?? inferLiteralType(stmt.value);
    if (!resolved) {
      const tk = exprTypes.get(stmt.value);
      if (tk) resolved = formatTypeName(tk);
    }
    return `${stmt.kind === "LetDecl" ? "let" : "var"} ${stmt.name}: ${resolved ?? "unknown"}`;
  }
  if (stmt.kind === "IfStmt") {
    for (const s of stmt.thenBody) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
    if (stmt.elseBody) for (const s of stmt.elseBody) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
  }
  if (stmt.kind === "WhileStmt") {
    for (const s of stmt.body) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
  }
  if (stmt.kind === "MatchStmt") {
    for (const arm of stmt.arms) {
      for (const s of arm.body) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
    }
  }
  if (stmt.kind === "ForInStmt") {
    for (const s of stmt.body) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
  }
  if (stmt.kind === "UnsafeBlock") {
    for (const s of stmt.body) { const r = findHoverInStmt(s, line, col, exprTypes, word); if (r) return r; }
  }
  return null;
}

function formatEnumDecl(e: import("./ast").EnumDecl): string {
  const tparams = e.typeParams.length ? `<${e.typeParams.map(t => t.name).join(", ")}>` : "";
  const variants = e.variants.map(v => {
    if (v.fields.length === 0) return `    ${v.name},`;
    return `    ${v.name}(${v.fields.map(f => f.name).join(", ")}),`;
  }).join("\n");
  return `\`\`\`milo\nenum ${e.name}${tparams} {\n${variants}\n}\n\`\`\``;
}

function formatVariantInfo(e: import("./ast").EnumDecl, v: import("./ast").EnumVariant): string {
  const tparams = e.typeParams.length ? `<${e.typeParams.map(t => t.name).join(", ")}>` : "";
  const fields = v.fields.length ? `(${v.fields.map(f => f.name).join(", ")})` : "";
  return `\`\`\`milo\n${e.name}${tparams}.${v.name}${fields}\n\`\`\``;
}

const BUILTIN_ENUMS: import("./ast").EnumDecl[] = [
  {
    kind: "EnumDecl", name: "Option", typeParams: [{ name: "T", bounds: [] }],
    variants: [
      { name: "Some", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
      { name: "None", fields: [] },
    ],
  },
  {
    kind: "EnumDecl", name: "Result", typeParams: [{ name: "T", bounds: [] }],
    variants: [
      { name: "Ok", fields: [{ name: "T", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
      { name: "Err", fields: [{ name: "string", isPtr: false, isRef: false, isRefMut: false, isArray: false, arraySize: null }] },
    ],
  },
];

const BUILTIN_DOCS: Record<string, { enum: string; variants: Record<string, string> }> = {
  Option: {
    enum: [
      "A value that may or may not exist.",
      "",
      "**Operators** (each pulls the value out of the `Option`):",
      "- `!` — the value; **panics** if `None`",
      "- `?` — the value; if `None`, stops here and returns `None` from the current fn",
      "- `??` — the value, or the given fallback if `None`",
      "",
      "```milo",
      "let x: Option<i32> = Option.Some(42)",
      "let n = x!              // 42  (would panic if x were None)",
      "let m = x ?? 0          // 42  (0 if x were None)",
      "if let Option.Some(v) = x { ... }   // v is the value only when present",
      "```",
    ].join("\n"),
    variants: {
      Some: "Holds a value of type `T`.\n\n```milo\nlet x = Option.Some(42)\nlet v = x!   // 42 — panics if it were None\n```",
      None: "No value present.\n\n```milo\nlet x: Option<i32> = Option.None\nlet v = x ?? 0   // 0 — the fallback, since None has no value\n```",
    },
  },
  Result: {
    enum: [
      "A value that is either a success (`Ok`) or an error (`Err`).",
      "",
      "**Operators** (each pulls the `Ok` value out of the `Result`):",
      "- `!` — the `Ok` value; **panics** if `Err`",
      "- `?` — the `Ok` value; if `Err`, stops here and returns that `Err` from the current fn",
      "- `??` — the `Ok` value, or the given fallback if `Err`",
      "",
      "```milo",
      "fn parse(s: string): Result<i64> {",
      "    if s.len == 0 { return Result.Err(\"empty\") }",
      "    return Result.Ok(42)",
      "}",
      "let v = parse(\"x\")?     // the number, or bail out of this fn with the Err",
      "let v = parse(\"x\") ?? 0 // the number, or 0 if it failed",
      "```",
    ].join("\n"),
    variants: {
      Ok: "Success — holds a value of type `T`.\n\n```milo\nlet r: Result<i64> = Result.Ok(42)\nlet v = r!   // 42 — panics if it were Err\nlet v = r?   // 42 here; if r were Err, this returns the Err from the fn\n```",
      Err: "Failure — holds a `string` message.\n\n```milo\nlet r: Result<i64> = Result.Err(\"not found\")\nmatch r {\n    Result.Ok(v) => { ... }\n    Result.Err(msg) => { print(msg) }\n}\n```",
    },
  },
};

// Builtin collection types + their static constructors. These aren't user
// decls (Vec.new parses as an EnumLit "Vec"/"new"), so plain symbol lookup
// misses them — this table drives their hover.
const BUILTIN_TYPE_HOVERS: Record<string, { doc: string; ctors: Record<string, string> }> = {
  Vec: {
    doc: [
      "```milo",
      "Vec<T>",
      "```",
      "A growable, heap-allocated array of `T`. Single owner; moved, not copied.",
      "",
      "**Construct:** `Vec.new()` · `Vec.withCapacity(n)` · `Vec.filled(n, v)` · literal `[a, b, c]`",
    ].join("\n"),
    ctors: {
      new: "```milo\nfn Vec.new(): Vec<T>\n```\nEmpty vector. `T` is inferred from the binding's annotation.\n\n```milo\nlet v: Vec<i32> = Vec.new()\nv.push(1)\n```",
      withCapacity: "```milo\nfn Vec.withCapacity(capacity: i64): Vec<T>\n```\nEmpty vector with room preallocated for `capacity` elements — avoids reallocs while pushing a known count.\n\n```milo\nlet v: Vec<i32> = Vec.withCapacity(100)\n```",
      filled: "```milo\nfn Vec.filled(count: i64, value: T): Vec<T>\n```\n`count` copies of `value` (requires a Copy `T` — the value is duplicated into every slot).\n\n```milo\nlet zeros: Vec<i32> = Vec.filled(8, 0)\n```",
    },
  },
  HashMap: {
    doc: [
      "```milo",
      "HashMap<K, V>",
      "```",
      "A hash map from keys of type `K` to values of type `V`.",
      "",
      "**Construct:** `HashMap.new()`",
    ].join("\n"),
    ctors: {
      new: "```milo\nfn HashMap.new(): HashMap<K, V>\n```\nEmpty map. `K`/`V` are inferred from the binding's annotation.\n\n```milo\nlet m: HashMap<string, i32> = HashMap.new()\nm.insert(\"a\", 1)\n```",
    },
  },
  String: {
    doc: [
      "```milo",
      "String",
      "```",
      "An owned, growable UTF-8 string buffer (distinct from a borrowed `string`).",
      "",
      "**Construct:** `String.withCapacity(n)`",
    ].join("\n"),
    ctors: {
      withCapacity: "```milo\nfn String.withCapacity(capacity: i64): String\n```\nEmpty string with room preallocated for `capacity` bytes.\n\n```milo\nlet s = String.withCapacity(64)\n```",
    },
  },
};

// Builtin instance methods on collections (Vec/Array). These are resolved in the
// checker, not by symbol lookup, so hovering the method name (`v.pop`) otherwise
// finds nothing. Each entry renders a signature specialized to the receiver's
// element type `T`, plus a one-line doc. Mutating ops note the `var` requirement.
const BUILTIN_METHOD_HOVERS: Record<string, (recv: string, elem: string) => string> = {
  push: (r, t) => `\`\`\`milo\nfn ${r}.push(value: ${t})\n\`\`\`\nAppends \`value\` to the end (mutates — receiver must be \`var\`). Moves \`value\` in.`,
  pop: (r, t) => `\`\`\`milo\nfn ${r}.pop(): Option<${t}>\n\`\`\`\nRemoves and returns the last element as \`Some\`, or \`None\` if empty (mutates — receiver must be \`var\`). Pull the value out with \`!\` (panic if empty), \`?\` (bail), or \`?? fallback\`.`,
  insert: (r, t) => `\`\`\`milo\nfn ${r}.insert(index: i64, value: ${t})\n\`\`\`\nInserts \`value\` at \`index\`, shifting later elements right (mutates — receiver must be \`var\`).`,
  remove: (r, t) => `\`\`\`milo\nfn ${r}.remove(index: i64): ${t}\n\`\`\`\nRemoves and returns the element at \`index\`, shifting later elements left (mutates — receiver must be \`var\`).`,
  swap: (r, _t) => `\`\`\`milo\nfn ${r}.swap(a: i64, b: i64)\n\`\`\`\nSwaps the elements at indices \`a\` and \`b\` in place (mutates — receiver must be \`var\`).`,
  reverse: (r, _t) => `\`\`\`milo\nfn ${r}.reverse()\n\`\`\`\nReverses the elements in place (mutates — receiver must be \`var\`).`,
  sort: (r, _t) => `\`\`\`milo\nfn ${r}.sort()\n\`\`\`\nSorts ascending in place; requires a comparable element (int, float, string, bool). Mutates — receiver must be \`var\`.`,
  len: (r, _t) => `\`\`\`milo\nfn ${r}.len(): i64\n\`\`\`\nNumber of elements.`,
  isEmpty: (r, _t) => `\`\`\`milo\nfn ${r}.isEmpty(): bool\n\`\`\`\n\`true\` when \`len() == 0\`.`,
  clone: (r, _t) => `\`\`\`milo\nfn ${r}.clone(): ${r}\n\`\`\`\nDeep copy — each element is cloned, so the result owns independent heap data. Use it to pass a value where the original is still needed (e.g. alongside a \`&var\` argument off the same variable).`,
};

// Hover for a builtin instance method (`v.pop()`). Only fires when there is an
// actual MethodCall of this name on the hovered line — so a struct field or free
// fn that happens to share the name (`foo.len` field access) is left alone. The
// receiver type comes from the checker's expr types, letting `T` resolve concretely.
function findBuiltinMethodHover(
  source: string, word: string, line: number,
  exprTypes: Map<Expr, import("./types").TypeKind>,
): string | null {
  const make = BUILTIN_METHOD_HOVERS[word];
  if (!make) return null;
  let recv: import("./types").TypeKind | null = null;
  let found = false;
  for (const [e] of exprTypes) {
    if (e.kind === "MethodCall" && e.method === word && e.span?.line === line + 1) {
      recv = exprTypes.get(e.object) ?? null;
      found = true;
      break;
    }
  }
  if (!found) return null;
  const elem = recv && (recv.tag === "vec" || recv.tag === "array") ? formatTypeName(recv.element) : "T";
  const recvName = recv ? formatTypeName(recv) : "Vec<T>";
  return make(recvName, elem);
}

// Scalar primitives + the two string types. Keyed by the exact type keyword;
// the value is the markdown body shown on hover.
const PRIMITIVE_HOVERS: Record<string, string> = {
  u8: "8-bit unsigned integer (0–255). Also the byte type for raw buffers and `*u8` C strings.",
  u16: "16-bit unsigned integer (0–65535).",
  u32: "32-bit unsigned integer.",
  u64: "64-bit unsigned integer.",
  i8: "8-bit signed integer (−128–127).",
  i16: "16-bit signed integer.",
  i32: "32-bit signed integer.",
  i64: "64-bit signed integer. Default type for an unannotated integer literal.",
  f32: "32-bit IEEE-754 float.",
  f64: "64-bit IEEE-754 float. Default type for an unannotated float literal.",
  bool: "Boolean — `true` or `false`.",
  char: "A single Unicode scalar value (32-bit).",
  string: "Borrowed UTF-8 string slice (a view; not owned). The owned, growable buffer is `String`.",
  void: "No value — the return type of a function that returns nothing.",
};

// Hover for a scalar/string primitive. If the type keyword is written as `*T`
// (raw pointer — the `*` sits immediately before the word), lead with the
// pointer explanation since that's the surprising part at FFI boundaries.
function findPrimitiveHover(source: string, word: string, line: number, character: number): string | null {
  const body = PRIMITIVE_HOVERS[word];
  if (!body) return null;
  const text = source.split("\n")[line] ?? "";
  let start = character;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  const isPtr = start > 0 && text[start - 1] === "*";
  if (isPtr) {
    return [
      "```milo",
      `*${word}`,
      "```",
      "A raw memory address — a plain number that points at some bytes somewhere.",
      "",
      `Milo uses these to talk to C libraries (like SDL): the library hands you a \`*${word}\` and you hand it back. Often it's really a handle to some foreign thing Milo has no type for.`,
      "",
      "Milo can't prove the address is valid, so reading what it points at only works inside an `unsafe { }` block. Writing `0 as *" + word + "` means \"no address\" (an empty pointer). These can't be shared between threads.",
    ].join("\n");
  }
  return ["```milo", word, "```", body].join("\n");
}

function findBuiltinTypeHover(source: string, word: string, line: number): string | null {
  const entry = BUILTIN_TYPE_HOVERS[word];
  if (entry) return entry.doc;
  // A constructor like `new` — only when the line reads `Type.new` (disambiguates
  // `withCapacity`, shared by Vec and String).
  const lineText = source.split("\n")[line] ?? "";
  for (const [typeName, e] of Object.entries(BUILTIN_TYPE_HOVERS)) {
    const ctor = e.ctors[word];
    if (ctor && new RegExp(`\\b${typeName}\\.${word}\\b`).test(lineText)) return ctor;
  }
  return null;
}

function findEnumHover(source: string, program: Program, word: string, line: number, character: number, parsed: Program, sourceDir: string): string | null {
  const lineText = source.split("\n")[line] ?? "";
  const allEnums = [...program.enums, ...BUILTIN_ENUMS];

  for (const e of allEnums) {
    if (e.name === word) {
      const decl = formatEnumDecl(e);
      const docs = BUILTIN_DOCS[e.name];
      if (docs) return `${decl}\n\n---\n\n${docs.enum}`;
      return appendDocAndModule(decl, source, parsed, sourceDir, word, "enum");
    }
  }

  for (const e of allEnums) {
    for (const v of e.variants) {
      if (v.name === word) {
        const pat = new RegExp(`\\b${e.name}\\.${v.name}\\b`);
        if (pat.test(lineText)) {
          const sig = formatVariantInfo(e, v);
          const docs = BUILTIN_DOCS[e.name]?.variants[v.name];
          return docs ? `${sig}\n\n---\n\n${docs}` : sig;
        }
      }
    }
  }

  return null;
}

function getWordAt(source: string, line: number, character: number): string {
  const lines = source.split("\n");
  if (line >= lines.length) return "";
  const text = lines[line];
  let start = character, end = character;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  while (end < text.length && /\w/.test(text[end])) end++;
  return text.slice(start, end);
}

// ── Go to definition ──

function resolveImportPath(sourceDir: string, importPath: string): string | null {
  const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";
  const rel = resolve(sourceDir, withExt);
  if (stdExists(rel)) return rel;
  const std = resolve(STDLIB_DIR, withExt);
  if (stdExists(std)) return std;
  return null;
}

function findInImportedFiles(parsed: Program, sourceDir: string, word: string, visited: Set<string> = new Set()): object | null {
  for (const imp of parsed.imports) {
    const absPath = resolveImportPath(sourceDir, imp.path);
    if (!absPath) continue;
    // Cyclic-import guard (e.g. std/os <-> std/runtime) — see findDocInImports.
    if (visited.has(absPath)) continue;
    visited.add(absPath);
    const fileSource = readStd(absPath);
    if (fileSource === null) continue;

    for (const [keyword, re] of [["fn", new RegExp(`\\bfn\\s+${word}\\s*[<(]`)], ["struct", new RegExp(`\\bstruct\\s+${word}\\b`)], ["enum", new RegExp(`\\benum\\s+${word}\\b`)]] as const) {
      const lines = fileSource.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          return { uri: pathToFileURL(materializeStd(absPath)).href, range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } } };
        }
      }
    }

    // recurse into transitive imports (also lets us resolve enum variants,
    // which need the parsed enum to know the owning enum name)
    try {
      const tokens = new Lexer(fileSource).tokenize();
      const importedParsed = new Parser(tokens).parse();
      for (const e of importedParsed.enums) {
        if (e.variants.some(v => v.name === word)) {
          const vLine = findEnumVariantLine(fileSource, e.name, word);
          if (vLine >= 0) {
            return { uri: pathToFileURL(materializeStd(absPath)).href, range: { start: { line: vLine, character: 0 }, end: { line: vLine, character: 0 } } };
          }
        }
      }
      const result = findInImportedFiles(importedParsed, dirname(absPath), word, visited);
      if (result) return result;
    } catch {}
  }
  return null;
}

function handleDefinition(uri: string, line: number, character: number): object | null {
  const source = documents.get(uri);
  if (!source) return null;

  const lines = source.split("\n");
  const lineText = lines[line] ?? "";

  // cmd-click on import path → jump to file
  const importMatch = lineText.match(/(?:from\s+"([^"]+)"\s+import|import\s+"([^"]+)")/);
  if (importMatch) {
    const importPath = importMatch[1] ?? importMatch[2];
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const resolved = resolveImportPath(sourceDir, importPath);
    if (resolved) {
      const targetUri = pathToFileURL(materializeStd(resolved)).href;
      return { uri: targetUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    }
  }

  const word = getWordAt(source, line, character);
  if (!word) return null;

  try {
    const tokens = new Lexer(source).tokenize();
    const parsed = new Parser(tokens).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);

    // Find function definition — local first, then imported files.
    // Extern fns are declarations, but the `extern fn NAME(...)` line IS the
    // def site users cmd-click to — jump there like any other fn.
    for (const fn of program.functions) {
      if (fn.name === word) {
        const fnLine = findFnLine(source, fn.name);
        if (fnLine >= 0) {
          return { uri, range: { start: { line: fnLine, character: 0 }, end: { line: fnLine, character: 0 } } };
        }
      }
    }

    // Find struct definition — local first
    for (const s of program.structs) {
      if (s.name === word) {
        const sLine = findDeclLine(source, "struct", s.name);
        if (sLine >= 0) {
          return { uri, range: { start: { line: sLine, character: 0 }, end: { line: sLine, character: 0 } } };
        }
      }
    }

    // Find enum definition — local first
    for (const e of program.enums) {
      if (e.name === word) {
        const eLine = findDeclLine(source, "enum", e.name);
        if (eLine >= 0) {
          return { uri, range: { start: { line: eLine, character: 0 }, end: { line: eLine, character: 0 } } };
        }
      }
    }

    // Enum variant — `JsonVal.JFloat`. Clicking the variant should jump to its
    // declaration line inside the enum body (name-based, so a bare `JFloat`
    // resolves too). Only enums whose decl lives in this file; imported enums'
    // variants are handled by findInImportedFiles below.
    for (const e of program.enums) {
      if (e.variants.some(v => v.name === word)) {
        const vLine = findEnumVariantLine(source, e.name, word);
        if (vLine >= 0) {
          return { uri, range: { start: { line: vLine, character: 0 }, end: { line: vLine, character: 0 } } };
        }
      }
    }

    // Find type alias definition
    for (const ta of program.typeAliases) {
      if (ta.name === word) {
        const taLine = findDeclLine(source, "type", ta.name);
        if (taLine >= 0) {
          return { uri, range: { start: { line: taLine, character: 0 }, end: { line: taLine, character: 0 } } };
        }
      }
    }

    // Impl methods — `obj.method()` / `self.method()`. Methods live in
    // program.impls, not program.functions, so the loops above miss them and
    // cmd-click on a method call resolved nowhere. Name-based like the rest
    // (jumps to the first `fn <word>` in this file); imported-file methods are
    // already caught by findInImportedFiles' `fn <word>(` regex below.
    for (const impl of program.impls) {
      for (const m of impl.methods) {
        if (m.name === word) {
          const mLine = findFnLine(source, m.name);
          if (mLine >= 0) {
            return { uri, range: { start: { line: mLine, character: 0 }, end: { line: mLine, character: 0 } } };
          }
        }
      }
    }

    // Search imported files for the symbol
    const importedResult = findInImportedFiles(parsed, sourceDir, word);
    if (importedResult) return importedResult;

    // Find variable in enclosing function only — scope to cursor's fn
    const enclosing = findEnclosingFn(source, program, line);
    if (enclosing) {
      // Param match: locate name in fn signature line(s)
      for (const p of enclosing.fn.params) {
        if (p.name === word) {
          const ploc = findParamPos(source, enclosing.declLine, word);
          if (ploc) {
            return { uri, range: { start: { line: ploc.line, character: ploc.col }, end: { line: ploc.line, character: ploc.col } } };
          }
        }
      }
      for (const stmt of enclosing.fn.body) {
        const loc = findVarDecl(stmt, word);
        if (loc) {
          return { uri, range: { start: { line: loc.line - 1, character: loc.col - 1 }, end: { line: loc.line - 1, character: loc.col - 1 } } };
        }
      }
    }
  } catch (e) {
    process.stderr.write(`milod: definition parse error for word="${word}": ${e instanceof Error ? e.message : String(e)}\n`);
  }

  return null;
}

function findFnLine(source: string, name: string): number {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`\\bfn\\s+${name}\\s*\\(`))) return i;
  }
  return -1;
}

function findDeclLine(source: string, keyword: string, name: string): number {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`\\b${keyword}\\s+${name}\\b`))) return i;
  }
  return -1;
}

// Locate an enum variant's declaration line. Find the `enum NAME` line, then
// scan its brace-delimited body for `VARIANT` at the start of a line (variants
// carry no span). Returns -1 if the enum isn't in this source.
function findEnumVariantLine(source: string, enumName: string, variant: string): number {
  const lines = source.split("\n");
  const declRe = new RegExp(`\\benum\\s+${enumName}\\b`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return -1;
  const variantRe = new RegExp(`^\\s*${variant}\\b`);
  let depth = 0, seenBrace = false;
  for (let i = start; i < lines.length; i++) {
    if (i > start && variantRe.test(lines[i])) return i;
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; seenBrace = true; }
      else if (ch === "}") { depth--; }
    }
    if (seenBrace && depth === 0) break;
  }
  return -1;
}

function findVarDecl(stmt: Stmt, name: string): Span | null {
  if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.name === name && stmt.span) {
    return stmt.span;
  }
  if (stmt.kind === "IfStmt") {
    for (const s of stmt.thenBody) { const r = findVarDecl(s, name); if (r) return r; }
    if (stmt.elseBody) for (const s of stmt.elseBody) { const r = findVarDecl(s, name); if (r) return r; }
  }
  if (stmt.kind === "WhileStmt") {
    for (const s of stmt.body) { const r = findVarDecl(s, name); if (r) return r; }
  }
  if (stmt.kind === "MatchStmt") {
    for (const arm of stmt.arms) {
      if (arm.pattern.kind === "EnumPattern" && arm.pattern.bindings.includes(name) && arm.pattern.span) {
        return arm.pattern.span;
      }
      for (const s of arm.body) { const r = findVarDecl(s, name); if (r) return r; }
    }
  }
  if (stmt.kind === "ForInStmt") {
    if ((stmt.varName === name || stmt.varName2 === name) && stmt.span) return stmt.span;
    for (const s of stmt.body) { const r = findVarDecl(s, name); if (r) return r; }
  }
  if (stmt.kind === "IfLetStmt") {
    if (stmt.pattern.kind === "EnumPattern" && stmt.pattern.bindings.includes(name) && stmt.pattern.span) {
      return stmt.pattern.span;
    }
    for (const s of stmt.thenBody) { const r = findVarDecl(s, name); if (r) return r; }
    if (stmt.elseBody) for (const s of stmt.elseBody) { const r = findVarDecl(s, name); if (r) return r; }
  }
  if (stmt.kind === "LetElseStmt") {
    // The pattern binding escapes into the enclosing scope — its decl site.
    if (stmt.pattern.kind === "EnumPattern" && stmt.pattern.bindings.includes(name) && stmt.pattern.span) {
      return stmt.pattern.span;
    }
    for (const s of stmt.elseBody) { const r = findVarDecl(s, name); if (r) return r; }
  }
  return null;
}

// Locate enclosing fn by scanning source for `fn NAME(` line boundaries.
// Function AST has no span, so we use the declaration line as the boundary.
function findEnclosingFn(source: string, program: Program, line: number): { fn: Function; declLine: number } | null {
  const lines = source.split("\n");
  const decls: { fn: Function; declLine: number }[] = [];
  // Impl methods are Function[] too but live in program.impls — include them so
  // hover/goto scoping works inside method bodies (`self.x`), not just free fns.
  const allFns: Function[] = [...program.functions, ...program.impls.flatMap(i => i.methods)];
  for (const fn of allFns) {
    if (fn.isExtern) continue;
    const re = new RegExp(`\\bfn\\s+${fn.name}\\s*[<(]`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        decls.push({ fn, declLine: i });
        break;
      }
    }
  }
  decls.sort((a, b) => a.declLine - b.declLine);
  let match: { fn: Function; declLine: number } | null = null;
  for (const d of decls) {
    if (d.declLine <= line) match = d;
    else break;
  }
  return match;
}

// Find param identifier position on/after the fn declaration line.
// Params can span multiple lines; scan forward until matching close paren.
function findParamPos(source: string, declLine: number, name: string): { line: number; col: number } | null {
  const lines = source.split("\n");
  const re = new RegExp(`\\b${name}\\b`);
  let depth = 0;
  let started = false;
  for (let i = declLine; i < lines.length; i++) {
    const text = lines[i];
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") {
        depth--;
        if (started && depth === 0) {
          // Confine match search to signature portion seen so far
          for (let k = declLine; k <= i; k++) {
            const slice = k === i ? lines[k].slice(0, j) : lines[k];
            const m = slice.match(re);
            if (m && m.index !== undefined) return { line: k, col: m.index };
          }
          return null;
        }
      }
    }
  }
  return null;
}

// ── Completion ──

function getStdlibModules(): string[] {
  try {
    return readdirSync(resolve(STDLIB_DIR, "std"))
      .filter(f => f.endsWith(".milo") && !f.includes(".darwin.") && !f.includes(".linux."))
      .map(f => "std/" + f.replace(".milo", ""));
  } catch { return []; }
}

function getModuleExports(modulePath: string, sourceDir: string): { name: string; kind: string }[] {
  const absPath = resolveImportPath(sourceDir, modulePath);
  if (!absPath) return [];
  const src = readStd(absPath);
  if (src === null) return [];
  const exports: { name: string; kind: string }[] = [];
  for (const line of src.split("\n")) {
    let m;
    if ((m = line.match(/^fn\s+(\w+)\s*[<(]/)) && !m[1].startsWith("_")) exports.push({ name: m[1], kind: "function" });
    else if ((m = line.match(/^struct\s+(\w+)/)) && !m[1].startsWith("_")) exports.push({ name: m[1], kind: "struct" });
    else if ((m = line.match(/^enum\s+(\w+)/)) && !m[1].startsWith("_")) exports.push({ name: m[1], kind: "enum" });
    else if ((m = line.match(/^trait\s+(\w+)/)) && !m[1].startsWith("_")) exports.push({ name: m[1], kind: "trait" });
    else if ((m = line.match(/^let\s+(\w+)\s*:/)) && !m[1].startsWith("_")) exports.push({ name: m[1], kind: "variable" });
  }
  return exports;
}

function getLocalMiloFiles(sourceDir: string): string[] {
  try {
    return readdirSync(sourceDir)
      .filter(f => f.endsWith(".milo"))
      .map(f => f.replace(".milo", ""));
  } catch { return []; }
}

// LSP CompletionItemKind values
const CIK_FUNCTION = 3;
const CIK_STRUCT = 22;
const CIK_ENUM = 13;
const CIK_VARIABLE = 6;
const CIK_MODULE = 9;
const CIK_INTERFACE = 8; // trait

function completionKind(kind: string): number {
  switch (kind) {
    case "function": return CIK_FUNCTION;
    case "struct": return CIK_STRUCT;
    case "enum": return CIK_ENUM;
    case "variable": return CIK_VARIABLE;
    case "trait": return CIK_INTERFACE;
    default: return CIK_VARIABLE;
  }
}

function handleCompletion(uri: string, line: number, character: number): object {
  const source = documents.get(uri) ?? "";
  const lines = source.split("\n");
  const lineText = lines[line] ?? "";
  const prefix = lineText.slice(0, character);
  const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";

  // Context 1: from " → suggest module paths
  const fromQuote = prefix.match(/from\s+"([^"]*)$/);
  if (fromQuote) {
    const partial = fromQuote[1];
    const items: object[] = [];
    for (const mod of getStdlibModules()) {
      if (mod.startsWith(partial)) {
        items.push({ label: mod, kind: CIK_MODULE, insertText: mod });
      }
    }
    // local files
    for (const f of getLocalMiloFiles(sourceDir)) {
      const path = f + ".milo";
      if (path.startsWith(partial)) {
        items.push({ label: path, kind: CIK_MODULE, insertText: path });
      }
    }
    return { isIncomplete: false, items };
  }

  // Context 2: from "mod" import { → suggest module exports
  const importBrace = prefix.match(/from\s+"([^"]+)"\s+import\s+\{\s*(?:[\w,\s]*,\s*)?(\w*)$/);
  if (importBrace) {
    const modulePath = importBrace[1];
    const partial = importBrace[2] ?? "";
    const exports = getModuleExports(modulePath, sourceDir);
    // filter out already-imported symbols
    const alreadyImported = new Set(
      (prefix.match(/\{\s*(.*)/)?.[1] ?? "").split(",").map(s => s.trim()).filter(s => s && s !== partial)
    );
    const items = exports
      .filter(e => e.name.startsWith(partial) && !alreadyImported.has(e.name))
      .map(e => ({ label: e.name, kind: completionKind(e.kind) }));
    return { isIncomplete: false, items };
  }

  // Context 3: general code completion — symbols from imports + builtins
  const wordMatch = prefix.match(/(\w+)$/);
  const partial = wordMatch?.[1] ?? "";
  if (partial.length < 1) return { isIncomplete: false, items: [] };

  const items: object[] = [];
  const seen = new Set<string>();

  // builtins
  for (const b of ["print", "eprint", "format", "jsonStringify", "embedFile", "flush", "max", "min"]) {
    if (b.startsWith(partial) && !seen.has(b)) {
      seen.add(b);
      items.push({ label: b, kind: CIK_FUNCTION, detail: "builtin" });
    }
  }

  // symbols from imported modules
  try {
    const tokens = new Lexer(source).tokenize();
    const parsed = new Parser(tokens).parse();

    for (const imp of parsed.imports) {
      const exports = getModuleExports(imp.path, sourceDir);
      for (const e of exports) {
        if (e.name.startsWith(partial) && !seen.has(e.name)) {
          seen.add(e.name);
          items.push({ label: e.name, kind: completionKind(e.kind), detail: imp.path });
        }
      }
    }

    // local symbols
    for (const fn of parsed.functions) {
      if (fn.name.startsWith(partial) && !fn.isExtern && !seen.has(fn.name)) {
        seen.add(fn.name);
        items.push({ label: fn.name, kind: CIK_FUNCTION });
      }
    }
    for (const s of parsed.structs) {
      if (s.name.startsWith(partial) && !seen.has(s.name)) {
        seen.add(s.name);
        items.push({ label: s.name, kind: CIK_STRUCT });
      }
    }
    for (const e of parsed.enums) {
      if (e.name.startsWith(partial) && !seen.has(e.name)) {
        seen.add(e.name);
        items.push({ label: e.name, kind: CIK_ENUM });
      }
    }
  } catch {}

  return { isIncomplete: false, items };
}

// ── CodeLens ──

function handleCodeLens(uri: string): object[] {
  const source = documents.get(uri);
  if (!source) return [];

  const lenses: object[] = [];
  const lines = source.split("\n");
  const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;

  // "▶ Run" on fn main()
  for (let i = 0; i < lines.length; i++) {
    if (/\bfn\s+main\s*\(/.test(lines[i])) {
      lenses.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } },
        command: { title: "▶ Run", command: "milo.runFile", arguments: [filePath] },
      });
      break;
    }
  }

  // "▶ Run Test" on test fixtures (files with @expect: or @error: annotations)
  const hasExpect = lines.some(l => /\/\/\s*@expect:/.test(l));
  const hasError = lines.some(l => /\/\/\s*@error:/.test(l));
  if (hasExpect || hasError) {
    lenses.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      command: { title: "▶ Run Test", command: "milo.runTest", arguments: [filePath] },
    });
  }

  return lenses;
}

// ── Shared: identifier occurrences (text-based) ──
// milod's semantics are name-based (like hover/definition): we scan source text
// for whole-word matches, skipping string literals and line comments. Not
// scope-aware — a v1 that matches the rest of the server. Multi-line strings are
// not handled (Milo string literals are single-line).
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function isInStringOrComment(line: string, idx: number): boolean {
  let inStr = false;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr && c === "/" && line[i + 1] === "/") return true;
  }
  return inStr;
}

function wordOccurrences(source: string, word: string): { line: number; startCol: number }[] {
  const out: { line: number; startCol: number }[] = [];
  const lines = source.split("\n");
  const re = new RegExp(`\\b${escapeRe(word)}\\b`, "g");
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      if (!isInStringOrComment(lines[i], m.index)) out.push({ line: i, startCol: m.index });
    }
  }
  return out;
}

function nameRangeOnLine(source: string, line: number, name: string): object {
  const text = source.split("\n")[line] ?? "";
  const col = Math.max(0, text.indexOf(name));
  return { start: { line, character: col }, end: { line, character: col + name.length } };
}

function fullLineRange(source: string, line: number): object {
  const text = source.split("\n")[line] ?? "";
  return { start: { line, character: 0 }, end: { line, character: text.length } };
}

function posToOffset(source: string, line: number, character: number): number {
  const lines = source.split("\n");
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  return off + character;
}

function offsetToPos(source: string, offset: number): { line: number; character: number } {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") { line++; col = 0; } else col++;
  }
  return { line, character: col };
}

// ── Document symbols (outline) ──

function handleDocumentSymbol(uri: string): object[] {
  const source = documents.get(uri);
  if (!source) return [];
  const lines = source.split("\n");
  const lineLen = (l: number) => (lines[l] ?? "").length;
  // selectionRange must be a subrange of range, and children must be contained
  // in their parent — VS Code rejects the whole response otherwise. So we clamp
  // the name range to its line and span containers over their members.
  const nameRange = (l: number, name: string) => {
    const t = lines[l] ?? "";
    const idx = t.indexOf(name);
    const c = idx >= 0 ? idx : 0;
    const e = idx >= 0 ? c + name.length : t.length;
    return { start: { line: l, character: c }, end: { line: l, character: e } };
  };
  const leaf = (name: string, kind: number, l: number) => ({
    name, kind,
    range: { start: { line: l, character: 0 }, end: { line: l, character: lineLen(l) } },
    selectionRange: nameRange(l, name),
  });
  const container = (name: string, kind: number, declLine: number, children: any[]) => {
    const last = children.length
      ? Math.max(declLine, ...children.map(c => c.range.end.line))
      : declLine;
    return {
      name, kind,
      range: { start: { line: declLine, character: 0 }, end: { line: last, character: lineLen(last) } },
      selectionRange: nameRange(declLine, name),
      ...(children.length ? { children } : {}),
    };
  };
  // First line at/after `start` that mentions `name` — locates a member's own
  // line rather than pinning it to the parent's declaration line.
  const memberLine = (start: number, name: string) => {
    const re = new RegExp(`\\b${escapeRe(name)}\\b`);
    for (let i = start; i < lines.length; i++) if (re.test(lines[i])) return i;
    return start;
  };
  try {
    const parsed = new Parser(new Lexer(source).tokenize()).parse();
    const out: object[] = [];
    for (const f of parsed.functions) {
      if (f.isExtern) continue;
      const line = findFnLine(source, f.name);
      if (line >= 0) out.push(leaf(f.name, 12 /*Function*/, line));
    }
    for (const s of parsed.structs) {
      const line = findDeclLine(source, "struct", s.name);
      if (line < 0) continue;
      const fields = s.fields.map(fl => leaf(fl.name, 8 /*Field*/, memberLine(line, fl.name)));
      out.push(container(s.name, 23 /*Struct*/, line, fields));
    }
    for (const e of parsed.enums) {
      const line = findDeclLine(source, "enum", e.name);
      if (line < 0) continue;
      const variants = e.variants.map(v => leaf(v.name, 22 /*EnumMember*/, memberLine(line, v.name)));
      out.push(container(e.name, 10 /*Enum*/, line, variants));
    }
    for (const ta of parsed.typeAliases) {
      const line = findDeclLine(source, "type", ta.name);
      if (line >= 0) out.push(leaf(ta.name, 5 /*Class*/, line));
    }
    for (const iface of parsed.interfaces) {
      const line = findDeclLine(source, "interface", iface.name);
      if (line < 0) continue;
      const methods = iface.methods.map(m => leaf(m.name, 6 /*Method*/, memberLine(line, m.name)));
      out.push(container(iface.name, 11 /*Interface*/, line, methods));
    }
    for (const impl of parsed.impls) {
      const line = findDeclLine(source, "impl", impl.typeName);
      if (line < 0) continue;
      const methods = impl.methods.map(m => {
        const mLine = findFnLine(source, m.name);
        return leaf(m.name, 6 /*Method*/, mLine >= 0 ? mLine : line);
      });
      out.push(container(`impl ${impl.typeName}`, 5 /*Class*/, line, methods));
    }
    return out;
  } catch { return []; }
}

// ── Code actions (quickfix from diagnostics) ──

function handleCodeAction(uri: string, range: any): object[] {
  const source = documents.get(uri);
  if (!source) return [];
  let diags: Diagnostic[] = [];
  try {
    const parsed = new Parser(new Lexer(source).tokenize()).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);
    diags = new TypeChecker().check(program).diagnostics;
  } catch { return []; }

  const actions: object[] = [];
  for (const d of diags) {
    if (d.code !== "unused-unsafe" || !d.span) continue;
    // Only offer the fix if the diagnostic sits within the requested range's lines.
    const dl = d.span.line - 1;
    if (dl < range.start.line || dl > range.end.line) continue;
    const edit = unwrapUnsafeEdit(source, d.span.line - 1, d.span.col - 1);
    if (!edit) continue;
    actions.push({
      title: "Remove unnecessary 'unsafe'",
      kind: "quickfix",
      diagnostics: [{
        range: { start: { line: dl, character: d.span.col - 1 }, end: { line: dl, character: d.span.col } },
        severity: 2, source: "milo", message: d.message,
      }],
      edit: { changes: { [uri]: [edit] } },
    });
  }
  return actions;
}

// Unwrap `unsafe { X }` -> `X` at the given 0-based position of the `unsafe` keyword.
function unwrapUnsafeEdit(source: string, line: number, col: number): object | null {
  const start = posToOffset(source, line, col);
  if (source.slice(start, start + 6) !== "unsafe") return null;
  const open = source.indexOf("{", start + 6);
  if (open < 0) return null;
  let depth = 0, close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const inner = source.slice(open + 1, close).trim();
  return {
    range: { start: offsetToPos(source, start), end: offsetToPos(source, close + 1) },
    newText: inner,
  };
}

// ── Signature help ──

function handleSignatureHelp(uri: string, line: number, character: number): object | null {
  const source = documents.get(uri);
  if (!source) return null;
  const lineText = (source.split("\n")[line] ?? "").slice(0, character);
  // Walk left to the open paren of the enclosing call, tracking nesting.
  let depth = 0, openIdx = -1;
  for (let i = lineText.length - 1; i >= 0; i--) {
    const c = lineText[i];
    if (c === ")") depth++;
    else if (c === "(") { if (depth === 0) { openIdx = i; break; } depth--; }
  }
  if (openIdx < 0) return null;
  const name = getWordAt(source, line, openIdx - 1);
  if (!name) return null;
  // Active parameter = top-level commas between the open paren and the cursor.
  let active = 0, d2 = 0;
  for (let i = openIdx + 1; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === "(" || c === "[") d2++;
    else if (c === ")" || c === "]") d2--;
    else if (c === "," && d2 === 0) active++;
  }
  try {
    const parsed = new Parser(new Lexer(source).tokenize()).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);
    const mk = (label: string, params: string[]) => ({
      signatures: [{ label, parameters: params.map(p => ({ label: p })) }],
      activeSignature: 0, activeParameter: Math.min(active, Math.max(0, params.length - 1)),
    });
    const f = program.functions.find(fn => fn.name === name && !fn.isExtern);
    if (f) {
      const ps = f.params.map(p => `${p.name}: ${formatMiloType(declaredType(p))}`);
      return mk(`fn ${f.name}(${ps.join(", ")}): ${formatMiloType(f.retType)}`, ps);
    }
    for (const impl of program.impls) {
      for (const m of impl.methods) {
        if (m.name === name) {
          const ps = m.params.filter(p => p.name !== "self").map(p => `${p.name}: ${formatMiloType(declaredType(p))}`);
          return mk(`fn ${impl.typeName}.${m.name}(${ps.join(", ")}): ${formatMiloType(m.retType)}`, ps);
        }
      }
    }
  } catch { return null; }
  return null;
}

// ── Inlay hints: elided &mut at callsites ──
// Milo omits `&mut` at the callsite (second-class refs — see docs/design.md); the
// reader-side visibility is delegated here. For every call argument bound to a
// `&mut T` param — and for a `&mut self` receiver — we render a `&mut` hint at the
// argument's start position, so mutation intent is visible without baking a marker
// into the syntax.

type TK = import("./types").TypeKind;

// Underlying nominal name of a type (through refs/heap), or null when there's no
// user-facing impl name to match an impl block against.
function typeKindName(tk: TK | undefined): string | null {
  if (!tk) return null;
  switch (tk.tag) {
    case "ref": return typeKindName(tk.inner);
    case "heap": return typeKindName(tk.inner);
    case "struct": case "enum": case "interface": return tk.name;
    case "vec": return "Vec";
    case "hashmap": return "HashMap";
    default: return null;
  }
}

// Visit every sub-expression of `e` (and `e` itself), descending into nested
// statement bodies (closures, if/match expressions).
function visitExpr(e: Expr, cb: (e: Expr) => void) {
  cb(e);
  switch (e.kind) {
    case "BinOp": visitExpr(e.left, cb); visitExpr(e.right, cb); break;
    case "UnaryOp": visitExpr(e.operand, cb); break;
    case "Call": for (const a of e.args) visitExpr(a, cb); break;
    case "StructLit": for (const f of e.fields) visitExpr(f.value, cb); break;
    case "FieldAccess": visitExpr(e.object, cb); break;
    case "ArrayLit": for (const el of e.elements) visitExpr(el, cb); break;
    case "ArrayRepeat": visitExpr(e.value, cb); break;
    case "IndexAccess": visitExpr(e.object, cb); visitExpr(e.index, cb); break;
    case "EnumLit": for (const a of e.args) visitExpr(a, cb); break;
    case "Unwrap": case "Propagate": case "IsExpr": visitExpr(e.operand, cb); break;
    case "DefaultValue": visitExpr(e.operand, cb); visitExpr(e.default, cb); break;
    case "CastExpr": visitExpr(e.operand, cb); break;
    case "MethodCall": visitExpr(e.object, cb); for (const a of e.args) visitExpr(a, cb); break;
    case "Closure": for (const s of e.body) visitStmtExprs(s, cb); break;
    case "RangeExpr": visitExpr(e.start, cb); visitExpr(e.end, cb); break;
    case "IfExpr":
      visitExpr(e.cond, cb);
      for (const s of e.thenBody) visitStmtExprs(s, cb);
      for (const s of e.elseBody) visitStmtExprs(s, cb);
      break;
    case "MatchExpr":
      visitExpr(e.subject, cb);
      for (const arm of e.arms) for (const s of arm.body) visitStmtExprs(s, cb);
      break;
  }
}

function visitStmtExprs(s: Stmt, cb: (e: Expr) => void) {
  switch (s.kind) {
    case "LetDecl": case "VarDecl": visitExpr(s.value, cb); break;
    case "Assign": visitExpr(s.target, cb); visitExpr(s.value, cb); break;
    case "Return": if (s.value) visitExpr(s.value, cb); break;
    case "ExprStmt": visitExpr(s.expr, cb); break;
    case "IfStmt":
      visitExpr(s.cond, cb);
      for (const st of s.thenBody) visitStmtExprs(st, cb);
      if (s.elseBody) for (const st of s.elseBody) visitStmtExprs(st, cb);
      break;
    case "WhileStmt":
      visitExpr(s.cond, cb);
      for (const st of s.body) visitStmtExprs(st, cb);
      break;
    case "MatchStmt":
      visitExpr(s.subject, cb);
      for (const arm of s.arms) for (const st of arm.body) visitStmtExprs(st, cb);
      break;
    case "IfLetStmt":
      visitExpr(s.subject, cb);
      for (const st of s.thenBody) visitStmtExprs(st, cb);
      if (s.elseBody) for (const st of s.elseBody) visitStmtExprs(st, cb);
      break;
    case "LetElseStmt":
      visitExpr(s.value, cb);
      for (const st of s.elseBody) visitStmtExprs(st, cb);
      break;
    case "ForInStmt":
      visitExpr(s.iterable, cb);
      for (const st of s.body) visitStmtExprs(st, cb);
      break;
    case "UnsafeBlock":
      for (const st of s.body) visitStmtExprs(st, cb);
      break;
  }
}

function handleInlayHint(uri: string, range: any): object[] {
  const source = documents.get(uri);
  if (!source) return [];

  let program: Program;
  // Walk only THIS file's decls: resolveImports merges std's functions/impls into
  // `program`, and their internal callsites carry spans in their own files — plotting
  // those onto this document produces hundreds of bogus mid-token hints. `parsed`
  // holds just the local decls; `program` is still used to look up callee params.
  let parsed: Program;
  let exprTypes: Map<Expr, TK> = new Map();
  try {
    parsed = new Parser(new Lexer(source).tokenize()).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    program = resolveImports(parsed, sourceDir, hostTarget, uri.startsWith("file://") ? fileURLToPath(uri) : uri);
    try { exprTypes = new TypeChecker().check(program).exprTypes ?? new Map(); } catch {}
  } catch { return []; }

  const startLine = range?.start?.line ?? 0;
  const endLine = range?.end?.line ?? Number.MAX_SAFE_INTEGER;

  // free functions by name; impl methods grouped by name (ambiguity resolved via
  // the receiver's inferred type where possible).
  const fnByName = new Map<string, Function>();
  for (const fn of program.functions) if (!fn.isExtern) fnByName.set(fn.name, fn);
  const methodsByName = new Map<string, { typeName: string; fn: Function }[]>();
  for (const impl of program.impls) {
    for (const m of impl.methods) {
      (methodsByName.get(m.name) ?? methodsByName.set(m.name, []).get(m.name)!)
        .push({ typeName: impl.typeName, fn: m });
    }
  }

  const hints: object[] = [];
  const pushHint = (span: Span | undefined) => {
    if (!span) return;
    const line = span.line - 1;
    if (line < startLine || line > endLine) return;
    hints.push({
      position: { line, character: span.col - 1 },
      label: "&mut",
      kind: 2, // Parameter
      paddingRight: true,
    });
  };

  const process = (e: Expr) => {
    if (e.kind === "Call") {
      const fn = fnByName.get(e.func);
      if (!fn) return;
      e.args.forEach((arg, i) => {
        if (fn.params[i]?.type?.isRefMut) pushHint(arg.span);
      });
    } else if (e.kind === "MethodCall") {
      const cands = methodsByName.get(e.method);
      if (!cands || cands.length === 0) return;
      // Disambiguate overloaded method names by the receiver's inferred type;
      // fall back only when every candidate agrees on which params are &mut.
      let chosen: Function | null = null;
      if (cands.length === 1) chosen = cands[0].fn;
      else {
        const recvName = typeKindName(exprTypes.get(e.object));
        const byType = recvName ? cands.filter(c => c.typeName === recvName) : [];
        if (byType.length === 1) chosen = byType[0].fn;
        else {
          const sig = (fn: Function) => fn.params.map(p => p.type?.isRefMut ? "1" : "0").join("");
          const first = sig(cands[0].fn);
          if (cands.every(c => sig(c.fn) === first)) chosen = cands[0].fn;
        }
      }
      if (!chosen) return;
      const params = chosen.params;
      if (params[0]?.name === "self") {
        if (params[0].type?.isRefMut) pushHint(e.object.span);
        e.args.forEach((arg, i) => {
          if (params[i + 1]?.type?.isRefMut) pushHint(arg.span);
        });
      } else {
        e.args.forEach((arg, i) => {
          if (params[i]?.type?.isRefMut) pushHint(arg.span);
        });
      }
    }
  };

  for (const fn of parsed.functions) {
    if (fn.isExtern) continue;
    for (const s of fn.body) visitStmtExprs(s, process);
  }
  for (const impl of parsed.impls) {
    for (const m of impl.methods) for (const s of m.body) visitStmtExprs(s, process);
  }
  return hints;
}

// ── References / document highlight / rename (text-based, across open docs) ──

function walkMiloFiles(dir: string, acc: string[]): void {
  let entries: import("fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // Skip dotdirs (.git, .worktrees, .claude) and vendored deps.
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walkMiloFiles(full, acc);
    else if (e.name.endsWith(".milo")) acc.push(full);
  }
}

// All in-scope Milo sources: project files on disk, overlaid with open buffers
// (open content wins, so refs/rename reflect unsaved edits). Falls back to just
// the open buffers when no workspace root was provided.
function projectSources(): Map<string, string> {
  const out = new Map<string, string>();
  if (workspaceRoot) {
    const files: string[] = [];
    walkMiloFiles(workspaceRoot, files);
    for (const f of files) {
      try { out.set(pathToFileURL(f).href, readFileSync(f, "utf-8")); } catch {}
    }
  }
  for (const [uri, src] of documents) out.set(uri, src);
  return out;
}

function referenceLocations(word: string): { uri: string; line: number; startCol: number }[] {
  const locs: { uri: string; line: number; startCol: number }[] = [];
  for (const [docUri, src] of projectSources()) {
    for (const occ of wordOccurrences(src, word)) locs.push({ uri: docUri, ...occ });
  }
  return locs;
}

function handleReferences(uri: string, line: number, character: number): object[] {
  const source = documents.get(uri);
  if (!source) return [];
  const word = getWordAt(source, line, character);
  if (!word) return [];
  return referenceLocations(word).map(l => ({
    uri: l.uri,
    range: { start: { line: l.line, character: l.startCol }, end: { line: l.line, character: l.startCol + word.length } },
  }));
}

function handleDocumentHighlight(uri: string, line: number, character: number): object[] {
  const source = documents.get(uri);
  if (!source) return [];
  const word = getWordAt(source, line, character);
  if (!word) return [];
  return wordOccurrences(source, word).map(o => ({
    range: { start: { line: o.line, character: o.startCol }, end: { line: o.line, character: o.startCol + word.length } },
    kind: 1 /*Text*/,
  }));
}

// The enclosing fn's line span: from its decl line to just before the next fn's.
// Coarse, but it matches how findEnclosingFn already scopes hover/goto.
function enclosingFnLineRange(source: string, program: Program, line: number): { start: number; end: number } | null {
  const lines = source.split("\n");
  const declLines: number[] = [];
  const allFns: Function[] = [...program.functions, ...program.impls.flatMap(i => i.methods)];
  for (const fn of allFns) {
    if (fn.isExtern) continue;
    const re = new RegExp(`\\bfn\\s+${escapeRe(fn.name)}\\s*[<(]`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { declLines.push(i); break; }
    }
  }
  declLines.sort((a, b) => a - b);
  let start = -1;
  for (const d of declLines) {
    if (d <= line) start = d; else break;
  }
  if (start < 0) return null;
  const next = declLines.find(d => d > start);
  return { start, end: (next ?? lines.length) - 1 };
}

// Is `word` a param or local of the fn containing `line`? Locals shadow globals
// (innermost binding wins), so this is checked before any global treatment.
function isFnLocalBinding(source: string, program: Program, line: number, word: string): boolean {
  const enclosing = findEnclosingFn(source, program, line);
  if (!enclosing) return false;
  if (enclosing.fn.params.some(p => p.name === word)) return true;
  for (const stmt of enclosing.fn.body) {
    if (findVarDecl(stmt, word)) return true;
  }
  return false;
}

// Rename is the one WRITE among these name-based features, and that changes the stakes:
// the same text-matching that is merely imprecise for hover/references silently
// CORRUPTS code here. `a` in `fn f(a)` and `a` in `fn g(a)` are unrelated bindings that
// happen to share a name, so a workspace-wide word replace rewrites both. Params and
// locals are therefore confined to their own function in their own file; only top-level
// names (fn/struct/enum) keep the workspace-wide rename, where sharing a name across
// files really does mean the same symbol.
function handleRename(uri: string, line: number, character: number, newName: string): object | null {
  const source = documents.get(uri);
  if (!source) return null;
  const word = getWordAt(source, line, character);
  if (!word) return null;

  try {
    const program = new Parser(new Lexer(source).tokenize()).parse();
    if (isFnLocalBinding(source, program, line, word)) {
      const r = enclosingFnLineRange(source, program, line);
      if (r) {
        const edits = wordOccurrences(source, word)
          .filter(o => o.line >= r.start && o.line <= r.end)
          .map(o => ({
            range: { start: { line: o.line, character: o.startCol }, end: { line: o.line, character: o.startCol + word.length } },
            newText: newName,
          }));
        return { changes: { [uri]: edits } };
      }
    }
  } catch (e) {
    process.stderr.write(`milod: rename parse error for word="${word}": ${e instanceof Error ? e.message : String(e)}\n`);
  }

  const changes: Record<string, object[]> = {};
  for (const l of referenceLocations(word)) {
    (changes[l.uri] ??= []).push({
      range: { start: { line: l.line, character: l.startCol }, end: { line: l.line, character: l.startCol + word.length } },
      newText: newName,
    });
  }
  return { changes };
}

// ── Workspace symbols ──

function handleWorkspaceSymbol(query: string): object[] {
  const q = query.toLowerCase();
  const out: object[] = [];
  const push = (name: string, kind: number, uri: string, line: number) => {
    if (q && !name.toLowerCase().includes(q)) return;
    out.push({ name, kind, location: { uri, range: nameRangeOnLine(documents.get(uri) ?? "", line, name) } });
  };
  for (const [uri, src] of documents) {
    try {
      const parsed = new Parser(new Lexer(src).tokenize()).parse();
      for (const f of parsed.functions) { if (f.isExtern) continue; const ln = findFnLine(src, f.name); if (ln >= 0) push(f.name, 12, uri, ln); }
      for (const s of parsed.structs) { const ln = findDeclLine(src, "struct", s.name); if (ln >= 0) push(s.name, 23, uri, ln); }
      for (const e of parsed.enums) { const ln = findDeclLine(src, "enum", e.name); if (ln >= 0) push(e.name, 10, uri, ln); }
      for (const ta of parsed.typeAliases) { const ln = findDeclLine(src, "type", ta.name); if (ln >= 0) push(ta.name, 5, uri, ln); }
    } catch {}
  }
  return out;
}

// ── Request dispatch ──

function handleRequest(id: number | string, method: string, params: any) {
  switch (method) {
    case "initialize": {
      const rootUriStr = params?.workspaceFolders?.[0]?.uri ?? params?.rootUri
        ?? (params?.rootPath ? pathToFileURL(params.rootPath).href : null);
      workspaceRoot = rootUriStr
        ? (rootUriStr.startsWith("file://") ? fileURLToPath(rootUriStr) : rootUriStr)
        : null;
      sendResponse(id, {
        capabilities: {
          textDocumentSync: 1, // full sync
          hoverProvider: true,
          definitionProvider: true,
          documentFormattingProvider: true,
          completionProvider: { triggerCharacters: ['"', "{", "."] },
          codeLensProvider: { resolveProvider: false },
          documentSymbolProvider: true,
          codeActionProvider: true,
          signatureHelpProvider: { triggerCharacters: ["(", ","] },
          referencesProvider: true,
          documentHighlightProvider: true,
          renameProvider: true,
          workspaceSymbolProvider: true,
          inlayHintProvider: true,
        },
        serverInfo: { name: "milod", version: "0.1.0" },
      });
      break;
    }
    case "shutdown":
      sendResponse(id, null);
      break;
    case "textDocument/hover":
      sendResponse(id, handleHover(params.textDocument.uri, params.position.line, params.position.character));
      break;
    case "textDocument/definition": {
      const word = getWordAt(documents.get(params.textDocument.uri) ?? "", params.position.line, params.position.character);
      const result = handleDefinition(params.textDocument.uri, params.position.line, params.position.character);
      process.stderr.write(`milod: definition word="${word}" docs=${documents.size} result=${JSON.stringify(result)}\n`);
      sendResponse(id, result);
      break;
    }
    case "textDocument/completion":
      sendResponse(id, handleCompletion(params.textDocument.uri, params.position.line, params.position.character));
      break;
    case "textDocument/codeLens":
      sendResponse(id, handleCodeLens(params.textDocument.uri));
      break;
    case "textDocument/documentSymbol":
      sendResponse(id, handleDocumentSymbol(params.textDocument.uri));
      break;
    case "textDocument/codeAction":
      sendResponse(id, handleCodeAction(params.textDocument.uri, params.range));
      break;
    case "textDocument/signatureHelp":
      sendResponse(id, handleSignatureHelp(params.textDocument.uri, params.position.line, params.position.character));
      break;
    case "textDocument/references":
      sendResponse(id, handleReferences(params.textDocument.uri, params.position.line, params.position.character));
      break;
    case "textDocument/documentHighlight":
      sendResponse(id, handleDocumentHighlight(params.textDocument.uri, params.position.line, params.position.character));
      break;
    case "textDocument/rename":
      sendResponse(id, handleRename(params.textDocument.uri, params.position.line, params.position.character, params.newName));
      break;
    case "workspace/symbol":
      sendResponse(id, handleWorkspaceSymbol(params.query ?? ""));
      break;
    case "textDocument/inlayHint":
      sendResponse(id, handleInlayHint(params.textDocument.uri, params.range));
      break;
    case "textDocument/formatting": {
      const source = documents.get(params.textDocument.uri) ?? "";
      if (!source) { sendResponse(id, null); break; }
      try {
        const formatted = formatSource(source);
        if (formatted === source) { sendResponse(id, []); break; }
        const lines = source.split("\n");
        sendResponse(id, [{
          range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } },
          newText: formatted,
        }]);
      } catch {
        sendResponse(id, null);
      }
      break;
    }
    default:
      sendResponse(id, null);
  }
}

function handleNotification(method: string, params: any) {
  switch (method) {
    case "initialized":
      break;
    case "textDocument/didOpen":
      documents.set(params.textDocument.uri, params.textDocument.text);
      validateDocument(params.textDocument.uri);
      break;
    case "textDocument/didChange":
      documents.set(params.textDocument.uri, params.contentChanges[0].text);
      validateDocument(params.textDocument.uri);
      break;
    case "textDocument/didClose":
      documents.delete(params.textDocument.uri);
      break;
    case "exit":
      process.exit(0);
  }
}

// ── Stdio transport reader ──

function startServer() {
  // Use raw Buffers, not utf-8 strings: Content-Length is byte count, but
  // string-mode slicing counts characters — multibyte UTF-8 bodies (or chunks
  // that split mid-codepoint) get misaligned and JSON.parse fails.
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;

      const header = buffer.slice(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

      const contentLength = parseInt(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf-8");
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && msg.method) {
          process.stderr.write(`milod: req ${msg.method}\n`);
          if (LSP_DEBUG) lspDebug(`req ${msg.method} params=${JSON.stringify(msg.params)}`);
          handleRequest(msg.id, msg.method, msg.params);
        } else if (msg.method) {
          process.stderr.write(`milod: notif ${msg.method}\n`);
          handleNotification(msg.method, msg.params);
        }
      } catch (e: any) {
        process.stderr.write(`milod: parse error ${e.message}\n`);
      }
    }
  });

  // Identify exactly which server this is — critical when multiple milo
  // checkouts exist and a stale one could be answering (restarts won't help then).
  process.stderr.write(
    `milod: language server started — pid=${process.pid} runtime=${process.execPath} ` +
    `entry=${fileURLToPath(import.meta.url)} cwd=${process.cwd()} debug=${LSP_DEBUG ? "on" : "off"}\n`,
  );
}

startServer();
