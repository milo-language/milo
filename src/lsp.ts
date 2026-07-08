// milod — Milo Language Server
// Speaks LSP over JSON-RPC/stdio. Provides diagnostics, hover, go-to-definition.

import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker, type CheckResult } from "./checker";
import { resolveImports } from "./resolver";
import { ParseError, type Diagnostic } from "./diagnostics";
import type { Program, Function, Stmt, Expr, Span } from "./ast";
import { typeName as formatTypeName } from "./types";
import { getHostTarget } from "./target";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync, readFileSync, readdirSync } from "fs";
import { format as tsFormat } from "./formatter";
import { spawnSync } from "child_process";

const hostTarget = getHostTarget();

// ── Formatter ──
// Use the Milo-native formatter binary when available, fall back to TS implementation.
const fmtBinaryPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "milo-fmt");
const hasMiloFmt = existsSync(fmtBinaryPath);

function formatSource(source: string): string {
  if (hasMiloFmt) {
    const result = spawnSync(fmtBinaryPath, [], { input: source, encoding: "utf-8", timeout: 5000 });
    if (result.status === 0 && result.stdout) return result.stdout;
  }
  return tsFormat(source);
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
      symbols.push({ name: p.name, kind: "variable", type: p.type.name, uri });
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
        const declType = stmt.type?.name ?? inferLiteralType(stmt.value);
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
    case "IntLit": return "i32";
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
  if (t.isPtr) return `*${base}`;
  return base;
}

// ── Doc comment extraction ──

function extractDocComment(source: string, declLineIndex: number): string | null {
  const lines = source.split("\n");
  const comments: string[] = [];
  for (let i = declLineIndex - 1; i >= 0; i--) {
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
    let fileSource: string;
    try { fileSource = readFileSync(absPath, "utf-8"); } catch { continue; }

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
        end: { line: d.span.line - 1, character: d.span.col },
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

    // Variable declarations — only when hovering on the variable name itself
    for (const fn of program.functions) {
      if (fn.isExtern) continue;
      for (const stmt of fn.body) {
        const info = findHoverInStmt(stmt, line + 1, character + 1, exprTypes, word);
        if (info) return { contents: { kind: "markdown", value: `\`\`\`milo\n${info}\n\`\`\`` } };
      }
    }

    // Free functions
    const f = program.functions.find(fn => fn.name === word && !fn.isExtern);
    if (f) {
      const params = f.params.map(p => `${p.name}: ${formatMiloType(p.type)}`).join(", ");
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
            .map(p => `${p.name}: ${formatMiloType(p.type)}`).join(", ");
          const sig = `fn ${impl.typeName}.${method.name}(${params}): ${formatMiloType(method.retType)}`;
          let hover = `\`\`\`milo\n${sig}\n\`\`\``;
          hover = appendDocAndModule(hover, source, parsed, sourceDir, word, "fn");
          return { contents: { kind: "markdown", value: hover } };
        }
      }
    }

    // Enums and variants
    const enumHover = findEnumHover(source, program, word, line, character, parsed, sourceDir);
    if (enumHover) return { contents: { kind: "markdown", value: enumHover } };

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
          const params = m.params.map(p => `${p.name}: ${formatMiloType(p.type)}`).join(", ");
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
          return { contents: { kind: "markdown", value: `\`\`\`milo\n${p.name}: ${formatMiloType(p.type)}\n\`\`\`` } };
        }
      }
      const varHover = findVarHover(enclosing.fn.body, word, exprTypes);
      if (varHover) return { contents: { kind: "markdown", value: `\`\`\`milo\n${varHover}\n\`\`\`` } };
    }
  } catch (e) {
    process.stderr.write(`milod: hover parse error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  return null;
}

function findVarHover(stmts: Stmt[], word: string, exprTypes: Map<Expr, import("./types").TypeKind>): string | null {
  for (const stmt of stmts) {
    if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.name === word) {
      let resolved = stmt.type?.name ?? inferLiteralType(stmt.value);
      if (!resolved) {
        const tk = exprTypes.get(stmt.value);
        if (tk) resolved = formatTypeName(tk);
      }
      if (resolved) return `${stmt.kind === "LetDecl" ? "let" : "var"} ${stmt.name}: ${resolved}`;
    }
    if (stmt.kind === "IfStmt") {
      const r = findVarHover(stmt.thenBody, word, exprTypes); if (r) return r;
      if (stmt.elseBody) { const r2 = findVarHover(stmt.elseBody, word, exprTypes); if (r2) return r2; }
    }
    if (stmt.kind === "WhileStmt") {
      const r = findVarHover(stmt.body, word, exprTypes); if (r) return r;
    }
    if (stmt.kind === "MatchStmt") {
      for (const arm of stmt.arms) {
        const r = findVarHover(arm.body, word, exprTypes); if (r) return r;
      }
    }
    if (stmt.kind === "ForInStmt") {
      if (stmt.varName === word) return `let ${stmt.varName}: (loop variable)`;
      if (stmt.varName2 && stmt.varName2 === word) return `let ${stmt.varName2}: (loop variable)`;
      const r = findVarHover(stmt.body, word, exprTypes); if (r) return r;
    }
    if (stmt.kind === "UnsafeBlock") {
      const r = findVarHover(stmt.body, word, exprTypes); if (r) return r;
    }
  }
  return null;
}

function findHoverInStmt(stmt: Stmt, line: number, col: number, exprTypes: Map<Expr, import("./types").TypeKind>, word: string): string | null {
  if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.span?.line === line && stmt.name === word) {
    let resolved = stmt.type?.name ?? inferLiteralType(stmt.value);
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
      "**Operators:** `!` unwrap (panic if None) · `?` propagate None · `??` default value",
      "",
      "```milo",
      "let x: Option<i32> = Option.Some(42)",
      "let n = x!              // unwrap: 42",
      "let m = x ?? 0          // default: 42",
      "if let Option.Some(v) = x { ... }",
      "```",
    ].join("\n"),
    variants: {
      Some: "Wraps a value of type `T`.\n\n```milo\nlet x = Option.Some(42)\nlet v = x!   // unwrap → 42\n```",
      None: "No value present.\n\n```milo\nlet x: Option<i32> = Option.None\nlet v = x ?? 0   // default → 0\n```",
    },
  },
  Result: {
    enum: [
      "A value that is either a success (`Ok`) or an error (`Err`).",
      "",
      "**Operators:** `!` unwrap (panic if Err) · `?` propagate Err · `??` default value",
      "",
      "```milo",
      "fn parse(s: string): Result<i64> {",
      "    if s.len == 0 { return Result.Err(\"empty\") }",
      "    return Result.Ok(42)",
      "}",
      "let v = parse(\"x\")?     // propagate on Err",
      "let v = parse(\"x\") ?? 0 // default on Err",
      "```",
    ].join("\n"),
    variants: {
      Ok: "Success value of type `T`.\n\n```milo\nlet r = Result.Ok(42)\nlet v = r!   // unwrap → 42\nlet v = r?   // propagate: returns 42\n```",
      Err: "Error with a `string` message.\n\n```milo\nlet r = Result.Err(\"not found\")\nmatch r {\n    Result.Ok(v) => { ... }\n    Result.Err(msg) => { print(msg) }\n}\n```",
    },
  },
};

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

const STDLIB_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..");

function resolveImportPath(sourceDir: string, importPath: string): string | null {
  const withExt = importPath.endsWith(".milo") ? importPath : importPath + ".milo";
  const rel = resolve(sourceDir, withExt);
  if (existsSync(rel)) return rel;
  const std = resolve(STDLIB_DIR, withExt);
  if (existsSync(std)) return std;
  return null;
}

function findInImportedFiles(parsed: Program, sourceDir: string, word: string, visited: Set<string> = new Set()): object | null {
  for (const imp of parsed.imports) {
    const absPath = resolveImportPath(sourceDir, imp.path);
    if (!absPath) continue;
    // Cyclic-import guard (e.g. std/os <-> std/runtime) — see findDocInImports.
    if (visited.has(absPath)) continue;
    visited.add(absPath);
    let fileSource: string;
    try { fileSource = readFileSync(absPath, "utf-8"); } catch { continue; }

    for (const [keyword, re] of [["fn", new RegExp(`\\bfn\\s+${word}\\s*[<(]`)], ["struct", new RegExp(`\\bstruct\\s+${word}\\b`)], ["enum", new RegExp(`\\benum\\s+${word}\\b`)]] as const) {
      const lines = fileSource.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          return { uri: pathToFileURL(absPath).href, range: { start: { line: i, character: 0 }, end: { line: i, character: 0 } } };
        }
      }
    }

    // recurse into transitive imports
    try {
      const tokens = new Lexer(fileSource).tokenize();
      const importedParsed = new Parser(tokens).parse();
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
      const targetUri = pathToFileURL(resolved).href;
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

    // Find function definition — local first, then imported files
    for (const fn of program.functions) {
      if (fn.name === word && !fn.isExtern) {
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

    // Find type alias definition
    for (const ta of program.typeAliases) {
      if (ta.name === word) {
        const taLine = findDeclLine(source, "type", ta.name);
        if (taLine >= 0) {
          return { uri, range: { start: { line: taLine, character: 0 }, end: { line: taLine, character: 0 } } };
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
  return null;
}

// Locate enclosing fn by scanning source for `fn NAME(` line boundaries.
// Function AST has no span, so we use the declaration line as the boundary.
function findEnclosingFn(source: string, program: Program, line: number): { fn: Function; declLine: number } | null {
  const lines = source.split("\n");
  const decls: { fn: Function; declLine: number }[] = [];
  for (const fn of program.functions) {
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
  let src: string;
  try { src = readFileSync(absPath, "utf-8"); } catch { return []; }
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

// ── Request dispatch ──

function handleRequest(id: number | string, method: string, params: any) {
  switch (method) {
    case "initialize":
      sendResponse(id, {
        capabilities: {
          textDocumentSync: 1, // full sync
          hoverProvider: true,
          definitionProvider: true,
          documentFormattingProvider: true,
          completionProvider: { triggerCharacters: ['"', "{", "."] },
          codeLensProvider: { resolveProvider: false },
        },
        serverInfo: { name: "milod", version: "0.1.0" },
      });
      break;
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

  process.stderr.write("milod: language server started\n");
}

startServer();
