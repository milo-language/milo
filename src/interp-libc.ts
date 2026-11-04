// Reference interpreter, the C layer's pure-computation half: number parsing, locale, time zones and
// calendar time, printf-style formatting, uname and the other libc calls that need no files or sockets.
// Same contract as src/interp-sys.ts (a function per C symbol, over the byte memory of src/interp-mem.ts);
// callExtern looks a symbol up here when the filesystem and process table in interp-sys.ts has no entry.
// Imports no node module, so it bundles for the browser.
import type { Sys } from "./interp-sys";
import { enc, type Value } from "./interp-values";
import type { TypeKind } from "./types";

type LibcFn = (s: Sys, a: Value[]) => Value;
const I32: TypeKind = { tag: "int", bits: 32, signed: true };
const I64: TypeKind = { tag: "int", bits: 64, signed: true };
const PTR_U8: TypeKind = { tag: "ptr", inner: { tag: "int", bits: 8, signed: false } };
const ERANGE = 34, ENOTTY = 25, EINVAL = 22;
const num = (v: Value): number => Number(v as bigint);
const cbytes = (s: Sys, p: Value, what: string): Uint8Array => s.it.mem.cstring(p, what);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const cString = (s: Sys, str: string, ro = true): Value => s.it.mem.staticBytes(new Uint8Array([...enc.encode(str), 0]), ro);
const platform = (): "darwin" | "linux" => (typeof process !== "undefined" && process.platform === "linux" ? "linux" : "darwin");

// ── strtol family and strtod ──
// The longest prefix of `b` strtoll accepts: leading space, a sign, a 0x prefix for base 16 (or 0 / 0x for base 0), digits.
// `used` is 0 when there is no number at all, as endptr then points at the start.
// R-SYS-LIBC
function parseCInt(b: Uint8Array, base: number): { neg: boolean; mag: bigint; used: number } {
  let i = 0;
  while (i < b.length && (b[i] === 32 || (b[i]! >= 9 && b[i]! <= 13))) i++;
  let neg = false;
  if (b[i] === 45 || b[i] === 43) { neg = b[i] === 45; i++; }
  const digit = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 122 ? c - 87 : c >= 65 && c <= 90 ? c - 55 : 99);
  if ((base === 0 || base === 16) && b[i] === 48 && (b[i + 1] === 120 || b[i + 1] === 88) && digit(b[i + 2] ?? 0) < 16) { i += 2; base = 16; }
  else if (base === 0) base = b[i] === 48 ? 8 : 10;
  const start = i;
  let mag = 0n;
  while (i < b.length && digit(b[i]!) < base) { mag = mag * BigInt(base) + BigInt(digit(b[i]!)); i++; }
  return i === start ? { neg, mag: 0n, used: 0 } : { neg, mag, used: i };
}
// R-SYS-LIBC
function strtoInt(s: Sys, [p, endp, base]: Value[], signed: boolean): Value {
  const b = cbytes(s, p!, "strtol");
  const r = parseCInt(b, num(base));
  if (endp !== undefined && endp !== 0n) s.it.mem.store(endp, PTR_U8, s.it.mem.advance(p!, r.used));
  const lim = signed ? (r.neg ? 1n << 63n : (1n << 63n) - 1n) : (1n << 64n) - 1n;
  if (r.mag > lim) { s.setErrno(ERANGE); return signed ? (r.neg ? -(1n << 63n) : lim) : lim; }
  return r.neg ? -r.mag : r.mag;
}
// R-SYS-LIBC
function strtoDouble(s: Sys, [p, endp]: Value[]): Value {
  const str = text(cbytes(s, p!, "strtod"));
  const m = /^[ \t\n\v\f\r]*([+-]?(?:inf(?:inity)?|nan|0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?))/i.exec(str);
  let used = 0, val = 0;
  if (m) {
    used = m[0].length;
    const t = m[1]!.toLowerCase().replace(/^([+-]?)inf(inity)?$/, "$1Infinity");
    val = t.endsWith("nan") ? NaN : Number(t);
    if (!Number.isFinite(val) && !/inf|nan/i.test(m[1]!)) s.setErrno(ERANGE);
  }
  if (endp !== undefined && endp !== 0n) s.it.mem.store(endp, PTR_U8, s.it.mem.advance(p!, used));
  return val;
}

// ── time zones and calendar time ──
// The zone is UTC unless the program's TZ says otherwise: "UTC"/unset/empty, a POSIX "NAMEhh[:mm]" (the offset is
// west of Greenwich, as POSIX has it; a DST rule after it is ignored), or an IANA name, resolved by the host's Intl.
interface Zone { offsetMin: number; name: string }
// R-SYS-TIME
function zoneAt(s: Sys, epochSec: number): Zone {
  const tz = (s.env.get("TZ") ?? "").replace(/^:/, "");
  if (tz === "" || tz === "UTC" || tz === "UTC0" || tz === "GMT" || tz === "GMT0") return { offsetMin: 0, name: tz === "GMT" || tz === "GMT0" ? "GMT" : "UTC" };
  const px = /^([A-Za-z]{3,})([+-]?)(\d{1,2})(?::(\d{2}))?(?![A-Za-z\/])/.exec(tz);
  if (px) return { offsetMin: -(px[2] === "-" ? -1 : 1) * (Number(px[3]) * 60 + Number(px[4] ?? 0)), name: px[1]! };
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" });
    const parts = Object.fromEntries(f.formatToParts(new Date(epochSec * 1000)).map(x => [x.type, x.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return { offsetMin: Math.round((wall - Math.floor(epochSec) * 1000) / 60000), name: parts.timeZoneName ?? tz };
  } catch { return { offsetMin: 0, name: "UTC" }; }
}
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// struct tm: nine leading ints, then tm_gmtoff (long, offset 40) and tm_zone (char *, offset 48), 56 bytes on darwin and glibc
interface Tm { sec: number; min: number; hour: number; mday: number; mon: number; year: number; wday: number; yday: number; isdst: number; gmtoff: number; zone: string }
// R-SYS-TIME
function breakDown(epochSec: number, z: Zone): Tm {
  const d = new Date((epochSec + z.offsetMin * 60) * 1000);
  const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
  return { sec: d.getUTCSeconds(), min: d.getUTCMinutes(), hour: d.getUTCHours(), mday: d.getUTCDate(), mon: d.getUTCMonth(), year: d.getUTCFullYear() - 1900, wday: d.getUTCDay(), yday, isdst: 0, gmtoff: z.offsetMin * 60, zone: z.name };
}
// R-SYS-TIME
function writeTm(s: Sys, p: Value, t: Tm): void {
  const m = s.it.mem;
  [t.sec, t.min, t.hour, t.mday, t.mon, t.year, t.wday, t.yday, t.isdst].forEach((v, i) => m.store(m.advance(p, i * 4), I32, BigInt(v)));
  m.store(m.advance(p, 40), I64, BigInt(t.gmtoff));
  m.store(m.advance(p, 48), PTR_U8, cString(s, t.zone));
}
// R-SYS-TIME
function readTm(s: Sys, p: Value): number[] {
  const m = s.it.mem;
  return Array.from({ length: 9 }, (_, i) => Number(m.load(m.advance(p, i * 4), I32) as bigint));
}
const pad = (v: number, w: number, c = "0") => String(v).padStart(w, c);
// R-SYS-TIME: the C locale's strftime for the conversions programs use
function strftimeText(fmt: string, t: Tm, epochSec: number): string {
  return fmt.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case "Y": return String(t.year + 1900);
      case "y": return pad((t.year + 1900) % 100, 2);
      case "C": return pad(Math.floor((t.year + 1900) / 100), 2);
      case "m": return pad(t.mon + 1, 2);
      case "d": return pad(t.mday, 2);
      case "e": return pad(t.mday, 2, " ");
      case "H": return pad(t.hour, 2);
      case "I": return pad(t.hour % 12 === 0 ? 12 : t.hour % 12, 2);
      case "M": return pad(t.min, 2);
      case "S": return pad(t.sec, 2);
      case "j": return pad(t.yday + 1, 3);
      case "a": return DAYS[t.wday]!.slice(0, 3);
      case "A": return DAYS[t.wday]!;
      case "b": case "h": return MONTHS[t.mon]!.slice(0, 3);
      case "B": return MONTHS[t.mon]!;
      case "p": return t.hour < 12 ? "AM" : "PM";
      case "u": return String(t.wday === 0 ? 7 : t.wday);
      case "w": return String(t.wday);
      case "Z": return t.zone;
      case "z": return `${t.gmtoff < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(t.gmtoff) / 3600), 2)}${pad(Math.floor(Math.abs(t.gmtoff) % 3600 / 60), 2)}`;
      case "s": return String(epochSec);
      case "F": return strftimeText("%Y-%m-%d", t, epochSec);
      case "T": return strftimeText("%H:%M:%S", t, epochSec);
      case "R": return strftimeText("%H:%M", t, epochSec);
      case "D": return strftimeText("%m/%d/%y", t, epochSec);
      case "c": return strftimeText("%a %b %e %H:%M:%S %Y", t, epochSec);
      case "x": return strftimeText("%m/%d/%y", t, epochSec);
      case "X": return strftimeText("%H:%M:%S", t, epochSec);
      case "n": return "\n";
      case "t": return "\t";
      case "%": return "%";
      default: return "%" + c;
    }
  });
}

// ── printf ──
// The conversions programs call printf with: d i u x X o c s p f F e E g G and %%, with flags, width, precision and the
// h hh l ll z j t length modifiers. A C-string argument is a pointer or a Milo string; arguments are consumed in order.
// C rounds an exact tie to the even digit where toFixed rounds it up: 2.25 is "2.2" at one place
// R-SYS-PRINTF
function fixedC(a: number, p: number): string {
  const long = a.toFixed(Math.min(100, p + 30));
  const dot = long.indexOf(".");
  const cut = p === 0 ? dot : dot + 1 + p;
  if (/^50*$/.test(long.slice(p === 0 ? dot + 1 : cut)) && Number(long[cut - 1]) % 2 === 0) return long.slice(0, cut);
  return a.toFixed(p);
}
// R-SYS-PRINTF
function fmtExp(v: number, prec: number, upper: boolean): string {
  const [m, e] = v.toExponential(prec).split("e");
  const ex = Number(e);
  const r = `${m}e${ex < 0 ? "-" : "+"}${pad(Math.abs(ex), 2)}`;
  return upper ? r.toUpperCase() : r;
}
// R-SYS-PRINTF
function fmtG(v: number, prec: number, alt: boolean, upper: boolean): string {
  if (prec === 0) prec = 1;
  const x = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(Number(v.toExponential(prec - 1)))));
  let r = x < -4 || x >= prec ? fmtExp(v, prec - 1, false) : v.toFixed(Math.max(0, prec - 1 - x));
  if (!alt) r = r.includes("e") ? r.replace(/\.?0+e/, "e") : r.includes(".") ? r.replace(/\.?0+$/, "") : r;
  return upper ? r.toUpperCase() : r;
}
// R-SYS-PRINTF
export function formatC(s: Sys, fmt: Uint8Array, args: Value[]): number[] {
  const out: number[] = [];
  let ai = 0;
  const next = (): Value => args[ai++];
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== 37) { out.push(fmt[i]!); continue; }
    i++;
    let left = false, plus = false, space = false, alt = false, zero = false;
    for (;; i++) {
      const c = fmt[i];
      if (c === 45) left = true; else if (c === 43) plus = true; else if (c === 32) space = true; else if (c === 35) alt = true; else if (c === 48) zero = true; else break;
    }
    let width = 0, prec = -1;
    if (fmt[i] === 42) { width = num(next()); if (width < 0) { left = true; width = -width; } i++; } else while (fmt[i]! >= 48 && fmt[i]! <= 57) width = width * 10 + fmt[i++]! - 48;
    if (fmt[i] === 46) { i++; prec = 0; if (fmt[i] === 42) { prec = num(next()); i++; } else while (fmt[i]! >= 48 && fmt[i]! <= 57) prec = prec * 10 + fmt[i++]! - 48; }
    let len = "";
    while (fmt[i] !== undefined && "hlzjtL".includes(String.fromCharCode(fmt[i]!))) len += String.fromCharCode(fmt[i++]!);
    const conv = String.fromCharCode(fmt[i] ?? 0);
    const bits = len === "hh" ? 8 : len === "h" ? 16 : len === "" ? 32 : 64;
    let body = "", sign = "", numeric = true;
    switch (conv) {
      case "%": out.push(37); continue;
      case "d": case "i": {
        const v = BigInt.asIntN(bits, BigInt(next() as bigint));
        sign = v < 0n ? "-" : plus ? "+" : space ? " " : "";
        body = (v < 0n ? -v : v).toString();
        if (prec >= 0) body = body.padStart(prec, "0");
        break;
      }
      case "u": case "x": case "X": case "o": {
        const v = BigInt.asUintN(bits, BigInt(next() as bigint));
        body = v.toString(conv === "u" ? 10 : conv === "o" ? 8 : 16);
        if (conv === "X") body = body.toUpperCase();
        if (prec >= 0) body = body.padStart(prec, "0");
        if (alt && v !== 0n && conv !== "u") body = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + body;
        break;
      }
      case "p": { const v = next(); body = "0x" + BigInt.asUintN(64, s.it.mem.addr(v)).toString(16); break; }
      case "c": { numeric = false; body = String.fromCharCode(num(next()) & 255); break; }
      case "s": {
        numeric = false;
        const v = next();
        const bytes = v && typeof v === "object" && v.k === "str" ? Uint8Array.from(v.b.bytes) : v === 0n ? enc.encode("(null)") : cbytes(s, v, "printf %s");
        body = String.fromCharCode(...(prec >= 0 ? bytes.subarray(0, prec) : bytes));
        break;
      }
      case "f": case "F": case "e": case "E": case "g": case "G": {
        const raw = next();
        const v = typeof raw === "bigint" ? Number(raw) : (raw as number);
        sign = v < 0 || Object.is(v, -0) ? "-" : plus ? "+" : space ? " " : "";
        const a = Math.abs(v), up = conv === "E" || conv === "G" || conv === "F";
        if (!Number.isFinite(a)) { body = Number.isNaN(a) ? "nan" : "inf"; if (up) body = body.toUpperCase(); zero = false; sign = Number.isNaN(a) ? "" : sign; break; }
        const p = prec < 0 ? 6 : prec;
        body = conv === "f" || conv === "F" ? fixedC(a, p) : conv === "e" || conv === "E" ? fmtExp(a, p, up) : fmtG(a, p, alt, up);
        break;
      }
      default: out.push(37); if (fmt[i] !== undefined) out.push(fmt[i]!); continue;
    }
    const total = sign.length + body.length;
    const filler = Math.max(0, width - total);
    const padded = left ? sign + body + " ".repeat(filler)
      : zero && numeric && !(prec >= 0 && "diuxXo".includes(conv)) ? sign + "0".repeat(filler) + body
      : " ".repeat(filler) + sign + body;
    for (let k = 0; k < padded.length; k++) out.push(padded.charCodeAt(k) & 255);
  }
  return out;
}
// the output of printf into the stdout buffer R-SYS-FD describes
// R-SYS-PRINTF
function cprintf(s: Sys, fmt: Value, rest: Value[]): bigint {
  const bytes = formatC(s, cbytes(s, fmt, "printf format"), rest);
  for (const b of bytes) s.it.out.push(b);
  return BigInt(bytes.length);
}
// R-SYS-PRINTF
function csnprintf(s: Sys, buf: Value, size: number | null, fmt: Value, rest: Value[]): bigint {
  const bytes = formatC(s, cbytes(s, fmt, "printf format"), rest);
  const cap = size === null ? bytes.length + 1 : size;
  if (cap > 0) {
    const w = Uint8Array.from(bytes.slice(0, cap - 1));
    s.it.mem.writeBytes(buf, new Uint8Array([...w, 0]), "snprintf");
  }
  return BigInt(bytes.length);
}


// ── POSIX regex (regcomp / regexec / regfree) ──
// An ERE is translated to a JS RegExp in unicode mode, so a character is a code point as in the UTF-8 locale std sets up.
// JS alternation is leftmost-first where POSIX is leftmost-longest: a pattern whose branches overlap can pick a shorter match.
interface Compiled { re: RegExp; notBol: RegExp }
// the regex_t holds the id of its compiled form in its first 8 bytes, so a regex_t copied by value still finds it
const compiledRegex = new Map<bigint, Compiled>();
let nextRegexId = 1n;
const REG_ICASE = 2;
const REG_NEWLINE = () => (platform() === "darwin" ? 8 : 4);
const CLASSES: Record<string, string> = {
  alpha: "\\p{L}", digit: "0-9", alnum: "\\p{L}\\p{N}", upper: "\\p{Lu}", lower: "\\p{Ll}", space: "\\s", blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~", print: "\\x20-\\x7e\\u00a0-\\u{10ffff}", graph: "\\x21-\\x7e\\u00a1-\\u{10ffff}", cntrl: "\\x00-\\x1f\\x7f", xdigit: "0-9A-Fa-f",
};
const escClass = (c: string) => (/[\\\]\[^-]/.test(c) ? "\\" + c : c);
// R-SYS-REGEX
function translateEre(pat: string, notBol: boolean, newline: boolean): string | null {
  const cps = [...pat];
  let out = "";
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (c === "\\") {
      const d = cps[++i];
      if (d === undefined) return null;
      if (d === "<" || d === ">") out += "\\b";
      else if (/[wWsSdDbBnrtfv0-9]/.test(d)) out += "\\" + d;
      else out += /[\^$\\.*+?()[\]{}|\/]/.test(d) ? "\\" + d : d;
    } else if (c === "[") {
      let cls = "";
      i++;
      let neg = false;
      if (cps[i] === "^") { neg = true; i++; }
      let first = true;
      for (; ; i++) {
        const x = cps[i];
        if (x === undefined) return null;
        if (x === "]" && !first) break;
        first = false;
        if (x === "[" && (cps[i + 1] === ":" || cps[i + 1] === "." || cps[i + 1] === "=")) {
          const kind = cps[i + 1]!, end = cps.findIndex((ch, k) => k > i + 1 && ch === kind && cps[k + 1] === "]");
          if (end < 0) return null;
          const name = cps.slice(i + 2, end).join("");
          if (kind === ":") { if (!CLASSES[name]) return null; cls += CLASSES[name]; } else cls += escClass(name);
          i = end + 1;
        } else if (cps[i + 1] === "-" && cps[i + 2] !== undefined && cps[i + 2] !== "]") {
          cls += escClass(x) + "-" + escClass(cps[i + 2]!);
          i += 2;
        } else cls += escClass(x);
      }
      out += `[${neg ? "^" : ""}${cls}]`;
    } else if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(cps.slice(i).join(""));
      if (m) { out += m[0]; i += m[0].length - 1; } else out += "\\{";
    } else if (c === "}" || c === "]") out += "\\" + c;
    else if (c === "^" && notBol) out += newline ? "(?<=\\n)" : "(?!)";
    else out += c;
  }
  return out;
}
// R-SYS-REGEX
function regcomp(s: Sys, [preg, pattern, cflags]: Value[]): Value {
  const pat = text(cbytes(s, pattern!, "regcomp"));
  const flags = num(cflags);
  const nl = (flags & REG_NEWLINE()) !== 0;
  const fl = "ud" + (flags & REG_ICASE ? "i" : "") + (nl ? "m" : "s");
  try {
    const a = translateEre(pat, false, nl), b = translateEre(pat, true, nl);
    if (a === null || b === null) return 2n;
    const id = nextRegexId++;
    compiledRegex.set(id, { re: new RegExp(a, fl), notBol: new RegExp(b, fl) });
    s.it.mem.store(preg!, I64, id);
    return 0n;
  } catch { return 2n; }
}
// R-SYS-REGEX: with REG_STARTEND (4 on darwin) the subject is the byte range in pmatch[0], else up to the NUL
function regexec(s: Sys, [preg, str, nmatch, pmatch, eflags]: Value[]): Value {
  const m = s.it.mem, flags = num(eflags);
  const c = compiledRegex.get(m.load(preg!, I64) as bigint);
  if (!c) return 2n;
  const wide = platform() === "darwin";
  const stride = wide ? 16 : 8, T = wide ? I64 : I32;
  let so = 0, eo: number;
  if (flags & 4) { so = Number(m.load(pmatch!, T) as bigint); eo = Number(m.load(m.advance(pmatch!, stride / 2), T) as bigint); } else eo = cbytes(s, str!, "regexec").length;
  const sub = m.readBytes(str!, eo, "regexec").subarray(so, eo);
  const subject = new TextDecoder().decode(sub);
  const hit = ((flags & 1) ? c.notBol : c.re).exec(subject);
  if (!hit) return 1n;
  // JS indexes are UTF-16 units; the caller wants byte offsets, so count the UTF-8 bytes up to each
  const byteAt = (idx: number) => enc.encode(subject.slice(0, idx)).length;
  const idx = (hit as RegExpExecArray & { indices: ([number, number] | undefined)[] }).indices;
  for (let g = 0; g < num(nmatch); g++) {
    const at = m.advance(pmatch!, g * stride);
    const r = idx[g];
    m.store(at, T, BigInt(r ? so + byteAt(r[0]) : -1));
    m.store(m.advance(at, stride / 2), T, BigInt(r ? so + byteAt(r[1]) : -1));
  }
  return 0n;
}

// the symbols this file implements, by C name
export const LIBC: Record<string, LibcFn> = {
  // R-SYS-LIBC
  strtoll: (s, a) => strtoInt(s, a, true),
  strtol: (s, a) => strtoInt(s, a, true),
  strtoul: (s, a) => strtoInt(s, a, false),
  strtoull: (s, a) => strtoInt(s, a, false),
  strtod: strtoDouble,
  // R-SYS-LIBC: the locale is always "C"; asking for it by name (or "UTF-8", which only changes how C's multibyte functions read bytes) succeeds, any other name does not
  setlocale: (s, [_cat, loc]) => {
    if (loc === 0n) return cString(s, "C");
    const name = text(cbytes(s, loc!, "setlocale"));
    return name === "" || name === "C" || name === "POSIX" || /^(C\.)?UTF-?8$/i.test(name) || /^[a-z]{2}_[A-Z]{2}\.UTF-?8$/.test(name) ? cString(s, name === "" ? "C" : name) : 0n;
  },
  // R-SYS-LIBC: struct utsname is five fixed-width fields, 256 bytes each on darwin and 65 on linux
  uname: (s, [buf]) => {
    const w = platform() === "darwin" ? 256 : 65;
    const arch = typeof process !== "undefined" && process.arch === "x64" ? "x86_64" : platform() === "darwin" ? "arm64" : "aarch64";
    const fields = [platform() === "darwin" ? "Darwin" : "Linux", "milo", "0.0", "milo interpreter", arch];
    const b = new Uint8Array(w * 5);
    fields.forEach((f, i) => b.set(enc.encode(f).subarray(0, w - 1), i * w));
    s.it.mem.writeBytes(buf!, b, "uname");
    return 0n;
  },
  // R-SYS-LIBC: stdout is never a terminal here (isatty is 0), so a terminal request fails with ENOTTY
  ioctl: s => s.setErrno(ENOTTY),
  // R-SYS-LIBC: the running "binary" is the program file the driver was given
  proc_pidpath: (s, [_pid, buf, size]) => {
    const p = enc.encode(s.o.argv0 ?? s.it.entryFile ?? "milo");
    const abs = p[0] === 47 ? p : enc.encode(s.cwd.replace(/\/$/, "") + "/" + text(p));
    if (num(size) < abs.length + 1) { s.setErrno(EINVAL); return 0n; }
    s.it.mem.writeBytes(buf!, new Uint8Array([...abs, 0]), "proc_pidpath");
    return BigInt(abs.length);
  },
  // R-SYS-TIME
  localtime_r: (s, [tp, out]) => {
    const t = Number(s.it.mem.load(tp!, I64) as bigint);
    writeTm(s, out!, breakDown(t, zoneAt(s, t)));
    return out;
  },
  gmtime_r: (s, [tp, out]) => {
    writeTm(s, out!, breakDown(Number(s.it.mem.load(tp!, I64) as bigint), { offsetMin: 0, name: "GMT" }));
    return out;
  },
  mktime: (s, [tm]) => {
    const [sec, min, hour, mday, mon, year] = readTm(s, tm!) as [number, number, number, number, number, number];
    const wall = Date.UTC(1900 + year, mon, mday, hour, min, sec) / 1000;
    const guess = wall - zoneAt(s, wall).offsetMin * 60;
    const epoch = wall - zoneAt(s, guess).offsetMin * 60;
    writeTm(s, tm!, breakDown(epoch, zoneAt(s, epoch)));
    return BigInt(epoch);
  },
  strftime: (s, [buf, max, fmt, tm]) => {
    const f = readTm(s, tm!);
    const m = s.it.mem;
    const t: Tm = { sec: f[0]!, min: f[1]!, hour: f[2]!, mday: f[3]!, mon: f[4]!, year: f[5]!, wday: f[6]!, yday: f[7]!, isdst: f[8]!, gmtoff: Number(m.load(m.advance(tm!, 40), I64) as bigint), zone: (z => (z === 0n ? "UTC" : text(m.cstring(z, "strftime tm_zone"))))(m.load(m.advance(tm!, 48), PTR_U8)) };
    const epoch = Date.UTC(1900 + t.year, t.mon, t.mday, t.hour, t.min, t.sec) / 1000 - t.gmtoff;
    const out = enc.encode(strftimeText(text(cbytes(s, fmt!, "strftime format")), t, epoch));
    if (out.length + 1 > num(max)) return 0n;
    m.writeBytes(buf!, new Uint8Array([...out, 0]), "strftime");
    return BigInt(out.length);
  },
  // R-SYS-REGEX
  regcomp,
  regexec,
  regfree: (s, [preg]) => { compiledRegex.delete(s.it.mem.load(preg!, I64) as bigint); return undefined; },
  // R-SYS-PRINTF
  printf: (s, [fmt, ...rest]) => cprintf(s, fmt!, rest),
  snprintf: (s, [buf, size, fmt, ...rest]) => csnprintf(s, buf!, num(size), fmt!, rest),
  sprintf: (s, [buf, fmt, ...rest]) => csnprintf(s, buf!, null, fmt!, rest),
};
