// Fixed LLVM IR runtime helpers (string buffers, int formatting), kept as IR text in src/runtime/str.ll.
//
// Their text never varies per program apart from a few interpolated globals, so the typed
// builder would add no checking to them, only lines. The text import is embedded by
// `bun build --compile`, so a shipped binary carries it like the bundled stdlib.
import STR_LL from "./runtime/str.ll" with { type: "text" };

const FILE = "src/runtime/str.ll";

// `; @@ key` starts a section, which runs to the next marker. Every other whole-line `;`
// comment is documentation and is dropped, as is a section's trailing blank space, so a
// section prints exactly the lines it holds and comments can be added without changing IR.
export function parseSections(text: string): Map<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    const m = /^; @@ (\S+)\s*$/.exec(line);
    if (m) {
      if (sections.has(m[1])) throw new Error(`${FILE}: section ${m[1]} defined twice`);
      sections.set(m[1], cur = []);
    } else if (/^\s*;/.test(line)) {
      continue;
    } else if (cur) {
      cur.push(line);
    } else if (line.trim() !== "") {
      throw new Error(`${FILE}: '${line}' is outside any '; @@' section`);
    }
  }
  for (const body of sections.values()) while (body.length && body[body.length - 1].trim() === "") body.pop();
  return sections;
}

const SECTIONS = parseSections(STR_LL);
export const runtimeSectionKeys = (): string[] => [...SECTIONS.keys()];

/**
 * The lines of section `key`, with each `{{name}}` replaced from `subst`. A line that is
 * only `{{name}}` takes a string[] and expands to those lines (a variant block). A
 * placeholder without a value, or a value without a placeholder, throws: either one means
 * the section and its caller disagree about what the helper references.
 */
export function runtimeFn(key: string, subst: Record<string, string | readonly string[]> = {}): string[] {
  const body = SECTIONS.get(key);
  if (!body) throw new Error(`${FILE}: no section ${key}`);
  const used = new Set<string>();
  const value = (k: string): string | readonly string[] => {
    if (!(k in subst)) throw new Error(`${FILE}: section ${key} needs a value for {{${k}}}`);
    used.add(k);
    return subst[k];
  };
  const out: string[] = [];
  for (const l of body) {
    const whole = /^\s*\{\{(\w+)\}\}\s*$/.exec(l);
    const v = whole ? value(whole[1]) : null;
    if (Array.isArray(v)) { out.push(...v); continue; }
    out.push(l.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const s = value(k);
      if (typeof s !== "string") throw new Error(`${FILE}: section ${key} uses {{${k}}} inside a line, which takes a string`);
      return s;
    }));
  }
  for (const k of Object.keys(subst)) if (!used.has(k)) throw new Error(`${FILE}: section ${key} has no {{${k}}}`);
  return out;
}
