// Raw lexical splitter used by the frontend fuzzer for mutation and reduction.
//
// Deliberately NOT src/lexer.ts. The fuzzer needs to slice and rejoin *source
// bytes*, including bytes the real lexer would reject, and it must be able to
// reassemble a mutant exactly outside the edited region. The real lexer is lossy
// in both directions: it decodes escapes, folds `0x..` to decimal, and drops
// whitespace into trivia, so a token stream can't be printed back to the source
// it came from. This scanner never fails and never loses a byte:
// `scan(s).map(t => s.slice(t.start, t.end)).join("") === s`.
type RawKind = "ws" | "comment" | "string" | "fstring" | "char" | "num" | "ident" | "punct" | "other";

interface RawTok {
  kind: RawKind;
  start: number;
  end: number;
}

// Longest-first so `...` wins over `..`, `==` over `=`. Mirrors src/lexer.ts's
// operator ladder; a spelling missing here just scans as two `punct` tokens,
// which is harmless for mutation.
const OPS = [
  "...", "..", "->", "=>", "::", "==", "!=", "<=", ">=", "&&", "||", "??",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "(", ")", "{", "}", "[", "]", ":", ";", ",", ".", "*", "+", "-", "/", "%",
  "&", "|", "^", "~", "=", "<", ">", "!", "?", "@", "#",
];

export function scan(src: string): RawTok[] {
  const out: RawTok[] = [];
  let i = 0;
  const push = (kind: RawKind, start: number, end: number) => out.push({ kind, start, end });

  while (i < src.length) {
    const c = src[i]!;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      const s = i;
      while (i < src.length && (src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n")) i++;
      push("ws", s, i);
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const s = i;
      while (i < src.length && src[i] !== "\n") i++;
      push("comment", s, i);
      continue;
    }

    // `$"..."` interpolated string. Consumed as one unit including `\{`-escaped
    // and live `{}` interpolations — the fuzzer treats the whole literal as an
    // atom and pokes at its bytes with the char-level mutator instead.
    if (c === "$" && src[i + 1] === '"') {
      const s = i;
      i += 2;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, src.length);
      push("fstring", s, i);
      continue;
    }

    if (c === '"' || c === "'") {
      const s = i;
      const q = c;
      i++;
      // Unterminated literals run to EOF rather than to the next newline. That is
      // exactly the input the lexer's EOF handling needs to survive, and stopping
      // at the newline would quietly repair the mutant.
      while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, src.length);
      push(q === '"' ? "string" : "char", s, i);
      continue;
    }

    if (c >= "0" && c <= "9") {
      const s = i;
      // Loose on purpose: swallows `0x`, `0b`, `_` separators, exponents, and
      // trailing garbage like `1abc` so the whole run stays one mutable atom.
      while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i]!)) {
        if (src[i] === "." && !/[0-9]/.test(src[i + 1] ?? "")) break;
        i++;
      }
      push("num", s, i);
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      const s = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) i++;
      push("ident", s, i);
      continue;
    }

    const op = OPS.find(o => src.startsWith(o, i));
    if (op) {
      push("punct", i, i + op.length);
      i += op.length;
      continue;
    }

    push("other", i, i + 1);
    i++;
  }
  return out;
}

export function render(src: string, toks: RawTok[]): string {
  let out = "";
  for (const t of toks) out += src.slice(t.start, t.end);
  return out;
}

// Materialize each token's text so mutants can be built by array splicing without
// carrying the original source along.
export function texts(src: string): string[] {
  return scan(src).map(t => src.slice(t.start, t.end));
}
