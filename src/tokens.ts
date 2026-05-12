export enum TokenKind {
  // literals
  Int = "INT",
  Float = "FLOAT",
  String = "STRING",
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
  Eq = "=",
  EqEq = "==",
  FatArrow = "=>",
  ColonColon = "::",
  Neq = "!=",
  Lt = "<",
  Gt = ">",
  LtEq = "<=",
  GtEq = ">=",
  Bang = "!",
  DotDotDot = "...",
  Question = "?",
  QuestionQuestion = "??",
  Eof = "EOF",
}

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "fn", "extern", "let", "var", "return", "if", "else", "while",
  "true", "false", "struct", "enum", "match", "mut", "import",
]);
