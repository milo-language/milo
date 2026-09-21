// Machine-applicable fixes for diagnostics whose hint is mechanical: the edit that makes
// the diagnostic go away, computed from the diagnostic and the file's text, and nothing
// else. `check --json` attaches it as `fix`, the LSP offers it as a quickfix, and
// `milo fix` applies it; all three go through `fixFor`, so a fix that works in one
// place works in the others.
//
// Only fixes with one right answer belong here. "add .clone()" is a choice between a
// clone and a borrow and stays a hint; marking a name `pub` edits a file the diagnostic
// does not point at and stays a hint. The rule is: applying every fix in a file must
// leave the program meaning what the author meant.
//
// Offsets are 0-based character offsets into `source`; `len` 0 is an insertion.

import type { Diagnostic } from "./diagnostics";

export interface TextEdit { offset: number; len: number; newText: string }
export interface Fix { title: string; edits: TextEdit[] }

// The 0-based offset of a 1-based (line, col), as spans are written.
export function spanOffset(source: string, line: number, col: number): number {
  let off = 0, l = 1;
  for (let i = 0; i < source.length && l < line; i++) if (source[i] === "\n") { l++; off = i + 1; }
  return off + col - 1;
}

export function fixFor(d: Diagnostic, source: string): Fix | null {
  if (!d.span || !d.code) return null;
  const at = spanOffset(source, d.span.line, d.span.col);
  switch (d.code) {
    case "implicit-mut-borrow":
      // `f(x)` -> `f(&mut x)`; the span is the argument's first character.
      return { title: "Write '&mut'", edits: [{ offset: at, len: 0, newText: "&mut " }] };
    case "bare-embedfile":
    case "bare-targetos": {
      const name = d.code === "bare-embedfile" ? "embedFile" : /^'(\w+)'/.exec(d.message)?.[1] ?? "targetOs";
      if (source.slice(at, at + name.length) !== name) return null;
      return { title: `Use '@${name}'`, edits: [{ offset: at, len: 0, newText: "@" }] };
    }
    case "missing-interpolation": {
      // `"hi ${name}"` -> `$"hi {name}"`: the span is the opening quote; drop each `$`
      // that sits ahead of a brace inside the literal.
      if (source[at] !== '"') return null;
      const close = closingQuote(source, at);
      if (close < 0) return null;
      const edits: TextEdit[] = [{ offset: at, len: 0, newText: "$" }];
      for (let i = at + 1; i < close - 1; i++) {
        if (source[i] === "$" && source[i + 1] === "{") edits.push({ offset: i, len: 1, newText: "" });
      }
      return { title: "Make this an interpolated string", edits };
    }
    case "unused-unsafe": {
      const edit = unwrapUnsafe(source, at);
      return edit ? { title: "Remove unnecessary 'unsafe'", edits: [edit] } : null;
    }
    case "unused-import": {
      const name = /^'([^']+)'/.exec(d.message)?.[1];
      if (!name) return null;
      const edit = removeImportName(source, at, name);
      return edit ? { title: `Remove '${name}' from the import list`, edits: [edit] } : null;
    }
    case "unimported": {
      const m = /from "([^"]+)" import \{ (\S+) \}/.exec(d.hint ?? "");
      if (!m) return null;
      return { title: `Import '${m[2]}' from '${m[1]}'`, edits: [addImportName(source, m[1]!, m[2]!)] };
    }
    default:
      return null;
  }
}

// Apply edits to `source`, latest offset first so earlier offsets stay valid. Edits that
// overlap are a bug in the producer; the second one is dropped rather than applied to
// text it was not computed against.
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset || b.len - a.len);
  let out = source;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.offset + e.len > floor) continue;
    out = out.slice(0, e.offset) + e.newText + out.slice(e.offset + e.len);
    floor = e.offset;
  }
  return out;
}

function closingQuote(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === '"') return i;
    if (source[i] === "\n") return -1;
  }
  return -1;
}

// `unsafe { X }` -> `X`, at the offset of the `unsafe` keyword. Multi-line bodies keep
// their lines; the braces and the keyword go.
function unwrapUnsafe(source: string, start: number): TextEdit | null {
  if (source.slice(start, start + 6) !== "unsafe") return null;
  const open = source.indexOf("{", start + 6);
  if (open < 0) return null;
  let depth = 0, close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const inner = source.slice(open + 1, close);
  // One statement on the same line stays on the line. A block keeps its lines and loses
  // the indent level the braces gave it: its first line goes where `unsafe` was.
  if (!inner.includes("\n")) return { offset: start, len: close + 1 - start, newText: inner.trim() };
  const lines = inner.split("\n").slice(1, -1);
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const inner0 = Math.min(...lines.filter(l => l.trim()).map(indentOf));
  const own = start - (source.lastIndexOf("\n", start) + 1);
  const shift = Math.max(0, inner0 - own);
  const body = lines.map(l => l.trim() ? l.slice(Math.min(shift, indentOf(l))) : "").join("\n").trimStart();
  return { offset: start, len: close + 1 - start, newText: body };
}

// Removes `name` from the `from "..." import { ... }` block whose `from` sits at `at`.
// A block left empty is removed whole (an empty list imports nothing since 2026-09-20).
function removeImportName(source: string, at: number, name: string): TextEdit | null {
  if (source.slice(at, at + 4) !== "from") return null;
  const open = source.indexOf("{", at);
  const close = source.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  const inner = source.slice(open + 1, close);
  const names = inner.split(",").map(s => s.trim()).filter(Boolean);
  const keep = names.filter(n => n !== name && !n.startsWith(`${name} as `));
  if (keep.length === names.length) return null;
  if (keep.length === 0) {
    // Whole statement, including its line ending.
    let end = close + 1;
    if (source[end] === "\n") end++;
    return { offset: at, len: end - at, newText: "" };
  }
  const multi = inner.includes("\n");
  const newInner = multi ? `\n    ${keep.join(", ")}\n` : ` ${keep.join(", ")} `;
  return { offset: open + 1, len: close - open - 1, newText: newInner };
}

// Adds `name` to the file's block for `mod` when there is one (either spelling of a
// sibling path), else a new import line after the last import, else after the leading
// comment.
function addImportName(source: string, mod: string, name: string): TextEdit {
  const spellings = mod.startsWith("./") ? [mod, mod.slice(2)] : [mod, `./${mod}`];
  const lines = source.split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (spellings.some(m => l.startsWith(`from "${m}" import {`))) {
      const brace = l.indexOf("{");
      const closeOnLine = l.indexOf("}");
      if (closeOnLine >= 0) {
        const inner = l.slice(brace + 1, closeOnLine).trim();
        const merged = inner ? `${inner.replace(/,\s*$/, "")}, ${name}` : name;
        return { offset: pos + brace + 1, len: closeOnLine - brace - 1, newText: ` ${merged} ` };
      }
      return { offset: pos + l.length + 1, len: 0, newText: `    ${name},\n` };
    }
    pos += l.length + 1;
  }
  // No block: after the last import statement, else after the leading comment.
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^from "/.test(lines[i]!)) continue;
    at = i;
    if (!lines[i]!.includes("}")) while (at < lines.length && !lines[at]!.startsWith("}")) at++;
  }
  if (at < 0) { at = 0; while (at < lines.length && /^(\/\/|$)/.test(lines[at]!)) at++; at--; }
  let offset = 0;
  for (let i = 0; i <= at; i++) offset += lines[i]!.length + 1;
  return { offset, len: 0, newText: `from "${mod}" import { ${name} }\n` };
}
