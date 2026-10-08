// Gate on docs/grammar.ebnf, which AGENTS.md calls an authoritative reference and which
// nothing had ever compared to the compiler.
//
// It described a "Phase 1 subset": no struct, enum, match, impl, trait, import or
// closure, and `fn f() -> T` — a return arrow the parser has never accepted (`->` is a
// TokenKind the parser never reads; return types are `: T`). A grammar cannot be
// machine-checked against a recursive-descent parser in full, but its VOCABULARY can be,
// and vocabulary is where this kind of rot shows first.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { KEYWORDS, SOFT_KEYWORDS, TokenKind } from "../src/tokens";
import { PRIMITIVE_TYPE_NAMES } from "../src/types";

const GRAMMAR = readFileSync(join(import.meta.dir, "..", "docs", "grammar.ebnf"), "utf-8")
  .replace(/\(\*[\s\S]*?\*\)/g, "");   // strip comments: they discuss keywords in prose

// Only the syntactic half. Below `IDENT =` the rules spell out characters — quote marks,
// escapes, digit ranges — which are pieces of a token, not tokens, and are written with
// single quotes that this scan would misread as terminal delimiters.
const SYNTAX = GRAMMAR.slice(0, GRAMMAR.indexOf("\nIDENT "));
const terminals = new Set([...SYNTAX.matchAll(/"([^"]*)"/g)].map(m => m[1]!));

test("the grammar was read", () => {
  expect(terminals.size).toBeGreaterThan(50);
});

test("every word-terminal is a keyword or a primitive type the compiler knows", () => {
  // `_` is the wildcard pattern — a token value the lexer emits as an IDENT, not a keyword.
  const known = new Set<string>([...KEYWORDS, ...SOFT_KEYWORDS, ...PRIMITIVE_TYPE_NAMES, "_"]);
  const words = [...terminals].filter(t => /^[a-z_][a-z_0-9]*$/.test(t));
  expect(words.filter(w => !known.has(w))).toEqual([]);
});

test("every keyword the lexer knows appears in the grammar", () => {
  // The failure this catches: a keyword ships, the reference never mentions it, and the
  // only description of the language silently covers less of it every release.
  const missing = [...KEYWORDS, ...SOFT_KEYWORDS].filter(k => !terminals.has(k));
  expect(missing).toEqual([]);
});

test("every symbol-terminal is a token the lexer can produce", () => {
  const tokens = new Set<string>(Object.values(TokenKind));
  const symbols = [...terminals].filter(t => t && !/^[a-zA-Z_]/.test(t));
  expect(symbols.filter(s => !tokens.has(s))).toEqual([]);
});

test("the grammar does not use a token the parser never reads", () => {
  // `->` is in TokenKind for historical reasons and no parser path consumes it, so a
  // grammar rule that uses it describes a program the compiler rejects.
  const parser = readFileSync(join(import.meta.dir, "..", "src", "parser.ts"), "utf-8");
  expect(parser).not.toContain("TokenKind.Arrow");
  expect(terminals.has("->")).toBe(false);
});
