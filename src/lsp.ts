// milod — Milo Language Server
// Speaks LSP over JSON-RPC/stdio. Provides diagnostics, hover, go-to-definition.

import { Lexer } from "./lexer";
import { Parser } from "./parser";
import { TypeChecker } from "./checker";
import { resolveImports } from "./resolver";
import type { Diagnostic } from "./diagnostics";
import type { Program, Function, Stmt, Expr, Span } from "./ast";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { existsSync } from "fs";

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

// ── Diagnostics ──

function validateDocument(uri: string) {
  const source = documents.get(uri);
  if (!source) return;

  let diagnostics: Diagnostic[] = [];
  try {
    const tokens = new Lexer(source).tokenize();
    const parsed = new Parser(tokens).parse();
    const sourceDir = uri.startsWith("file://") ? dirname(fileURLToPath(uri)) : ".";
    const program = resolveImports(parsed, sourceDir);
    diagnostics = new TypeChecker().check(program).diagnostics;
    buildSymbolIndex(uri, program);
  } catch (e: any) {
    // Parse/lex error — extract line:col from message
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
    const program = resolveImports(parsed, sourceDir);
    new TypeChecker().check(program);

    // Check functions
    for (const fn of program.functions) {
      if (fn.isExtern) continue;
      // Find variable declarations at this position
      for (const stmt of fn.body) {
        const info = findHoverInStmt(stmt, line + 1, character + 1);
        if (info) return { contents: { kind: "markdown", value: `\`\`\`milo\n${info}\n\`\`\`` } };
      }
      // Function signature hover
      for (const sym of symbolIndex) {
        if (sym.name === getWordAt(source, line, character) && sym.kind === "function") {
          const f = program.functions.find(f => f.name === sym.name);
          if (f) {
            const params = f.params.map(p => `${p.name}: ${p.type.name}`).join(", ");
            const sig = `fn ${f.name}(${params}): ${f.retType.name}`;
            return { contents: { kind: "markdown", value: `\`\`\`milo\n${sig}\n\`\`\`` } };
          }
        }
      }
    }
  } catch (e) {
    process.stderr.write(`milod: hover parse error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  return null;
}

function findHoverInStmt(stmt: Stmt, line: number, col: number): string | null {
  if ((stmt.kind === "LetDecl" || stmt.kind === "VarDecl") && stmt.span?.line === line) {
    const typeName = stmt.type?.name ?? inferLiteralType(stmt.value) ?? "unknown";
    return `${stmt.kind === "LetDecl" ? "let" : "var"} ${stmt.name}: ${typeName}`;
  }
  if (stmt.kind === "IfStmt") {
    for (const s of stmt.thenBody) { const r = findHoverInStmt(s, line, col); if (r) return r; }
    if (stmt.elseBody) for (const s of stmt.elseBody) { const r = findHoverInStmt(s, line, col); if (r) return r; }
  }
  if (stmt.kind === "WhileStmt") {
    for (const s of stmt.body) { const r = findHoverInStmt(s, line, col); if (r) return r; }
  }
  if (stmt.kind === "MatchStmt") {
    for (const arm of stmt.arms) {
      for (const s of arm.body) { const r = findHoverInStmt(s, line, col); if (r) return r; }
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
    const program = resolveImports(parsed, sourceDir);

    // Find function definition
    for (const fn of program.functions) {
      if (fn.name === word && !fn.isExtern) {
        // Scan source for fn declaration line
        const fnLine = findFnLine(source, fn.name);
        if (fnLine >= 0) {
          return {
            uri,
            range: {
              start: { line: fnLine, character: 0 },
              end: { line: fnLine, character: 0 },
            },
          };
        }
      }
    }

    // Find struct definition
    for (const s of program.structs) {
      if (s.name === word) {
        const sLine = findDeclLine(source, "struct", s.name);
        if (sLine >= 0) {
          return { uri, range: { start: { line: sLine, character: 0 }, end: { line: sLine, character: 0 } } };
        }
      }
    }

    // Find enum definition
    for (const e of program.enums) {
      if (e.name === word) {
        const eLine = findDeclLine(source, "enum", e.name);
        if (eLine >= 0) {
          return { uri, range: { start: { line: eLine, character: 0 }, end: { line: eLine, character: 0 } } };
        }
      }
    }

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

// ── Request dispatch ──

function handleRequest(id: number | string, method: string, params: any) {
  switch (method) {
    case "initialize":
      sendResponse(id, {
        capabilities: {
          textDocumentSync: 1, // full sync
          hoverProvider: true,
          definitionProvider: true,
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
