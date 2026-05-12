export enum TokenKind {
  // literals
  Int = "INT",
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
  // symbols
  LParen = "(",
  RParen = ")",
  LBrace = "{",
  RBrace = "}",
  Colon = ":",
  Semicolon = ";",
  Comma = ",",
  Arrow = "->",
  Star = "*",
  Plus = "+",
  Minus = "-",
  Slash = "/",
  Percent = "%",
  Amp = "&",
  Eq = "=",
  EqEq = "==",
  Neq = "!=",
  Lt = "<",
  Gt = ">",
  LtEq = "<=",
  GtEq = ">=",
  Bang = "!",
  Eof = "EOF",
}

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "fn", "extern", "let", "var", "return", "if", "else", "while", "true", "false",
]);
