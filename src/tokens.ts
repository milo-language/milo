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
  Parallel = "parallel",
  Interface = "interface",
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
  leadingTrivia?: Trivia[];
  trailingTrivia?: Trivia[];
}

export const KEYWORDS = new Set([
  "fn", "extern", "let", "var", "return", "if", "else", "while",
  "true", "false", "struct", "enum", "match", "mut", "import", "from",
  "break", "continue", "as", "trait", "impl", "for", "in", "unsafe", "move", "null", "is", "type", "parallel", "interface",
]);
