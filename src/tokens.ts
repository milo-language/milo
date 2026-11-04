// Token types and the keyword lists the lexer, parser and generated editor grammar
// all read from.
export enum TokenKind {
  // literals
  Int = "INT",
  Float = "FLOAT",
  String = "STRING",
  FString = "FSTRING",
  Char = "CHAR",
  Ident = "IDENT",
  // keywords
  Fn = "fn",
  Extern = "extern",
  Let = "let",
  Var = "var",
  Return = "return",
  If = "if",
  Else = "else",
  While = "while",
  True = "true",
  False = "false",
  Struct = "struct",
  Enum = "enum",
  Match = "match",
  Mut = "mut",
  Import = "import",
  From = "from",
  Break = "break",
  Continue = "continue",
  As = "as",
  Trait = "trait",
  Impl = "impl",
  For = "for",
  In = "in",
  Unsafe = "unsafe",
  Move = "move",
  Null = "null",
  Is = "is",
  Type = "type",
  Interface = "interface",
  Requires = "requires",
  Ensures = "ensures",
  Invariant = "invariant",
  Decreases = "decreases",
  // symbols
  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  LBracket = "[",
  RBracket = "]",
  Colon = ":",
  Semicolon = ";",
  Comma = ",",
  Dot = ".",
  Arrow = "->",
  Star = "*",
  Plus = "+",
  Minus = "-",
  Slash = "/",
  Percent = "%",
  Amp = "&",
  AmpAmp = "&&",
  PipePipe = "||",
  Eq = "=",
  EqEq = "==",
  Implies = "==>",
  FatArrow = "=>",
  ColonColon = "::",
  Neq = "!=",
  Lt = "<",
  Gt = ">",
  LtEq = "<=",
  GtEq = ">=",
  Bang = "!",
  DotDot = "..",
  DotDotDot = "...",
  Question = "?",
  QuestionQuestion = "??",
  Pipe = "|",
  Caret = "^",
  Tilde = "~",
  At = "@",
  PlusEq = "+=",
  MinusEq = "-=",
  StarEq = "*=",
  SlashEq = "/=",
  PercentEq = "%=",
  AmpEq = "&=",
  PipeEq = "|=",
  CaretEq = "^=",
  Eof = "EOF",
}

export interface Trivia {
  kind: "comment" | "blank";
  text: string;
  line: number;
}

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
  // Exact source slice, delimiters included. Only set for FString, where
  // `value` is lossy: the lexer decodes `\{` to a bare `{`, which is then
  // indistinguishable from an interpolation brace. The formatter needs the
  // original bytes to round-trip.
  raw?: string;
  leadingTrivia?: Trivia[];
  trailingTrivia?: Trivia[];
}

export const KEYWORDS = new Set([
  "fn", "extern", "let", "var", "return", "if", "else", "while",
  "true", "false", "struct", "enum", "match", "mut", "import",
  "break", "continue", "as", "trait", "impl", "for", "unsafe", "move", "null", "is", "type", "interface",
  "requires", "ensures", "invariant", "decreases",
]);

// Contextual keywords: reserved only where the grammar expects them, so they stay
// legal identifiers everywhere else and never enter KEYWORDS. The parser recognises
// them by value (`atSoftKw`, or a direct `peek().value` check for thread_local);
// tests/tmLanguage.test.ts holds this list to what the parser actually looks for, so
// the editor grammar generated from it cannot drift.
export const SOFT_KEYWORDS = new Set([
  "derive", "from", "in", "pub", "thread_local",
]);
