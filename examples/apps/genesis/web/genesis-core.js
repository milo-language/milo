"use strict";

// runtime
const __out = [];
function __print(s) { __out.push(String(s)); }
function __flush() { if (__out.length === 0) return; const text = __out.join(''); __out.length = 0; if (typeof process !== 'undefined') process.stdout.write(text); else if (typeof console !== 'undefined') console.log(text); }
function __assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
function __fmtG(x) { if (!isFinite(x)) return String(x); if (x === 0) return '0'; let s = x.toPrecision(6); if (s.indexOf('e') >= 0) { s = Number(s).toExponential(); return s.replace(/e([+-])(\d)$/, 'e$10$2'); } if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; }
function __propagate(r) { if (r.tag !== 0) throw { __milo_prop: r }; return r.data[0]; }
function __eprint(s) { if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s); else if (typeof console !== 'undefined') console.error(s); }
function __displayVal(v) { if (typeof v === 'string') return JSON.stringify(v); if (typeof v === 'boolean') return String(v); if (typeof v === 'number') return Number.isInteger(v) ? String(v) : __fmtG(v); if (v && typeof v === 'object' && v.constructor && v.constructor.name !== 'Object') return __displayStruct(v); return String(v); }
function __displayStruct(v) { const ks = Object.keys(v); return v.constructor.name + ' { ' + ks.map(k => k + ': ' + __displayVal(v[k])).join(', ') + ' }'; }
function __displayEnum(v, name) { const e = __enumMeta[name][v.tag]; return e[1] === 0 ? e[0] : e[0] + '(' + v.data.map(__displayVal).join(', ') + ')'; }
function __clone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(__clone); const o = Object.create(Object.getPrototypeOf(v)); for (const k of Object.keys(v)) o[k] = __clone(v[k]); return o; }
function __eq(a, b) { if (a === b) return true; if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b; if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => __eq(v, b[i])); const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(k => __eq(a[k], b[k])); }

class GenHandle {
  constructor(cpu, m, synth, rgba, samples) {
    this.cpu = cpu;
    this.m = m;
    this.synth = synth;
    this.rgba = rgba;
    this.samples = samples;
  }
}

class Cart {
  constructor(rom, name, romEnd) {
    this.rom = rom;
    this.name = name;
    this.romEnd = romEnd;
  }
}

class Mem {
  constructor(ram, touched, genesis, vram, cram, vsram, vdpRegs, vdpAddr, vdpCode, vdpFirst, vdpPending, vdpLine, dmaFillPending, fillAddr, fillInc, fillLen, lastDataByte, z80Busreq, z80Reset, z80, ctrl1, tmssUnlocked, pad1, padTh) {
    this.ram = ram;
    this.touched = touched;
    this.genesis = genesis;
    this.vram = vram;
    this.cram = cram;
    this.vsram = vsram;
    this.vdpRegs = vdpRegs;
    this.vdpAddr = vdpAddr;
    this.vdpCode = vdpCode;
    this.vdpFirst = vdpFirst;
    this.vdpPending = vdpPending;
    this.vdpLine = vdpLine;
    this.dmaFillPending = dmaFillPending;
    this.fillAddr = fillAddr;
    this.fillInc = fillInc;
    this.fillLen = fillLen;
    this.lastDataByte = lastDataByte;
    this.z80Busreq = z80Busreq;
    this.z80Reset = z80Reset;
    this.z80 = z80;
    this.ctrl1 = ctrl1;
    this.tmssUnlocked = tmssUnlocked;
    this.pad1 = pad1;
    this.padTh = padTh;
  }
}

class M68k {
  constructor(d, a, otherSp, pc, sr, halted, fault, faultAddr, faultRW, faultIN, faultCommit) {
    this.d = d;
    this.a = a;
    this.otherSp = otherSp;
    this.pc = pc;
    this.sr = sr;
    this.halted = halted;
    this.fault = fault;
    this.faultAddr = faultAddr;
    this.faultRW = faultRW;
    this.faultIN = faultIN;
    this.faultCommit = faultCommit;
  }
}

class Z80 {
  constructor(a, b, c, d, e, h, l, f, i, r, pc, sp, ix, iy, af_, bc_, de_, hl_, iff1, iff2, im, wz, halted, mem, gen, bank, ymAddr0, ymAddr1, ym, psgLatch, psg, fmKey, rom, dac, dacW, dacR, ymStatus, timerACnt, timerARun, timerBCnt, timerBRun) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.h = h;
    this.l = l;
    this.f = f;
    this.i = i;
    this.r = r;
    this.pc = pc;
    this.sp = sp;
    this.ix = ix;
    this.iy = iy;
    this.af_ = af_;
    this.bc_ = bc_;
    this.de_ = de_;
    this.hl_ = hl_;
    this.iff1 = iff1;
    this.iff2 = iff2;
    this.im = im;
    this.wz = wz;
    this.halted = halted;
    this.mem = mem;
    this.gen = gen;
    this.bank = bank;
    this.ymAddr0 = ymAddr0;
    this.ymAddr1 = ymAddr1;
    this.ym = ym;
    this.psgLatch = psgLatch;
    this.psg = psg;
    this.fmKey = fmKey;
    this.rom = rom;
    this.dac = dac;
    this.dacW = dacW;
    this.dacR = dacR;
    this.ymStatus = ymStatus;
    this.timerACnt = timerACnt;
    this.timerARun = timerARun;
    this.timerBCnt = timerBCnt;
    this.timerBRun = timerBRun;
  }
}

class Synth {
  constructor(phase, modPhase, envLevel, opPhase, fbMem, noiseLfsr) {
    this.phase = phase;
    this.modPhase = modPhase;
    this.envLevel = envLevel;
    this.opPhase = opPhase;
    this.fbMem = fbMem;
    this.noiseLfsr = noiseLfsr;
  }
}

class StereoSample {
  constructor(l, r) {
    this.l = l;
    this.r = r;
  }
}

const Ea = {
  DReg(_0) { return { tag: 0, data: [_0] }; },
  AReg(_0) { return { tag: 1, data: [_0] }; },
  MemAddr(_0) { return { tag: 2, data: [_0] }; },
  Imm(_0) { return { tag: 3, data: [_0] }; },
};

const Result_Cart_string = {
  Ok(_0) { return { tag: 0, data: [_0] }; },
  Err(_0) { return { tag: 1, data: [_0] }; },
};

const __enumMeta = {
  "Ea": [["DReg", 1], ["AReg", 1], ["MemAddr", 1], ["Imm", 1]],
  "Result_Cart_string": [["Ok", 1], ["Err", 1]],
  "Option": [["Some", 1], ["None", 0]],
  "Result": [["Ok", 1], ["Err", 1]]
};

const MAXW = 320;
const SR_C = 1;
const SR_V = 2;
const SR_Z = 4;
const SR_N = 8;
const SR_X = 16;
const SR_S = 8192;
const SR_T = 32768;
const ADDR_MASK = 16777215;
const FC = 1;
const FN = 2;
const FPV = 4;
const FX = 8;
const FH = 16;
const FY = 32;
const FZ = 64;
const FS = 128;
const SAMPLE_RATE = 44100;
const FM_SCALE_1E6 = 50808;
const PRI = 256;

function strContains(haystack, needle) {
  return (strIndexOfFrom(haystack, needle, 0) >= 0);
}

function strIndexOf(haystack, needle) {
  return strIndexOfFrom(haystack, needle, 0);
}

function strIndexOfFrom(haystack, needle, pos) {
  let notFound = 0;
  notFound = Math.trunc((notFound - 1));
  if ((needle.length == 0)) {
    return pos;
  }
  if ((pos < Math.trunc(0))) {
    return notFound;
  }
  if ((Math.trunc((pos + needle.length)) > haystack.length)) {
    return notFound;
  }
  const base = Math.trunc(haystack);
  const nptr = needle;
  const c0 = (needle.charCodeAt(0) | 0);
  const last = Math.trunc((haystack.length - needle.length));
  let i = pos;
  while ((i <= last)) {
    let hit = 0;
    const p = memchr(Math.trunc((base + i)), c0, Math.trunc((Math.trunc((last - i)) + 1)));
    hit = Math.trunc(p);
    if ((hit == 0)) {
      return notFound;
    }
    i = Math.trunc((hit - base));
    let cmp = 0;
    cmp = memcmp(Math.trunc((base + i)), nptr, needle.length);
    if ((cmp == 0)) {
      return i;
    }
    i = Math.trunc((i + 1));
  }
  return notFound;
}

function strLastIndexOf(haystack, needle) {
  let notFound = 0;
  notFound = Math.trunc((notFound - 1));
  if ((needle.length == 0)) {
    return haystack.length;
  }
  if ((needle.length > haystack.length)) {
    return notFound;
  }
  let i = Math.trunc((haystack.length - needle.length));
  while ((i >= Math.trunc(0))) {
    let j = 0;
    while ((j < needle.length)) {
      if ((haystack.charCodeAt(Math.trunc((i + j))) != needle.charCodeAt(j))) {
        break;
      }
      j = Math.trunc((j + 1));
    }
    if ((j == needle.length)) {
      return i;
    }
    i = Math.trunc((i - 1));
  }
  return notFound;
}

function strStartsWith(s, prefix) {
  if ((prefix.length > s.length)) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if ((s.charCodeAt(i) != prefix.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function strEndsWith(s, suffix) {
  if ((suffix.length > s.length)) {
    return false;
  }
  const offset = Math.trunc((s.length - suffix.length));
  for (let i = 0; i < suffix.length; i++) {
    if ((s.charCodeAt(Math.trunc((offset + i))) != suffix.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function strToLower(s) {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (((ch >= 65) && (ch <= 90))) {
      (result += String.fromCharCode(((ch + 32) & 0xFF)));
    } else {
      (result += String.fromCharCode(ch));
    }
  }
  return result;
}

function strToUpper(s) {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (((ch >= 97) && (ch <= 122))) {
      (result += String.fromCharCode(((ch - 32) & 0xFF)));
    } else {
      (result += String.fromCharCode(ch));
    }
  }
  return result;
}

function strTrim(s) {
  let start = 0;
  while ((start < s.length)) {
    const ch = s.charCodeAt(start);
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    start = Math.trunc((start + 1));
  }
  let end = s.length;
  while ((end > start)) {
    const ch = s.charCodeAt(Math.trunc((end - 1)));
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    end = Math.trunc((end - 1));
  }
  if ((start >= end)) {
    return "";
  }
  return s.slice(start, end);
}

function strTrimStart(s) {
  let start = 0;
  while ((start < s.length)) {
    const ch = s.charCodeAt(start);
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    start = Math.trunc((start + 1));
  }
  if ((start >= s.length)) {
    return "";
  }
  return s.slice(start, s.length);
}

function strTrimEnd(s) {
  let end = s.length;
  while ((end > Math.trunc(0))) {
    const ch = s.charCodeAt(Math.trunc((end - 1)));
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    end = Math.trunc((end - 1));
  }
  if ((end <= Math.trunc(0))) {
    return "";
  }
  return s.slice(Math.trunc(0), end);
}

function strSplit(s, sep) {
  let result = [];
  let notFound = 0;
  notFound = Math.trunc((notFound - 1));
  if ((sep.length == 0)) {
    for (let i = 0; i < s.length; i++) {
      result.push(s.slice(i, Math.trunc((i + 1))));
    }
    return result;
  }
  let pos = 0;
  while ((pos <= s.length)) {
    const idx = strIndexOfFrom(s, sep, pos);
    if ((idx == notFound)) {
      result.push(s.slice(pos, s.length));
      break;
    }
    result.push(s.slice(pos, idx));
    pos = Math.trunc((idx + sep.length));
  }
  return result;
}

function strRepeat(s, n) {
  let result = "";
  for (let i = 0; i < n; i++) {
    result = (result + s);
  }
  return result;
}

function strPadStart(s, targetLen, padStr) {
  if (((s.length >= targetLen) || (padStr.length == 0))) {
    return s;
  }
  let padding = "";
  let needed = Math.trunc((targetLen - s.length));
  while ((padding.length < needed)) {
    let i = 0;
    while (((i < padStr.length) && (padding.length < needed))) {
      (padding += String.fromCharCode(padStr.charCodeAt(i)));
      i = Math.trunc((i + 1));
    }
  }
  return (padding + s);
}

function strPadEnd(s, targetLen, padStr) {
  if (((s.length >= targetLen) || (padStr.length == 0))) {
    return s;
  }
  let result = s;
  let needed = Math.trunc((targetLen - s.length));
  let added = 0;
  while ((added < needed)) {
    let i = 0;
    while (((i < padStr.length) && (added < needed))) {
      (result += String.fromCharCode(padStr.charCodeAt(i)));
      i = Math.trunc((i + 1));
      added = Math.trunc((added + 1));
    }
  }
  return result;
}

function strReplace(s, old, newVal) {
  if ((old.length == 0)) {
    return s;
  }
  let notFound = 0;
  notFound = Math.trunc((notFound - 1));
  let result = "";
  let pos = 0;
  while ((pos < s.length)) {
    const idx = strIndexOfFrom(s, old, pos);
    if ((idx == notFound)) {
      result = (result + s.slice(pos, s.length));
      break;
    }
    if ((idx > pos)) {
      result = (result + s.slice(pos, idx));
    }
    result = (result + newVal);
    pos = Math.trunc((idx + old.length));
  }
  return result;
}

function charIsWhitespace(ch) {
  return ((((ch == 32) || (ch == 9)) || (ch == 10)) || (ch == 13));
}

function charIsDigit(ch) {
  return ((ch >= 48) && (ch <= 57));
}

function charIsAlpha(ch) {
  return (((ch >= 65) && (ch <= 90)) || ((ch >= 97) && (ch <= 122)));
}

function charIsAlphanumeric(ch) {
  return (charIsAlpha(ch) || charIsDigit(ch));
}

function strSplitWords(s) {
  let result = [];
  let word = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (charIsAlpha(ch)) {
      if (((ch >= 65) && (ch <= 90))) {
        (word += String.fromCharCode(((ch + 32) & 0xFF)));
      } else {
        (word += String.fromCharCode(ch));
      }
    } else {
      if ((word.length > 0)) {
        result.push(word);
        word = "";
      }
    }
  }
  if ((word.length > 0)) {
    result.push(word);
  }
  return result;
}

function strSplitWhitespace(s) {
  let result = [];
  let token = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (charIsWhitespace(ch)) {
      if ((token.length > 0)) {
        result.push(token);
        token = "";
      }
    } else {
      (token += String.fromCharCode(ch));
    }
  }
  if ((token.length > 0)) {
    result.push(token);
  }
  return result;
}

function trim(s) {
  let start = 0;
  while ((start < s.length)) {
    const ch = s.charCodeAt(start);
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    start = Math.trunc((start + 1));
  }
  let end = s.length;
  while ((end > start)) {
    const ch = s.charCodeAt(Math.trunc((end - 1)));
    if (((((ch != 32) && (ch != 9)) && (ch != 10)) && (ch != 13))) {
      break;
    }
    end = Math.trunc((end - 1));
  }
  return s.slice(start, end);
}

function vecJoin(parts, sep) {
  let result = "";
  for (let i = 0; i < parts.length; i++) {
    if ((i > 0)) {
      result = (result + sep);
    }
    result = (result + parts[i]);
  }
  return result;
}

function strIsEmpty(s) {
  return (s.length == 0);
}

function strCharAt(s, idx) {
  return s.slice(idx, Math.trunc((idx + 1)));
}

function strReverse(s) {
  let result = "";
  let i = s.length;
  while ((i > 0)) {
    let start = Math.trunc((i - 1));
    while (((start > 0) && (((s.charCodeAt(start) & 192) & 0xFF) == 128))) {
      start = Math.trunc((start - 1));
    }
    let j = start;
    while ((j < i)) {
      (result += String.fromCharCode(s.charCodeAt(j)));
      j = Math.trunc((j + 1));
    }
    i = start;
  }
  return result;
}

function strParseInt(s) {
  let result = 0;
  let i = 0;
  let negative = false;
  if (((s.length > 0) && (s.charCodeAt(0) == 45))) {
    negative = true;
    i = 1;
  }
  while ((i < s.length)) {
    const ch = s.charCodeAt(i);
    if (((ch < 48) || (ch > 57))) {
      break;
    }
    const digit = Math.trunc(((ch - 48) & 0xFF));
    result = Math.trunc((Math.trunc((result * 10)) + digit));
    i = Math.trunc((i + 1));
  }
  if (negative) {
    return Math.trunc((0 - result));
  }
  return result;
}

function strReplaceFirst(s, old, newVal) {
  const idx = strIndexOf(s, old);
  let notFound = 0;
  notFound = Math.trunc((notFound - 1));
  if ((idx == notFound)) {
    return s;
  }
  return ((s.slice(0, idx) + newVal) + s.slice(Math.trunc((idx + old.length)), s.length));
}

function loadRom(m, cart) {
  let i = 0;
  while (((i < cart.rom.length) && (i < 4194304))) {
    m.ram[i] = cart.rom[i];
    m.z80.rom.push(cart.rom[i]);
    i = Math.trunc((i + 1));
  }
}

function createGenesis(rom) {
  let cart = new Cart([], "", 0);
  const _t0 = parseCart(rom);
  if (_t0.tag === 0) {
    const c = _t0.data[0];
    cart = c;
  } else if (_t0.tag === 1) {
    const e = _t0.data[0];
    __print(("Genesis ROM parse failed: " + e) + "\n");
  }
  let m = newMem();
  m.genesis = true;
  m.z80.gen = true;
  loadRom(m, cart);
  const sp = ((((((((Math.trunc(m.ram[0]) << 24) >>> 0) | ((Math.trunc(m.ram[1]) << 16) >>> 0)) >>> 0) | ((Math.trunc(m.ram[2]) << 8) >>> 0)) >>> 0) | Math.trunc(m.ram[3])) >>> 0);
  const pc = ((((((((Math.trunc(m.ram[4]) << 24) >>> 0) | ((Math.trunc(m.ram[5]) << 16) >>> 0)) >>> 0) | ((Math.trunc(m.ram[6]) << 8) >>> 0)) >>> 0) | Math.trunc(m.ram[7])) >>> 0);
  let cpu = newCpu();
  cpu.a[7] = ((sp & 4294967295) >>> 0);
  cpu.pc = ((pc & 4294967295) >>> 0);
  cpu.sr = 9984;
  const h = frameHeight(m);
  let rgba = [];
  let t = 0;
  while ((t < Math.trunc((Math.trunc((MAXW * h)) * 4)))) {
    rgba.push(0);
    t = Math.trunc((t + 1));
  }
  let samples = [];
  return new GenHandle(cpu, m, newSynth(), rgba, samples);
}

function setButtons(h, p) {
  h.m.pad1 = p;
}

function runFrame(cpu, m) {
  let line = 0;
  while ((line < 262)) {
    m.vdpLine = line;
    let k = 0;
    while ((k < 130)) {
      if ((!cpu.halted)) {
        step(cpu, m);
      }
      if ((z80Running(m) && (((k & 1) >>> 0) == 0))) {
        stepZ80(m.z80);
      }
      k = Math.trunc((k + 1));
    }
    if ((line == 224)) {
      if ((((m.vdpRegs[1] & 32) >>> 0) != 0)) {
        deliverInterrupt(cpu, m, 6);
      }
      if (z80Running(m)) {
        z80Interrupt(m.z80);
      }
    }
    line = Math.trunc((line + 1));
  }
}

function stepFrame(h) {
  runFrame(h.cpu, h.m);
  let sa = 0;
  while ((sa < 735)) {
    const smp = synthSample(h.synth, h.m.z80);
    h.samples.push(((smp.l << 16) >> 16));
    h.samples.push(((smp.r << 16) >> 16));
    sa = Math.trunc((sa + 1));
  }
  const fb = renderIndexed(h.m);
  const srcW = frameWidth(h.m);
  let i = 0;
  while ((i < fb.length)) {
    const row = Math.trunc(Math.trunc(i / srcW));
    const col = (i % srcW);
    const dst = Math.trunc((Math.trunc((Math.trunc((row * MAXW)) + col)) * 4));
    h.rgba[dst] = (pixelR(h.m, fb[i]) & 0xFF);
    h.rgba[Math.trunc((dst + 1))] = (pixelG(h.m, fb[i]) & 0xFF);
    h.rgba[Math.trunc((dst + 2))] = (pixelB(h.m, fb[i]) & 0xFF);
    h.rgba[Math.trunc((dst + 3))] = 255;
    i = Math.trunc((i + 1));
  }
}

function frameH(h) {
  return frameHeight(h.m);
}

function main() {
  return 0;
}

function romByte(rom, addr) {
  if ((addr < rom.length)) {
    return rom[addr];
  }
  return 0;
}

function parseCart(raw) {
  if ((raw.length < 512)) {
    return Result_Cart_string.Err("file too small to be a Genesis ROM");
  }
  let rom = [];
  for (const b of raw) {
    rom.push(b);
  }
  let end = Math.trunc((288 + 48));
  while (((end > 288) && (Math.trunc(rom[Math.trunc((end - 1))]) == 32))) {
    end = Math.trunc((end - 1));
  }
  while ((((end >= 290) && (Math.trunc(rom[Math.trunc((end - 2))]) == 129)) && (Math.trunc(rom[Math.trunc((end - 1))]) == 64))) {
    end = Math.trunc((end - 2));
  }
  let name = "";
  let j = 288;
  while ((j < end)) {
    const b = Math.trunc(rom[j]);
    if ((((b == 129) && (Math.trunc((j + 1)) < end)) && (Math.trunc(rom[Math.trunc((j + 1))]) == 64))) {
      name = (name + " ");
      j = Math.trunc((j + 2));
    } else {
      if (((b == 130) && (Math.trunc((j + 1)) < end))) {
        const c = Math.trunc(rom[Math.trunc((j + 1))]);
        let out = (-1);
        if (((c >= 79) && (c <= 88))) {
          out = Math.trunc((48 + Math.trunc((c - 79))));
        } else {
          if (((c >= 96) && (c <= 121))) {
            out = Math.trunc((65 + Math.trunc((c - 96))));
          } else {
            if (((c >= 129) && (c <= 154))) {
              out = Math.trunc((97 + Math.trunc((c - 129))));
            }
          }
        }
        if ((out >= 0)) {
          name = (name + charFromByte((out & 0xFF)));
        }
        j = Math.trunc((j + 2));
      } else {
        if (((b >= 32) && (b <= 126))) {
          name = (name + charFromByte(rom[j]));
          j = Math.trunc((j + 1));
        } else {
          j = Math.trunc((j + 1));
        }
      }
    }
  }
  const romEnd = ((((((((Math.trunc(rom[420]) << 24) >>> 0) | ((Math.trunc(rom[421]) << 16) >>> 0)) >>> 0) | ((Math.trunc(rom[422]) << 8) >>> 0)) >>> 0) | Math.trunc(rom[423])) >>> 0);
  return Result_Cart_string.Ok(new Cart(rom, name, romEnd));
}

function charFromByte(b) {
  let s = "";
  (s += String.fromCharCode(b));
  return s;
}

function newMem() {
  let ram = [];
  let i = 0;
  while ((i < 16777216)) {
    ram.push(0);
    i = Math.trunc((i + 1));
  }
  return new Mem(ram, [], false, [], Array.from({length: 64}, () => __clone(0)), Array.from({length: 40}, () => __clone(0)), Array.from({length: 24}, () => __clone(0)), 0, 0, 0, false, 0, false, 0, 0, 0, 0, false, true, newZ80(), 0, false, 0, false);
}

function z80Running(m) {
  return (!m.z80Reset);
}

function padRead(m) {
  const p = m.pad1;
  let v = 0;
  if (m.padTh) {
    v = 64;
    if ((((p & 1) >>> 0) == 0)) {
      v = ((v | 1) >>> 0);
    }
    if ((((p & 2) >>> 0) == 0)) {
      v = ((v | 2) >>> 0);
    }
    if ((((p & 4) >>> 0) == 0)) {
      v = ((v | 4) >>> 0);
    }
    if ((((p & 8) >>> 0) == 0)) {
      v = ((v | 8) >>> 0);
    }
    if ((((p & 32) >>> 0) == 0)) {
      v = ((v | 16) >>> 0);
    }
    if ((((p & 64) >>> 0) == 0)) {
      v = ((v | 32) >>> 0);
    }
  } else {
    if ((((p & 1) >>> 0) == 0)) {
      v = ((v | 1) >>> 0);
    }
    if ((((p & 2) >>> 0) == 0)) {
      v = ((v | 2) >>> 0);
    }
    if ((((p & 16) >>> 0) == 0)) {
      v = ((v | 16) >>> 0);
    }
    if ((((p & 128) >>> 0) == 0)) {
      v = ((v | 32) >>> 0);
    }
  }
  return v;
}

function memRead8(m, addr) {
  const a = ((addr & ADDR_MASK) >>> 0);
  if ((m.genesis && isDevice(a))) {
    return devRead8(m, a);
  }
  return Math.trunc(m.ram[a]);
}

function memWrite8(m, addr, val) {
  const a = ((addr & ADDR_MASK) >>> 0);
  if (m.genesis) {
    if ((a < 4194304)) {
      return;
    }
    if (isDevice(a)) {
      if (((a >= 10485760) && (a <= 10551295))) {
        const za = ((a & 65535) >>> 0);
        if ((za < 8192)) {
          m.z80.mem[za] = (((val & 255) >>> 0) & 0xFF);
        } else {
          z80DevWrite(m.z80, za, ((val & 255) >>> 0));
        }
      } else {
        if (((a >= 10567680) && (a <= 10567683))) {
          m.tmssUnlocked = true;
        } else {
          if ((a == 10551299)) {
            m.padTh = (((val & 64) >>> 0) != 0);
          }
        }
      }
      return;
    }
  }
  m.ram[a] = (((val & 255) >>> 0) & 0xFF);
  m.touched.push(a);
}

function memRead16(m, addr) {
  const a = ((addr & ADDR_MASK) >>> 0);
  if ((m.genesis && isDevice(a))) {
    return devRead16(m, a);
  }
  return ((((Math.trunc(m.ram[a]) << 8) >>> 0) | Math.trunc(m.ram[((Math.trunc((a + 1)) & ADDR_MASK) >>> 0)])) >>> 0);
}

function memWrite16(m, addr, val) {
  const a = ((addr & ADDR_MASK) >>> 0);
  if (m.genesis) {
    if ((a < 4194304)) {
      return;
    }
    if (isDevice(a)) {
      devWrite16(m, a, ((val & 65535) >>> 0));
      return;
    }
  }
  memWrite8(m, addr, ((Math.floor(val / 2 ** (8)) & 255) >>> 0));
  memWrite8(m, Math.trunc((addr + 1)), ((val & 255) >>> 0));
}

function isDevice(a) {
  return ((a >= 10485760) && (a < 12582928));
}

function vdpStatus(m) {
  let s = ((13312 | 512) >>> 0);
  if ((m.vdpLine >= 224)) {
    s = ((s | 8) >>> 0);
  }
  return s;
}

function devRead16(m, a) {
  if (((a == 12582916) || (a == 12582918))) {
    return vdpStatus(m);
  }
  if (((a == 12582920) || (a == 12582922))) {
    return ((((m.vdpLine & 255) >>> 0) << 8) >>> 0);
  }
  if (((a == 12582912) || (a == 12582914))) {
    return 0;
  }
  if ((a == 10555648)) {
    return 0;
  }
  if ((a == 10551296)) {
    return 160;
  }
  if (((a >= 10551298) && (a <= 10551311))) {
    return 65535;
  }
  return 0;
}

function devRead8(m, a) {
  if (((a >= 10485760) && (a <= 10551295))) {
    const za = ((a & 65535) >>> 0);
    if ((za < 8192)) {
      return Math.trunc(m.z80.mem[za]);
    }
    return 0;
  }
  if ((a == 10551297)) {
    return 160;
  }
  if ((a == 10551299)) {
    return padRead(m);
  }
  if ((a == 10551301)) {
    return 127;
  }
  const w = devRead16(m, ((a & (~1)) >>> 0));
  if ((((a & 1) >>> 0) == 0)) {
    return ((Math.floor(w / 2 ** (8)) & 255) >>> 0);
  }
  return ((w & 255) >>> 0);
}

function devWrite16(m, a, val) {
  if (((a >= 10485760) && (a <= 10551295))) {
    const za = ((a & 65535) >>> 0);
    if ((za < 8192)) {
      m.z80.mem[za] = (((Math.floor(val / 2 ** (8)) & 255) >>> 0) & 0xFF);
      m.z80.mem[((Math.trunc((za + 1)) & 8191) >>> 0)] = (((val & 255) >>> 0) & 0xFF);
    } else {
      z80DevWrite(m.z80, za, ((Math.floor(val / 2 ** (8)) & 255) >>> 0));
      z80DevWrite(m.z80, Math.trunc((za + 1)), ((val & 255) >>> 0));
    }
    return;
  }
  if (((a == 12582912) || (a == 12582914))) {
    vdpDataWrite(m, val);
    return;
  }
  if (((a == 12582916) || (a == 12582918))) {
    vdpControlWrite(m, val);
    return;
  }
  if ((a == 10555648)) {
    m.z80Busreq = (((val & 256) >>> 0) != 0);
    return;
  }
  if ((a == 10555904)) {
    m.z80Reset = (((val & 256) >>> 0) == 0);
    return;
  }
  if ((a == 10567680)) {
    m.tmssUnlocked = true;
    return;
  }
  if ((a == 10551298)) {
    m.ctrl1 = ((val & 65535) >>> 0);
    m.padTh = (((val & 64) >>> 0) != 0);
  }
}

function vdpControlWrite(m, val) {
  if (m.vdpPending) {
    m.vdpPending = false;
    const first = m.vdpFirst;
    m.vdpAddr = ((((first & 16383) >>> 0) | ((((val & 3) >>> 0) << 14) >>> 0)) >>> 0);
    m.vdpCode = ((((Math.floor(first / 2 ** (14)) & 3) >>> 0) | ((Math.floor(val / 2 ** (2)) & 60) >>> 0)) >>> 0);
    if ((((m.vdpCode & 32) >>> 0) != 0)) {
      vdpDma(m);
    }
    return;
  }
  if ((((val & 49152) >>> 0) == 32768)) {
    const reg = ((Math.floor(val / 2 ** (8)) & 31) >>> 0);
    if ((reg < 24)) {
      m.vdpRegs[reg] = ((val & 255) >>> 0);
    }
    return;
  }
  m.vdpFirst = val;
  m.vdpPending = true;
}

function vdpDma(m) {
  const mode = ((Math.floor(m.vdpRegs[23] / 2 ** (6)) & 3) >>> 0);
  if ((mode == 2)) {
    let flen = ((((m.vdpRegs[20] << 8) >>> 0) | m.vdpRegs[19]) >>> 0);
    if ((flen == 0)) {
      flen = 65536;
    }
    m.fillAddr = m.vdpAddr;
    m.fillInc = m.vdpRegs[15];
    m.fillLen = flen;
    doFill(m, m.lastDataByte);
    return;
  }
  if ((mode == 3)) {
    vdpDmaCopy(m);
    return;
  }
  let src = ((((((((m.vdpRegs[23] & 127) >>> 0) << 17) >>> 0) | ((m.vdpRegs[22] << 9) >>> 0)) >>> 0) | ((m.vdpRegs[21] << 1) >>> 0)) >>> 0);
  let len = ((((m.vdpRegs[20] << 8) >>> 0) | m.vdpRegs[19]) >>> 0);
  if ((len == 0)) {
    len = 65536;
  }
  let i = 0;
  while ((i < len)) {
    const a = ((src & 16777215) >>> 0);
    const w = ((((Math.trunc(m.ram[a]) << 8) >>> 0) | Math.trunc(m.ram[((Math.trunc((a + 1)) & 16777215) >>> 0)])) >>> 0);
    vdpDataWrite(m, w);
    src = ((Math.trunc((src + 2)) & 16777215) >>> 0);
    i = Math.trunc((i + 1));
  }
  const srcWord = ((Math.floor(src / 2 ** (1)) & 65535) >>> 0);
  m.vdpRegs[21] = ((srcWord & 255) >>> 0);
  m.vdpRegs[22] = ((Math.floor(srcWord / 2 ** (8)) & 255) >>> 0);
  m.vdpRegs[19] = 0;
  m.vdpRegs[20] = 0;
}

function vdpDmaCopy(m) {
  let src = ((((m.vdpRegs[22] << 8) >>> 0) | m.vdpRegs[21]) >>> 0);
  let len = ((((m.vdpRegs[20] << 8) >>> 0) | m.vdpRegs[19]) >>> 0);
  if ((len == 0)) {
    len = 65536;
  }
  let dst = m.vdpAddr;
  let i = 0;
  while ((i < len)) {
    while ((m.vram.length <= ((dst & 65535) >>> 0))) {
      m.vram.push(0);
    }
    const sb = (() => {
    if ((((src & 65535) >>> 0) < m.vram.length)) {
      return m.vram[((src & 65535) >>> 0)];
    } else {
      return 0;
    }
    })();
    m.vram[((dst & 65535) >>> 0)] = sb;
    src = ((Math.trunc((src + 1)) & 65535) >>> 0);
    dst = ((Math.trunc((dst + m.vdpRegs[15])) & 65535) >>> 0);
    i = Math.trunc((i + 1));
  }
  m.vdpAddr = ((dst & 131071) >>> 0);
}

function doFill(m, fillByteIn) {
  m.dmaFillPending = false;
  const fillByte = (((fillByteIn & 255) >>> 0) & 0xFF);
  const len = m.fillLen;
  const inc = m.fillInc;
  let da = m.fillAddr;
  let i = 0;
  while ((i < len)) {
    const idx = ((da & 65535) >>> 0);
    while ((m.vram.length <= idx)) {
      m.vram.push(0);
    }
    m.vram[idx] = fillByte;
    da = ((Math.trunc((da + inc)) & 131071) >>> 0);
    i = Math.trunc((i + 1));
  }
  m.vdpAddr = ((da & 131071) >>> 0);
}

function vdpDataWrite(m, val) {
  m.lastDataByte = ((Math.floor(val / 2 ** (8)) & 255) >>> 0);
  const target = ((m.vdpCode & 15) >>> 0);
  const a = m.vdpAddr;
  if ((target == 1)) {
    while ((m.vram.length <= ((a | 1) >>> 0))) {
      m.vram.push(0);
    }
    const base = ((a & 65534) >>> 0);
    const hi = (((Math.floor(val / 2 ** (8)) & 255) >>> 0) & 0xFF);
    const lo = (((val & 255) >>> 0) & 0xFF);
    if ((((a & 1) >>> 0) == 0)) {
      m.vram[base] = hi;
      m.vram[Math.trunc((base + 1))] = lo;
    } else {
      m.vram[base] = lo;
      m.vram[Math.trunc((base + 1))] = hi;
    }
  } else {
    if ((target == 3)) {
      const idx = ((Math.floor(a / 2 ** (1)) & 63) >>> 0);
      m.cram[idx] = ((val & 3822) >>> 0);
    } else {
      if ((target == 5)) {
        const idx = (Math.floor(a / 2 ** (1)) % 40);
        m.vsram[idx] = ((val & 2047) >>> 0);
      }
    }
  }
  m.vdpAddr = ((Math.trunc((a + m.vdpRegs[15])) & 131071) >>> 0);
}

function memRead32(m, addr) {
  return ((((memRead16(m, addr) << 16) >>> 0) | memRead16(m, Math.trunc((addr + 2)))) >>> 0);
}

function memWrite32(m, addr, val) {
  memWrite16(m, addr, ((Math.floor(val / 2 ** (16)) & 65535) >>> 0));
  memWrite16(m, Math.trunc((addr + 2)), ((val & 65535) >>> 0));
}

function newCpu() {
  return new M68k([0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], 0, 0, 9984, false, false, 0, true, false, false);
}

function checkAlign(cpu, addr, size, isRead, isFetch) {
  if ((((size != 0) && (((addr & 1) >>> 0) != 0)) && (!cpu.fault))) {
    cpu.fault = true;
    cpu.faultAddr = ((addr & 4294967295) >>> 0);
    cpu.faultRW = isRead;
    cpu.faultIN = isFetch;
    cpu.faultCommit = false;
    return true;
  }
  return cpu.fault;
}

function isSuper(cpu) {
  return (((cpu.sr & SR_S) >>> 0) != 0);
}

function sizeMask(size) {
  if ((size == 0)) {
    return 255;
  }
  if ((size == 1)) {
    return 65535;
  }
  return 4294967295;
}

function sizeMsb(size) {
  if ((size == 0)) {
    return 128;
  }
  if ((size == 1)) {
    return 32768;
  }
  return 2147483648;
}

function sizeBytes(size) {
  if ((size == 0)) {
    return 1;
  }
  if ((size == 1)) {
    return 2;
  }
  return 4;
}

function signExtend(val, size) {
  const m = sizeMask(size);
  const v = ((val & m) >>> 0);
  const msb = sizeMsb(size);
  if ((((v & msb) >>> 0) != 0)) {
    return Math.trunc((v - Math.trunc((m + 1))));
  }
  return v;
}

function getD(cpu, n, size) {
  return ((cpu.d[n] & sizeMask(size)) >>> 0);
}

function setD(cpu, n, size, val) {
  const m = sizeMask(size);
  cpu.d[n] = ((((cpu.d[n] & (~m)) >>> 0) | ((val & m) >>> 0)) >>> 0);
}

function setA(cpu, n, size, val) {
  if ((size == 1)) {
    cpu.a[n] = ((signExtend(val, 1) & 4294967295) >>> 0);
  } else {
    cpu.a[n] = ((val & 4294967295) >>> 0);
  }
}

function fetch16(cpu, m) {
  const w = memRead16(m, cpu.pc);
  cpu.pc = ((Math.trunc((cpu.pc + 2)) & 4294967295) >>> 0);
  return w;
}

function fetch32(cpu, m) {
  const hi = fetch16(cpu, m);
  const lo = fetch16(cpu, m);
  return ((((hi << 16) >>> 0) | lo) >>> 0);
}

function incrStep(reg, size) {
  const b = sizeBytes(size);
  if (((reg == 7) && (b == 1))) {
    return 2;
  }
  return b;
}

function briefIndex(cpu, ext) {
  const ri = ((Math.floor(ext / 2 ** (12)) & 7) >>> 0);
  const isAddr = (((ext & 32768) >>> 0) != 0);
  let idx = (() => {
  if (isAddr) {
    return cpu.a[ri];
  } else {
    return cpu.d[ri];
  }
  })();
  if ((((ext & 2048) >>> 0) == 0)) {
    return signExtend(idx, 1);
  }
  return signExtend(idx, 2);
}

function resolveEa(cpu, m, mode, reg, size) {
  if ((mode == 0)) {
    return Ea.DReg(reg);
  }
  if ((mode == 1)) {
    return Ea.AReg(reg);
  }
  if ((mode == 2)) {
    return Ea.MemAddr(((cpu.a[reg] & 4294967295) >>> 0));
  }
  if ((mode == 3)) {
    const addr = ((cpu.a[reg] & 4294967295) >>> 0);
    cpu.a[reg] = ((Math.trunc((cpu.a[reg] + incrStep(reg, size))) & 4294967295) >>> 0);
    return Ea.MemAddr(addr);
  }
  if ((mode == 4)) {
    cpu.a[reg] = ((Math.trunc((cpu.a[reg] - incrStep(reg, size))) & 4294967295) >>> 0);
    return Ea.MemAddr(((cpu.a[reg] & 4294967295) >>> 0));
  }
  if ((mode == 5)) {
    const d16 = signExtend(fetch16(cpu, m), 1);
    return Ea.MemAddr(((Math.trunc((cpu.a[reg] + d16)) & 4294967295) >>> 0));
  }
  if ((mode == 6)) {
    const base = cpu.a[reg];
    const ext = fetch16(cpu, m);
    const disp = signExtend(((ext & 255) >>> 0), 0);
    return Ea.MemAddr(((Math.trunc((Math.trunc((base + disp)) + briefIndex(cpu, ext))) & 4294967295) >>> 0));
  }
  if ((reg == 0)) {
    return Ea.MemAddr(((signExtend(fetch16(cpu, m), 1) & 4294967295) >>> 0));
  }
  if ((reg == 1)) {
    return Ea.MemAddr(((fetch32(cpu, m) & 4294967295) >>> 0));
  }
  if ((reg == 2)) {
    const base = cpu.pc;
    const d16 = signExtend(fetch16(cpu, m), 1);
    return Ea.MemAddr(((Math.trunc((base + d16)) & 4294967295) >>> 0));
  }
  if ((reg == 3)) {
    const base = cpu.pc;
    const ext = fetch16(cpu, m);
    const disp = signExtend(((ext & 255) >>> 0), 0);
    return Ea.MemAddr(((Math.trunc((Math.trunc((base + disp)) + briefIndex(cpu, ext))) & 4294967295) >>> 0));
  }
  if ((size == 2)) {
    return Ea.Imm(fetch32(cpu, m));
  }
  return Ea.Imm(((fetch16(cpu, m) & sizeMask(size)) >>> 0));
}

function eaLoad(cpu, m, ea, size) {
  const _t1 = ea;
  if (_t1.tag === 0) {
    const n = _t1.data[0];
    return getD(cpu, n, size);
  } else if (_t1.tag === 1) {
    const n = _t1.data[0];
    return ((signExtend(cpu.a[n], size) & sizeMask(size)) >>> 0);
  } else if (_t1.tag === 2) {
    const addr = _t1.data[0];
    if (checkAlign(cpu, addr, size, true, false)) {
      return 0;
    }
    if ((size == 0)) {
      return memRead8(m, addr);
    }
    if ((size == 1)) {
      return memRead16(m, addr);
    }
    return memRead32(m, addr);
  } else if (_t1.tag === 3) {
    const v = _t1.data[0];
    return ((v & sizeMask(size)) >>> 0);
  }
}

function eaStore(cpu, m, ea, size, val) {
  const _t2 = ea;
  if (_t2.tag === 0) {
    const n = _t2.data[0];
    setD(cpu, n, size, val);
  } else if (_t2.tag === 1) {
    const n = _t2.data[0];
    setA(cpu, n, size, val);
  } else if (_t2.tag === 2) {
    const addr = _t2.data[0];
    if (checkAlign(cpu, addr, size, false, false)) {
      return;
    }
    if ((size == 0)) {
      memWrite8(m, addr, val);
    } else {
      if ((size == 1)) {
        memWrite16(m, addr, val);
      } else {
        memWrite32(m, addr, val);
      }
    }
  } else if (_t2.tag === 3) {
    const v = _t2.data[0];
  }
}

function setBit(cpu, bit, on) {
  if (on) {
    cpu.sr = ((cpu.sr | bit) >>> 0);
  } else {
    cpu.sr = ((cpu.sr & (~bit)) >>> 0);
  }
}

function getBit(cpu, bit) {
  return (((cpu.sr & bit) >>> 0) != 0);
}

function setNZ(cpu, size, res) {
  const r = ((res & sizeMask(size)) >>> 0);
  setBit(cpu, SR_N, (((r & sizeMsb(size)) >>> 0) != 0));
  setBit(cpu, SR_Z, (r == 0));
}

function setLogicalFlags(cpu, size, res) {
  setNZ(cpu, size, res);
  setBit(cpu, SR_V, false);
  setBit(cpu, SR_C, false);
}

function addFlags(cpu, size, a, b, res, withX) {
  const mask = sizeMask(size);
  const msb = sizeMsb(size);
  const ua = ((a & mask) >>> 0);
  const ub = ((b & mask) >>> 0);
  const r = ((res & mask) >>> 0);
  const carry = (Math.trunc((ua + ub)) > mask);
  const overflow = ((((((~((a ^ b) >>> 0)) & ((a ^ res) >>> 0)) >>> 0) & msb) >>> 0) != 0);
  setNZ(cpu, size, r);
  setBit(cpu, SR_V, overflow);
  setBit(cpu, SR_C, carry);
  if (withX) {
    setBit(cpu, SR_X, carry);
  }
}

function subFlags(cpu, size, a, b, res, withX) {
  const mask = sizeMask(size);
  const msb = sizeMsb(size);
  const ua = ((a & mask) >>> 0);
  const ub = ((b & mask) >>> 0);
  const r = ((res & mask) >>> 0);
  const borrow = (ub > ua);
  const overflow = (((((((a ^ b) >>> 0) & ((a ^ res) >>> 0)) >>> 0) & msb) >>> 0) != 0);
  setNZ(cpu, size, r);
  setBit(cpu, SR_V, overflow);
  setBit(cpu, SR_C, borrow);
  if (withX) {
    setBit(cpu, SR_X, borrow);
  }
}

function testCond(cpu, cond) {
  const c = getBit(cpu, SR_C);
  const v = getBit(cpu, SR_V);
  const z = getBit(cpu, SR_Z);
  const n = getBit(cpu, SR_N);
  if ((cond == 0)) {
    return true;
  }
  if ((cond == 1)) {
    return false;
  }
  if ((cond == 2)) {
    return ((!c) && (!z));
  }
  if ((cond == 3)) {
    return (c || z);
  }
  if ((cond == 4)) {
    return (!c);
  }
  if ((cond == 5)) {
    return c;
  }
  if ((cond == 6)) {
    return (!z);
  }
  if ((cond == 7)) {
    return z;
  }
  if ((cond == 8)) {
    return (!v);
  }
  if ((cond == 9)) {
    return v;
  }
  if ((cond == 10)) {
    return (!n);
  }
  if ((cond == 11)) {
    return n;
  }
  if ((cond == 12)) {
    return (n == v);
  }
  if ((cond == 13)) {
    return (n != v);
  }
  if ((cond == 14)) {
    return ((!z) && (n == v));
  }
  return (z || (n != v));
}

function pushLong(cpu, m, val) {
  cpu.a[7] = ((Math.trunc((cpu.a[7] - 4)) & 4294967295) >>> 0);
  memWrite32(m, cpu.a[7], val);
}

function pushWord(cpu, m, val) {
  cpu.a[7] = ((Math.trunc((cpu.a[7] - 2)) & 4294967295) >>> 0);
  memWrite16(m, cpu.a[7], ((val & 65535) >>> 0));
}

function raiseAddressError(cpu, m, ir) {
  const oldSr = cpu.sr;
  const wasSuper = (((oldSr & SR_S) >>> 0) != 0);
  cpu.sr = ((((cpu.sr | SR_S) >>> 0) & (~SR_T)) >>> 0);
  if ((!wasSuper)) {
    const tmp = cpu.a[7];
    cpu.a[7] = cpu.otherSp;
    cpu.otherSp = tmp;
  }
  let fc = 1;
  if (cpu.faultIN) {
    if (wasSuper) {
      fc = 6;
    } else {
      fc = 2;
    }
  } else {
    if (wasSuper) {
      fc = 5;
    } else {
      fc = 1;
    }
  }
  let ssw = fc;
  if (cpu.faultRW) {
    ssw = ((ssw | 16) >>> 0);
  }
  if ((!cpu.faultIN)) {
    ssw = ((ssw | 8) >>> 0);
  }
  const faultPc = cpu.pc;
  cpu.fault = false;
  pushLong(cpu, m, faultPc);
  pushWord(cpu, m, oldSr);
  pushWord(cpu, m, ir);
  pushLong(cpu, m, cpu.faultAddr);
  pushWord(cpu, m, ssw);
  cpu.pc = ((memRead32(m, Math.trunc((3 * 4))) & 4294967295) >>> 0);
}

function popLong(cpu, m) {
  const v = memRead32(m, cpu.a[7]);
  cpu.a[7] = ((Math.trunc((cpu.a[7] + 4)) & 4294967295) >>> 0);
  return v;
}

function popWord(cpu, m) {
  const v = memRead16(m, cpu.a[7]);
  cpu.a[7] = ((Math.trunc((cpu.a[7] + 2)) & 4294967295) >>> 0);
  return v;
}

function privViolation(cpu, m) {
  if ((((cpu.sr & SR_S) >>> 0) == 0)) {
    cpu.pc = ((Math.trunc((cpu.pc - 2)) & 4294967295) >>> 0);
    raiseException(cpu, m, 8);
    return true;
  }
  return false;
}

function setSr(cpu, newSr) {
  const oldS = (((cpu.sr & SR_S) >>> 0) != 0);
  cpu.sr = ((newSr & 65535) >>> 0);
  if ((oldS != (((cpu.sr & SR_S) >>> 0) != 0))) {
    const tmp = cpu.a[7];
    cpu.a[7] = cpu.otherSp;
    cpu.otherSp = tmp;
  }
}

function deliverInterrupt(cpu, m, level) {
  const curMask = ((Math.floor(cpu.sr / 2 ** (8)) & 7) >>> 0);
  if (((level != 7) && (level <= curMask))) {
    return false;
  }
  const oldSr = cpu.sr;
  const wasSuper = (((oldSr & SR_S) >>> 0) != 0);
  cpu.sr = ((((cpu.sr & (~1792)) >>> 0) | ((((level & 7) >>> 0) << 8) >>> 0)) >>> 0);
  cpu.sr = ((((cpu.sr | SR_S) >>> 0) & (~SR_T)) >>> 0);
  if ((!wasSuper)) {
    const tmp = cpu.a[7];
    cpu.a[7] = cpu.otherSp;
    cpu.otherSp = tmp;
  }
  cpu.halted = false;
  pushLong(cpu, m, cpu.pc);
  pushWord(cpu, m, oldSr);
  cpu.pc = ((memRead32(m, Math.trunc((Math.trunc((24 + level)) * 4))) & 4294967295) >>> 0);
  return true;
}

function raiseException(cpu, m, vec) {
  const oldSr = cpu.sr;
  const wasSuper = (((oldSr & SR_S) >>> 0) != 0);
  cpu.sr = ((((cpu.sr | SR_S) >>> 0) & (~SR_T)) >>> 0);
  if ((!wasSuper)) {
    const tmp = cpu.a[7];
    cpu.a[7] = cpu.otherSp;
    cpu.otherSp = tmp;
  }
  pushLong(cpu, m, cpu.pc);
  pushWord(cpu, m, oldSr);
  cpu.pc = ((memRead32(m, Math.trunc((vec * 4))) & 4294967295) >>> 0);
}

function setPc(cpu, target) {
  const t = ((target & 4294967295) >>> 0);
  cpu.pc = t;
  if (((((t & 1) >>> 0) != 0) && (!cpu.fault))) {
    cpu.fault = true;
    cpu.faultAddr = t;
    cpu.faultRW = true;
    cpu.faultIN = true;
    cpu.faultCommit = true;
  }
}

function step(cpu, m) {
  if (cpu.halted) {
    return false;
  }
  if ((((cpu.pc & 1) >>> 0) != 0)) {
    cpu.fault = true;
    cpu.faultAddr = ((cpu.pc & 4294967295) >>> 0);
    cpu.faultRW = true;
    cpu.faultIN = true;
    raiseAddressError(cpu, m, memRead16(m, ((cpu.pc & (~1)) >>> 0)));
    return true;
  }
  let savedD = [0, 0, 0, 0, 0, 0, 0, 0];
  let si = 0;
  while ((si < 8)) {
    savedD[si] = cpu.d[si];
    si = Math.trunc((si + 1));
  }
  const savedSr = cpu.sr;
  const op = fetch16(cpu, m);
  const ran = decode(cpu, m, op);
  if (cpu.fault) {
    if ((!cpu.faultCommit)) {
      si = 0;
      while ((si < 8)) {
        cpu.d[si] = savedD[si];
        si = Math.trunc((si + 1));
      }
      cpu.sr = savedSr;
    }
    raiseAddressError(cpu, m, op);
    return true;
  }
  return ran;
}

function decode(cpu, m, op) {
  const top = ((Math.floor(op / 2 ** (12)) & 15) >>> 0);
  if ((top == 1)) {
    return execMove(cpu, m, op, 0);
  }
  if ((top == 3)) {
    return execMove(cpu, m, op, 1);
  }
  if ((top == 2)) {
    return execMove(cpu, m, op, 2);
  }
  if ((top == 7)) {
    if ((((op & 256) >>> 0) == 0)) {
      const reg = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
      const val = signExtend(((op & 255) >>> 0), 0);
      setD(cpu, reg, 2, ((val & 4294967295) >>> 0));
      setLogicalFlags(cpu, 2, val);
      return true;
    }
    return false;
  }
  if ((top == 6)) {
    return execBranch(cpu, m, op);
  }
  if ((top == 5)) {
    return execAddqSubq(cpu, m, op);
  }
  if ((top == 13)) {
    return execAddSub(cpu, m, op, true);
  }
  if ((top == 9)) {
    return execAddSub(cpu, m, op, false);
  }
  if ((top == 11)) {
    return execCmpEor(cpu, m, op);
  }
  if ((top == 12)) {
    return execAnd(cpu, m, op);
  }
  if ((top == 8)) {
    return execOr(cpu, m, op);
  }
  if ((top == 4)) {
    return execMisc(cpu, m, op);
  }
  if ((top == 14)) {
    return execShift(cpu, m, op);
  }
  if ((top == 0)) {
    return execImmediate(cpu, m, op);
  }
  return false;
}

function doShift(cpu, val, size, cnt, sty, left) {
  const mask = sizeMask(size);
  const msb = sizeMsb(size);
  let v = ((val & mask) >>> 0);
  let carry = false;
  let overflow = false;
  let xf = getBit(cpu, SR_X);
  let i = 0;
  while ((i < cnt)) {
    if (left) {
      const msbBit = (((v & msb) >>> 0) != 0);
      let newLsb = false;
      if ((sty == 2)) {
        newLsb = xf;
        carry = msbBit;
        xf = msbBit;
      } else {
        if ((sty == 3)) {
          carry = msbBit;
          newLsb = msbBit;
        } else {
          carry = msbBit;
          xf = msbBit;
        }
      }
      v = ((((((v << 1) >>> 0) | (() => {
      if (newLsb) {
        return 1;
      } else {
        return 0;
      }
      })()) >>> 0) & mask) >>> 0);
      if (((sty == 0) && ((((v & msb) >>> 0) != 0) != msbBit))) {
        overflow = true;
      }
    } else {
      const lsbBit = (((v & 1) >>> 0) != 0);
      let newMsb = false;
      if ((sty == 0)) {
        newMsb = (((v & msb) >>> 0) != 0);
        carry = lsbBit;
        xf = lsbBit;
      } else {
        if ((sty == 1)) {
          carry = lsbBit;
          xf = lsbBit;
        } else {
          if ((sty == 3)) {
            carry = lsbBit;
            newMsb = lsbBit;
          } else {
            newMsb = xf;
            carry = lsbBit;
            xf = lsbBit;
          }
        }
      }
      v = ((((Math.floor(v / 2 ** (1)) | (() => {
      if (newMsb) {
        return msb;
      } else {
        return 0;
      }
      })()) >>> 0) & mask) >>> 0);
    }
    i = Math.trunc((i + 1));
  }
  setNZ(cpu, size, v);
  setBit(cpu, SR_V, (((sty == 0) && left) && overflow));
  if ((cnt == 0)) {
    if ((sty == 2)) {
      setBit(cpu, SR_C, getBit(cpu, SR_X));
    } else {
      setBit(cpu, SR_C, false);
    }
  } else {
    setBit(cpu, SR_C, carry);
    if ((sty != 3)) {
      setBit(cpu, SR_X, xf);
    }
  }
  return v;
}

function execShift(cpu, m, op) {
  const left = (((op & 256) >>> 0) != 0);
  if ((((op & 192) >>> 0) == 192)) {
    const sty = ((Math.floor(op / 2 ** (9)) & 3) >>> 0);
    const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
    const reg = ((op & 7) >>> 0);
    const ea = resolveEa(cpu, m, mode, reg, 1);
    const v = eaLoad(cpu, m, ea, 1);
    const r = doShift(cpu, v, 1, 1, sty, left);
    eaStore(cpu, m, ea, 1, r);
    return true;
  }
  const size = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const sty = ((Math.floor(op / 2 ** (3)) & 3) >>> 0);
  const ir = ((Math.floor(op / 2 ** (5)) & 1) >>> 0);
  const reg = ((op & 7) >>> 0);
  let cnt = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  if ((ir == 0)) {
    if ((cnt == 0)) {
      cnt = 8;
    }
  } else {
    cnt = ((getD(cpu, ((Math.floor(op / 2 ** (9)) & 7) >>> 0), 2) & 63) >>> 0);
  }
  const v = getD(cpu, reg, size);
  const r = doShift(cpu, v, size, cnt, sty, left);
  setD(cpu, reg, size, r);
  return true;
}

function execImmediate(cpu, m, op) {
  if ((((op & 61752) >>> 0) == 264)) {
    return execMovep(cpu, m, op);
  }
  const dynamicBit = (((op & 256) >>> 0) != 0);
  const staticBit = (((op & 65280) >>> 0) == 2048);
  if ((dynamicBit || staticBit)) {
    return execBitOp(cpu, m, op, staticBit);
  }
  const which = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const size = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  if ((size == 3)) {
    return false;
  }
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  if ((((mode == 7) && (reg == 4)) && (((which == 0) || (which == 1)) || (which == 5)))) {
    const imm = fetch16(cpu, m);
    if ((size == 0)) {
      const ccr = ((cpu.sr & 31) >>> 0);
      const r = ((applyLogic(which, ccr, ((imm & 31) >>> 0)) & 31) >>> 0);
      cpu.sr = ((((cpu.sr & (~31)) >>> 0) | r) >>> 0);
      return true;
    }
    const oldS = (((cpu.sr & SR_S) >>> 0) != 0);
    const r = ((applyLogic(which, cpu.sr, imm) & 42783) >>> 0);
    cpu.sr = r;
    if ((oldS != (((r & SR_S) >>> 0) != 0))) {
      const tmp = cpu.a[7];
      cpu.a[7] = cpu.otherSp;
      cpu.otherSp = tmp;
    }
    return true;
  }
  const imm = (() => {
  if ((size == 2)) {
    return fetch32(cpu, m);
  } else {
    return ((fetch16(cpu, m) & sizeMask(size)) >>> 0);
  }
  })();
  const ea = resolveEa(cpu, m, mode, reg, size);
  const cur = eaLoad(cpu, m, ea, size);
  if ((which == 2)) {
    const res = ((Math.trunc((cur - imm)) & sizeMask(size)) >>> 0);
    subFlags(cpu, size, cur, imm, res, true);
    eaStore(cpu, m, ea, size, res);
  } else {
    if ((which == 3)) {
      const res = ((Math.trunc((cur + imm)) & sizeMask(size)) >>> 0);
      addFlags(cpu, size, cur, imm, res, true);
      eaStore(cpu, m, ea, size, res);
    } else {
      if ((which == 6)) {
        const res = ((Math.trunc((cur - imm)) & sizeMask(size)) >>> 0);
        subFlags(cpu, size, cur, imm, res, false);
      } else {
        const res = ((applyLogic(which, cur, imm) & sizeMask(size)) >>> 0);
        eaStore(cpu, m, ea, size, res);
        setLogicalFlags(cpu, size, res);
      }
    }
  }
  return true;
}

function execMovep(cpu, m, op) {
  const dreg = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const areg = ((op & 7) >>> 0);
  const opmode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const disp = signExtend(fetch16(cpu, m), 1);
  const addr = ((Math.trunc((cpu.a[areg] + disp)) & 4294967295) >>> 0);
  const isLong = (((opmode & 1) >>> 0) != 0);
  const toMem = (((opmode & 2) >>> 0) != 0);
  if (toMem) {
    const d = ((cpu.d[dreg] & 4294967295) >>> 0);
    if (isLong) {
      memWrite8(m, addr, ((Math.floor(d / 2 ** (24)) & 255) >>> 0));
      memWrite8(m, ((Math.trunc((addr + 2)) & 4294967295) >>> 0), ((Math.floor(d / 2 ** (16)) & 255) >>> 0));
      memWrite8(m, ((Math.trunc((addr + 4)) & 4294967295) >>> 0), ((Math.floor(d / 2 ** (8)) & 255) >>> 0));
      memWrite8(m, ((Math.trunc((addr + 6)) & 4294967295) >>> 0), ((d & 255) >>> 0));
    } else {
      memWrite8(m, addr, ((Math.floor(d / 2 ** (8)) & 255) >>> 0));
      memWrite8(m, ((Math.trunc((addr + 2)) & 4294967295) >>> 0), ((d & 255) >>> 0));
    }
  } else {
    if (isLong) {
      const v = ((((((((((memRead8(m, addr) << 24) >>> 0) | ((memRead8(m, ((Math.trunc((addr + 2)) & 4294967295) >>> 0)) << 16) >>> 0)) >>> 0) | ((memRead8(m, ((Math.trunc((addr + 4)) & 4294967295) >>> 0)) << 8) >>> 0)) >>> 0) | memRead8(m, ((Math.trunc((addr + 6)) & 4294967295) >>> 0))) >>> 0) & 4294967295) >>> 0);
      cpu.d[dreg] = v;
    } else {
      const v = ((((((memRead8(m, addr) << 8) >>> 0) | memRead8(m, ((Math.trunc((addr + 2)) & 4294967295) >>> 0))) >>> 0) & 65535) >>> 0);
      setD(cpu, dreg, 1, v);
    }
  }
  return true;
}

function applyLogic(which, a, b) {
  if ((which == 0)) {
    return ((a | b) >>> 0);
  }
  if ((which == 1)) {
    return ((a & b) >>> 0);
  }
  return ((a ^ b) >>> 0);
}

function execBitOp(cpu, m, op, isStatic) {
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  let bitNum = 0;
  if (isStatic) {
    bitNum = ((fetch16(cpu, m) & 255) >>> 0);
  } else {
    bitNum = ((getD(cpu, ((Math.floor(op / 2 ** (9)) & 7) >>> 0), 2) & 255) >>> 0);
  }
  const opType = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  if ((mode == 0)) {
    const b = ((bitNum & 31) >>> 0);
    const v = ((cpu.d[reg] & 4294967295) >>> 0);
    const bit = ((Math.floor(v / 2 ** (b)) & 1) >>> 0);
    setBit(cpu, SR_Z, (bit == 0));
    if ((opType == 1)) {
      cpu.d[reg] = ((v ^ ((1 << b) >>> 0)) >>> 0);
    } else {
      if ((opType == 2)) {
        cpu.d[reg] = ((v & (~((1 << b) >>> 0))) >>> 0);
      } else {
        if ((opType == 3)) {
          cpu.d[reg] = ((v | ((1 << b) >>> 0)) >>> 0);
        }
      }
    }
    return true;
  }
  const b = ((bitNum & 7) >>> 0);
  const ea = resolveEa(cpu, m, mode, reg, 0);
  const v = eaLoad(cpu, m, ea, 0);
  const bit = ((Math.floor(v / 2 ** (b)) & 1) >>> 0);
  setBit(cpu, SR_Z, (bit == 0));
  if ((opType == 1)) {
    eaStore(cpu, m, ea, 0, ((v ^ ((1 << b) >>> 0)) >>> 0));
  } else {
    if ((opType == 2)) {
      eaStore(cpu, m, ea, 0, ((v & (~((1 << b) >>> 0))) >>> 0));
    } else {
      if ((opType == 3)) {
        eaStore(cpu, m, ea, 0, ((v | ((1 << b) >>> 0)) >>> 0));
      }
    }
  }
  return true;
}

function execMove(cpu, m, op, size) {
  const srcMode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const srcReg = ((op & 7) >>> 0);
  const dstMode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const dstReg = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const srcEa = resolveEa(cpu, m, srcMode, srcReg, size);
  const val = eaLoad(cpu, m, srcEa, size);
  if ((dstMode == 1)) {
    setA(cpu, dstReg, size, signExtend(val, size));
    return true;
  }
  const dstEa = resolveEa(cpu, m, dstMode, dstReg, size);
  eaStore(cpu, m, dstEa, size, val);
  setLogicalFlags(cpu, size, val);
  return true;
}

function execBranch(cpu, m, op) {
  const cond = ((Math.floor(op / 2 ** (8)) & 15) >>> 0);
  const disp8 = ((op & 255) >>> 0);
  const base = cpu.pc;
  let disp = signExtend(disp8, 0);
  if ((disp8 == 0)) {
    disp = signExtend(fetch16(cpu, m), 1);
  }
  const target = ((Math.trunc((base + disp)) & 4294967295) >>> 0);
  if ((cond == 1)) {
    pushLong(cpu, m, cpu.pc);
    setPc(cpu, target);
    return true;
  }
  if ((cond == 0)) {
    setPc(cpu, target);
    return true;
  }
  if (testCond(cpu, cond)) {
    setPc(cpu, target);
  }
  return true;
}

function execAddqSubq(cpu, m, op) {
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  const size = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  if ((size == 3)) {
    const cond = ((Math.floor(op / 2 ** (8)) & 15) >>> 0);
    if ((mode == 1)) {
      const base = cpu.pc;
      const disp = signExtend(fetch16(cpu, m), 1);
      if (testCond(cpu, cond)) {
        return true;
      }
      const cnt = ((Math.trunc((getD(cpu, reg, 1) - 1)) & 65535) >>> 0);
      setD(cpu, reg, 1, cnt);
      if ((cnt != 65535)) {
        setPc(cpu, Math.trunc((base + disp)));
      }
      return true;
    }
    const ea = resolveEa(cpu, m, mode, reg, 0);
    const v = (() => {
    if (testCond(cpu, cond)) {
      return 255;
    } else {
      return 0;
    }
    })();
    eaStore(cpu, m, ea, 0, v);
    return true;
  }
  let data = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  if ((data == 0)) {
    data = 8;
  }
  const isSub = (((op & 256) >>> 0) != 0);
  const ea = resolveEa(cpu, m, mode, reg, size);
  if ((mode == 1)) {
    const cur = cpu.a[reg];
    const res = (() => {
    if (isSub) {
      return Math.trunc((cur - data));
    } else {
      return Math.trunc((cur + data));
    }
    })();
    cpu.a[reg] = ((res & 4294967295) >>> 0);
    return true;
  }
  const cur = eaLoad(cpu, m, ea, size);
  if (isSub) {
    const res = ((Math.trunc((cur - data)) & sizeMask(size)) >>> 0);
    subFlags(cpu, size, cur, data, res, true);
    eaStore(cpu, m, ea, size, res);
  } else {
    const res = ((Math.trunc((cur + data)) & sizeMask(size)) >>> 0);
    addFlags(cpu, size, cur, data, res, true);
    eaStore(cpu, m, ea, size, res);
  }
  return true;
}

function execAddSubX(cpu, m, op, isAdd, size) {
  const rx = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const ry = ((op & 7) >>> 0);
  const mem = (((Math.floor(op / 2 ** (3)) & 7) >>> 0) == 1);
  const mask = sizeMask(size);
  const msb = sizeMsb(size);
  const bytes = sizeBytes(size);
  const x = (() => {
  if (getBit(cpu, SR_X)) {
    return 1;
  } else {
    return 0;
  }
  })();
  let a = 0;
  let b = 0;
  let addr = 0;
  if (mem) {
    const decY = (() => {
    if (((size == 0) && (ry == 7))) {
      return 2;
    } else {
      return bytes;
    }
    })();
    cpu.a[ry] = ((Math.trunc((cpu.a[ry] - decY)) & 4294967295) >>> 0);
    b = readSized(m, cpu.a[ry], size);
    const decX = (() => {
    if (((size == 0) && (rx == 7))) {
      return 2;
    } else {
      return bytes;
    }
    })();
    cpu.a[rx] = ((Math.trunc((cpu.a[rx] - decX)) & 4294967295) >>> 0);
    addr = cpu.a[rx];
    a = readSized(m, addr, size);
  } else {
    a = getD(cpu, rx, size);
    b = getD(cpu, ry, size);
  }
  const ua = ((a & mask) >>> 0);
  const ub = ((b & mask) >>> 0);
  let res = 0;
  let carry = false;
  let overflow = false;
  if (isAdd) {
    const full = Math.trunc((Math.trunc((ua + ub)) + x));
    res = ((full & mask) >>> 0);
    carry = (full > mask);
    overflow = ((((((~((a ^ b) >>> 0)) & ((a ^ res) >>> 0)) >>> 0) & msb) >>> 0) != 0);
  } else {
    res = ((Math.trunc((Math.trunc((ua - ub)) - x)) & mask) >>> 0);
    carry = (Math.trunc((ub + x)) > ua);
    overflow = (((((((a ^ b) >>> 0) & ((a ^ res) >>> 0)) >>> 0) & msb) >>> 0) != 0);
  }
  setBit(cpu, SR_N, (((res & msb) >>> 0) != 0));
  setBit(cpu, SR_V, overflow);
  setBit(cpu, SR_C, carry);
  setBit(cpu, SR_X, carry);
  if ((res != 0)) {
    setBit(cpu, SR_Z, false);
  }
  if (mem) {
    writeSized(m, addr, size, res);
  } else {
    setD(cpu, rx, size, res);
  }
}

function execExg(cpu, op, opmode, mode) {
  const rx = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const ry = ((op & 7) >>> 0);
  if (((opmode == 5) && (mode == 0))) {
    const t = cpu.d[rx];
    cpu.d[rx] = cpu.d[ry];
    cpu.d[ry] = t;
  } else {
    if (((opmode == 5) && (mode == 1))) {
      const t = cpu.a[rx];
      cpu.a[rx] = cpu.a[ry];
      cpu.a[ry] = t;
    } else {
      if (((opmode == 6) && (mode == 1))) {
        const t = cpu.d[rx];
        cpu.d[rx] = cpu.a[ry];
        cpu.a[ry] = t;
      }
    }
  }
}

function bcdAdd(cpu, srcB, dstB) {
  const x = (() => {
  if (getBit(cpu, SR_X)) {
    return 1;
  } else {
    return 0;
  }
  })();
  let res = Math.trunc((Math.trunc((((srcB & 15) >>> 0) + ((dstB & 15) >>> 0))) + x));
  let v = (((~res) & 4294967295) >>> 0);
  if ((res > 9)) {
    res = Math.trunc((res + 6));
  }
  res = Math.trunc((Math.trunc((res + ((srcB & 240) >>> 0))) + ((dstB & 240) >>> 0)));
  const c = (res > 153);
  if (c) {
    res = Math.trunc((res - 160));
  }
  res = ((res & 4294967295) >>> 0);
  v = ((v & res) >>> 0);
  const res8 = ((res & 255) >>> 0);
  setBit(cpu, SR_N, (((res & 128) >>> 0) != 0));
  setBit(cpu, SR_V, (((v & 128) >>> 0) != 0));
  setBit(cpu, SR_C, c);
  setBit(cpu, SR_X, c);
  if ((res8 != 0)) {
    setBit(cpu, SR_Z, false);
  }
  return res8;
}

function bcdSub(cpu, srcB, dstB) {
  const x = (() => {
  if (getBit(cpu, SR_X)) {
    return 1;
  } else {
    return 0;
  }
  })();
  let res = ((Math.trunc((Math.trunc((((dstB & 15) >>> 0) - ((srcB & 15) >>> 0))) - x)) & 4294967295) >>> 0);
  let v = (((~res) & 4294967295) >>> 0);
  if ((res > 9)) {
    res = ((Math.trunc((res - 6)) & 4294967295) >>> 0);
  }
  res = ((Math.trunc((Math.trunc((res + ((dstB & 240) >>> 0))) - ((srcB & 240) >>> 0))) & 4294967295) >>> 0);
  const c = (res > 153);
  if (c) {
    res = ((Math.trunc((res + 160)) & 4294967295) >>> 0);
  }
  v = ((v & res) >>> 0);
  const res8 = ((res & 255) >>> 0);
  setBit(cpu, SR_N, (((res & 128) >>> 0) != 0));
  setBit(cpu, SR_V, (((v & 128) >>> 0) != 0));
  setBit(cpu, SR_C, c);
  setBit(cpu, SR_X, c);
  if ((res8 != 0)) {
    setBit(cpu, SR_Z, false);
  }
  return res8;
}

function execBcdRM(cpu, m, op, isSub) {
  const rx = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const ry = ((op & 7) >>> 0);
  const mem = (((op & 8) >>> 0) != 0);
  let srcB = 0;
  let dstB = 0;
  let addr = 0;
  if (mem) {
    const decY = (() => {
    if ((ry == 7)) {
      return 2;
    } else {
      return 1;
    }
    })();
    cpu.a[ry] = ((Math.trunc((cpu.a[ry] - decY)) & 4294967295) >>> 0);
    srcB = memRead8(m, cpu.a[ry]);
    const decX = (() => {
    if ((rx == 7)) {
      return 2;
    } else {
      return 1;
    }
    })();
    cpu.a[rx] = ((Math.trunc((cpu.a[rx] - decX)) & 4294967295) >>> 0);
    addr = cpu.a[rx];
    dstB = memRead8(m, addr);
  } else {
    srcB = ((cpu.d[ry] & 255) >>> 0);
    dstB = ((cpu.d[rx] & 255) >>> 0);
  }
  const res = (() => {
  if (isSub) {
    return bcdSub(cpu, srcB, dstB);
  } else {
    return bcdAdd(cpu, srcB, dstB);
  }
  })();
  if (mem) {
    memWrite8(m, addr, res);
  } else {
    setD(cpu, rx, 0, res);
  }
}

function readSized(m, addr, size) {
  if ((size == 0)) {
    return memRead8(m, addr);
  }
  if ((size == 1)) {
    return memRead16(m, addr);
  }
  return memRead32(m, addr);
}

function writeSized(m, addr, size, val) {
  if ((size == 0)) {
    memWrite8(m, addr, val);
  } else {
    if ((size == 1)) {
      memWrite16(m, addr, val);
    } else {
      memWrite32(m, addr, val);
    }
  }
}

function execAddSub(cpu, m, op, isAdd) {
  const dn = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const opmode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  if (((opmode == 3) || (opmode == 7))) {
    const size = (() => {
    if ((opmode == 3)) {
      return 1;
    } else {
      return 2;
    }
    })();
    const ea = resolveEa(cpu, m, mode, reg, size);
    const src = signExtend(eaLoad(cpu, m, ea, size), size);
    const cur = cpu.a[dn];
    const res = (() => {
    if (isAdd) {
      return Math.trunc((cur + src));
    } else {
      return Math.trunc((cur - src));
    }
    })();
    cpu.a[dn] = ((res & 4294967295) >>> 0);
    return true;
  }
  const size = ((opmode & 3) >>> 0);
  const toEa = (((opmode & 4) >>> 0) != 0);
  if ((toEa && ((mode == 0) || (mode == 1)))) {
    execAddSubX(cpu, m, op, isAdd, size);
    return true;
  }
  const ea = resolveEa(cpu, m, mode, reg, size);
  if (toEa) {
    const a = eaLoad(cpu, m, ea, size);
    const b = getD(cpu, dn, size);
    if (isAdd) {
      const res = ((Math.trunc((a + b)) & sizeMask(size)) >>> 0);
      addFlags(cpu, size, a, b, res, true);
      eaStore(cpu, m, ea, size, res);
    } else {
      const res = ((Math.trunc((a - b)) & sizeMask(size)) >>> 0);
      subFlags(cpu, size, a, b, res, true);
      eaStore(cpu, m, ea, size, res);
    }
  } else {
    const a = getD(cpu, dn, size);
    const b = eaLoad(cpu, m, ea, size);
    if (isAdd) {
      const res = ((Math.trunc((a + b)) & sizeMask(size)) >>> 0);
      addFlags(cpu, size, a, b, res, true);
      setD(cpu, dn, size, res);
    } else {
      const res = ((Math.trunc((a - b)) & sizeMask(size)) >>> 0);
      subFlags(cpu, size, a, b, res, true);
      setD(cpu, dn, size, res);
    }
  }
  return true;
}

function execCmpEor(cpu, m, op) {
  const dn = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const opmode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  if (((opmode == 3) || (opmode == 7))) {
    const size = (() => {
    if ((opmode == 3)) {
      return 1;
    } else {
      return 2;
    }
    })();
    const ea = resolveEa(cpu, m, mode, reg, size);
    const src = signExtend(eaLoad(cpu, m, ea, size), size);
    const a = cpu.a[dn];
    const res = ((Math.trunc((a - src)) & 4294967295) >>> 0);
    subFlags(cpu, 2, a, src, res, false);
    return true;
  }
  const size = ((opmode & 3) >>> 0);
  if ((((opmode & 4) >>> 0) == 0)) {
    const ea = resolveEa(cpu, m, mode, reg, size);
    const b = eaLoad(cpu, m, ea, size);
    const a = getD(cpu, dn, size);
    const res = ((Math.trunc((a - b)) & sizeMask(size)) >>> 0);
    subFlags(cpu, size, a, b, res, false);
    return true;
  }
  if ((mode == 1)) {
    const ea1 = resolveEa(cpu, m, 3, reg, size);
    const ea2 = resolveEa(cpu, m, 3, dn, size);
    const s = eaLoad(cpu, m, ea1, size);
    const d = eaLoad(cpu, m, ea2, size);
    const res = ((Math.trunc((d - s)) & sizeMask(size)) >>> 0);
    subFlags(cpu, size, d, s, res, false);
    return true;
  }
  const ea = resolveEa(cpu, m, mode, reg, size);
  const a = eaLoad(cpu, m, ea, size);
  const res = ((((a ^ getD(cpu, dn, size)) >>> 0) & sizeMask(size)) >>> 0);
  eaStore(cpu, m, ea, size, res);
  setLogicalFlags(cpu, size, res);
  return true;
}

function execAnd(cpu, m, op) {
  const dn = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const opmode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  const size = ((opmode & 3) >>> 0);
  if ((((mode == 0) || (mode == 1)) && (((opmode == 4) || (opmode == 5)) || (opmode == 6)))) {
    if ((opmode == 4)) {
      execBcdRM(cpu, m, op, false);
    } else {
      execExg(cpu, op, opmode, mode);
    }
    return true;
  }
  if ((size == 3)) {
    const ea = resolveEa(cpu, m, mode, reg, 1);
    const src = ((eaLoad(cpu, m, ea, 1) & 65535) >>> 0);
    let res = 0;
    if ((((opmode & 4) >>> 0) == 0)) {
      res = Math.trunc((((getD(cpu, dn, 1) & 65535) >>> 0) * src));
    } else {
      res = ((Math.trunc((signExtend(getD(cpu, dn, 1), 1) * signExtend(src, 1))) & 4294967295) >>> 0);
    }
    setD(cpu, dn, 2, ((res & 4294967295) >>> 0));
    setLogicalFlags(cpu, 2, res);
    return true;
  }
  const ea = resolveEa(cpu, m, mode, reg, size);
  if ((((opmode & 4) >>> 0) == 0)) {
    const res = ((((getD(cpu, dn, size) & eaLoad(cpu, m, ea, size)) >>> 0) & sizeMask(size)) >>> 0);
    setD(cpu, dn, size, res);
    setLogicalFlags(cpu, size, res);
  } else {
    const res = ((((eaLoad(cpu, m, ea, size) & getD(cpu, dn, size)) >>> 0) & sizeMask(size)) >>> 0);
    eaStore(cpu, m, ea, size, res);
    setLogicalFlags(cpu, size, res);
  }
  return true;
}

function execOr(cpu, m, op) {
  const dn = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
  const opmode = ((Math.floor(op / 2 ** (6)) & 7) >>> 0);
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  const size = ((opmode & 3) >>> 0);
  if ((((mode == 0) || (mode == 1)) && (opmode == 4))) {
    execBcdRM(cpu, m, op, true);
    return true;
  }
  if ((size == 3)) {
    const signed = (((opmode & 4) >>> 0) != 0);
    const ea = resolveEa(cpu, m, mode, reg, 1);
    const divisorRaw = ((eaLoad(cpu, m, ea, 1) & 65535) >>> 0);
    if (cpu.fault) {
      return true;
    }
    if ((divisorRaw == 0)) {
      raiseException(cpu, m, 5);
      return true;
    }
    const dividend = ((cpu.d[dn] & 4294967295) >>> 0);
    if (signed) {
      const dv = signExtend(dividend, 2);
      const ds = signExtend(divisorRaw, 1);
      const q = quotTrunc(dv, ds);
      const r = Math.trunc((dv - Math.trunc((q * ds))));
      if (((q > 32767) || (q < (-32768)))) {
        setBit(cpu, SR_V, true);
        setBit(cpu, SR_C, false);
        return true;
      }
      const packed = ((((((r & 65535) >>> 0) << 16) >>> 0) | ((q & 65535) >>> 0)) >>> 0);
      cpu.d[dn] = ((packed & 4294967295) >>> 0);
      setBit(cpu, SR_N, (((q & 32768) >>> 0) != 0));
      setBit(cpu, SR_Z, (((q & 65535) >>> 0) == 0));
      setBit(cpu, SR_V, false);
      setBit(cpu, SR_C, false);
    } else {
      const q = Math.trunc(Math.trunc(dividend / divisorRaw));
      const r = (dividend % divisorRaw);
      if ((q > 65535)) {
        setBit(cpu, SR_V, true);
        setBit(cpu, SR_C, false);
        return true;
      }
      const packed = ((((((r & 65535) >>> 0) << 16) >>> 0) | ((q & 65535) >>> 0)) >>> 0);
      cpu.d[dn] = ((packed & 4294967295) >>> 0);
      setBit(cpu, SR_N, (((q & 32768) >>> 0) != 0));
      setBit(cpu, SR_Z, (((q & 65535) >>> 0) == 0));
      setBit(cpu, SR_V, false);
      setBit(cpu, SR_C, false);
    }
    return true;
  }
  const ea = resolveEa(cpu, m, mode, reg, size);
  if ((((opmode & 4) >>> 0) == 0)) {
    const res = ((((getD(cpu, dn, size) | eaLoad(cpu, m, ea, size)) >>> 0) & sizeMask(size)) >>> 0);
    setD(cpu, dn, size, res);
    setLogicalFlags(cpu, size, res);
  } else {
    const res = ((((eaLoad(cpu, m, ea, size) | getD(cpu, dn, size)) >>> 0) & sizeMask(size)) >>> 0);
    eaStore(cpu, m, ea, size, res);
    setLogicalFlags(cpu, size, res);
  }
  return true;
}

function quotTrunc(a, b) {
  return Math.trunc(Math.trunc(a / b));
}

function execMovem(cpu, m, op) {
  const toReg = (((op & 1024) >>> 0) != 0);
  const long = (((op & 64) >>> 0) != 0);
  const sz = (() => {
  if (long) {
    return 2;
  } else {
    return 1;
  }
  })();
  const bytes = (() => {
  if (long) {
    return 4;
  } else {
    return 2;
  }
  })();
  const mask = fetch16(cpu, m);
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  if (((!toReg) && (mode == 4))) {
    if ((((cpu.a[reg] & 1) >>> 0) != 0)) {
      checkAlign(cpu, ((Math.trunc((cpu.a[reg] - bytes)) & 4294967295) >>> 0), sz, false, false);
      return true;
    }
    let addr = ((cpu.a[reg] & 4294967295) >>> 0);
    let i = 0;
    while ((i < 16)) {
      if ((((Math.floor(mask / 2 ** (i)) & 1) >>> 0) != 0)) {
        addr = ((Math.trunc((addr - bytes)) & 4294967295) >>> 0);
        let val = 0;
        if ((i < 8)) {
          val = cpu.a[Math.trunc((7 - i))];
        } else {
          val = cpu.d[Math.trunc((15 - i))];
        }
        if (long) {
          memWrite32(m, addr, val);
        } else {
          memWrite16(m, addr, ((val & 65535) >>> 0));
        }
      }
      i = Math.trunc((i + 1));
    }
    cpu.a[reg] = addr;
    return true;
  }
  let addr = 0;
  if ((toReg && (mode == 3))) {
    addr = ((cpu.a[reg] & 4294967295) >>> 0);
  } else {
    const ea = resolveEa(cpu, m, mode, reg, sz);
    const _t3 = ea;
    if (_t3.tag === 2) {
      const a = _t3.data[0];
      addr = a;
    } else { // wildcard
      return false;
    }
  }
  if ((((addr & 1) >>> 0) != 0)) {
    checkAlign(cpu, addr, sz, toReg, false);
    return true;
  }
  let i = 0;
  while ((i < 16)) {
    if ((((Math.floor(mask / 2 ** (i)) & 1) >>> 0) != 0)) {
      if (toReg) {
        let v = 0;
        if (long) {
          v = memRead32(m, addr);
        } else {
          v = ((signExtend(memRead16(m, addr), 1) & 4294967295) >>> 0);
        }
        if ((i < 8)) {
          cpu.d[i] = ((v & 4294967295) >>> 0);
        } else {
          cpu.a[Math.trunc((i - 8))] = ((v & 4294967295) >>> 0);
        }
      } else {
        let val = 0;
        if ((i < 8)) {
          val = cpu.d[i];
        } else {
          val = cpu.a[Math.trunc((i - 8))];
        }
        if (long) {
          memWrite32(m, addr, val);
        } else {
          memWrite16(m, addr, ((val & 65535) >>> 0));
        }
      }
      addr = ((Math.trunc((addr + bytes)) & 4294967295) >>> 0);
    }
    i = Math.trunc((i + 1));
  }
  if ((toReg && (mode == 3))) {
    cpu.a[reg] = ((addr & 4294967295) >>> 0);
  }
  return true;
}

function execMisc(cpu, m, op) {
  if ((op == 20081)) {
    return true;
  }
  if ((op == 20080)) {
    return true;
  }
  if ((op == 20083)) {
    if (privViolation(cpu, m)) {
      return true;
    }
    const newSr = ((popWord(cpu, m) & 42783) >>> 0);
    const pc = popLong(cpu, m);
    setSr(cpu, newSr);
    setPc(cpu, pc);
    return true;
  }
  if ((op == 20085)) {
    setPc(cpu, popLong(cpu, m));
    return true;
  }
  if ((op == 20087)) {
    const ccr = popWord(cpu, m);
    cpu.sr = ((((cpu.sr & 65280) >>> 0) | ((ccr & 31) >>> 0)) >>> 0);
    setPc(cpu, popLong(cpu, m));
    return true;
  }
  if ((op == 20086)) {
    if (getBit(cpu, SR_V)) {
      raiseException(cpu, m, 7);
    }
    return true;
  }
  if ((op == 20082)) {
    const imm = ((fetch16(cpu, m) & 42783) >>> 0);
    setSr(cpu, imm);
    cpu.halted = true;
    return true;
  }
  if ((((op & 65520) >>> 0) == 20032)) {
    raiseException(cpu, m, Math.trunc((32 + ((op & 15) >>> 0))));
    return true;
  }
  const mode = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const reg = ((op & 7) >>> 0);
  if ((((op & 65528) >>> 0) == 20048)) {
    const disp = signExtend(fetch16(cpu, m), 1);
    pushLong(cpu, m, cpu.a[reg]);
    cpu.a[reg] = cpu.a[7];
    cpu.a[7] = ((Math.trunc((cpu.a[7] + disp)) & 4294967295) >>> 0);
    return true;
  }
  if ((((op & 65528) >>> 0) == 20056)) {
    cpu.a[7] = cpu.a[reg];
    cpu.a[reg] = popLong(cpu, m);
    return true;
  }
  if ((((op & 65520) >>> 0) == 20064)) {
    if ((((op & 8) >>> 0) == 0)) {
      cpu.otherSp = ((cpu.a[reg] & 4294967295) >>> 0);
    } else {
      cpu.a[reg] = ((cpu.otherSp & 4294967295) >>> 0);
    }
    return true;
  }
  if ((((op & 65472) >>> 0) == 16576)) {
    const ea = resolveEa(cpu, m, mode, reg, 1);
    eaStore(cpu, m, ea, 1, ((cpu.sr & 65535) >>> 0));
    return true;
  }
  if ((((op & 65472) >>> 0) == 17600)) {
    const ea = resolveEa(cpu, m, mode, reg, 1);
    const v = eaLoad(cpu, m, ea, 1);
    cpu.sr = ((((cpu.sr & 65280) >>> 0) | ((v & 31) >>> 0)) >>> 0);
    return true;
  }
  if ((((op & 65472) >>> 0) == 18112)) {
    if (privViolation(cpu, m)) {
      return true;
    }
    const ea = resolveEa(cpu, m, mode, reg, 1);
    const v = eaLoad(cpu, m, ea, 1);
    setSr(cpu, ((v & 42783) >>> 0));
    return true;
  }
  if ((((op & 65472) >>> 0) == 19136)) {
    const ea = resolveEa(cpu, m, mode, reg, 0);
    const v = eaLoad(cpu, m, ea, 0);
    setNZ(cpu, 0, v);
    setBit(cpu, SR_V, false);
    setBit(cpu, SR_C, false);
    eaStore(cpu, m, ea, 0, ((v | 128) >>> 0));
    return true;
  }
  if ((((op & 61888) >>> 0) == 16832)) {
    const an = ((Math.floor(op / 2 ** (9)) & 7) >>> 0);
    const ea = resolveEa(cpu, m, mode, reg, 2);
    const _t4 = ea;
    if (_t4.tag === 2) {
      const addr = _t4.data[0];
      cpu.a[an] = ((addr & 4294967295) >>> 0);
      return true;
    } else { // wildcard
      return false;
    }
  }
  if ((((op & 65472) >>> 0) == 18432)) {
    const ea = resolveEa(cpu, m, mode, reg, 0);
    const dst = ((eaLoad(cpu, m, ea, 0) & 255) >>> 0);
    const res = bcdSub(cpu, dst, 0);
    eaStore(cpu, m, ea, 0, res);
    return true;
  }
  if ((((op & 65528) >>> 0) == 18496)) {
    const v = ((cpu.d[reg] & 4294967295) >>> 0);
    const sw = ((((Math.floor(v / 2 ** (16)) & 65535) >>> 0) | ((((v << 16) >>> 0) & 4294901760) >>> 0)) >>> 0);
    cpu.d[reg] = sw;
    setLogicalFlags(cpu, 2, sw);
    return true;
  }
  if ((((op & 65472) >>> 0) == 18496)) {
    const ea = resolveEa(cpu, m, mode, reg, 2);
    const _t5 = ea;
    if (_t5.tag === 2) {
      const addr = _t5.data[0];
      pushLong(cpu, m, ((addr & 4294967295) >>> 0));
      return true;
    } else { // wildcard
      return false;
    }
  }
  if ((((op & 65464) >>> 0) == 18560)) {
    const longMode = (((op & 64) >>> 0) != 0);
    if (longMode) {
      const v = ((signExtend(cpu.d[reg], 1) & 4294967295) >>> 0);
      cpu.d[reg] = v;
      setLogicalFlags(cpu, 2, v);
    } else {
      const v = ((signExtend(cpu.d[reg], 0) & 65535) >>> 0);
      setD(cpu, reg, 1, v);
      setLogicalFlags(cpu, 1, v);
    }
    return true;
  }
  if ((((op & 64384) >>> 0) == 18560)) {
    return execMovem(cpu, m, op);
  }
  const sub = ((Math.floor(op / 2 ** (8)) & 15) >>> 0);
  const size = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  if (((sub == 2) && (size != 3))) {
    const ea = resolveEa(cpu, m, mode, reg, size);
    eaStore(cpu, m, ea, size, 0);
    setLogicalFlags(cpu, size, 0);
    return true;
  }
  if (((sub == 6) && (size != 3))) {
    const ea = resolveEa(cpu, m, mode, reg, size);
    const res = (((~eaLoad(cpu, m, ea, size)) & sizeMask(size)) >>> 0);
    eaStore(cpu, m, ea, size, res);
    setLogicalFlags(cpu, size, res);
    return true;
  }
  if (((sub == 4) && (size != 3))) {
    const ea = resolveEa(cpu, m, mode, reg, size);
    const v = eaLoad(cpu, m, ea, size);
    const res = ((Math.trunc((0 - v)) & sizeMask(size)) >>> 0);
    subFlags(cpu, size, 0, v, res, true);
    eaStore(cpu, m, ea, size, res);
    return true;
  }
  if (((sub == 10) && (size != 3))) {
    const ea = resolveEa(cpu, m, mode, reg, size);
    const v = eaLoad(cpu, m, ea, size);
    setLogicalFlags(cpu, size, v);
    return true;
  }
  if (((((op & 65472) >>> 0) == 20160) || (((op & 65472) >>> 0) == 20096))) {
    const isJsr = (((op & 64) >>> 0) == 0);
    const ea = resolveEa(cpu, m, mode, reg, 2);
    const _t6 = ea;
    if (_t6.tag === 2) {
      const addr = _t6.data[0];
      if (isJsr) {
        pushLong(cpu, m, cpu.pc);
      }
      setPc(cpu, addr);
      return true;
    } else { // wildcard
      return false;
    }
  }
  return false;
}

function newZ80() {
  let mem = [];
  let i = 0;
  while ((i < 65536)) {
    mem.push(0);
    i = Math.trunc((i + 1));
  }
  return new Z80(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false, 0, 0, false, mem, false, 0, 0, 0, Array.from({length: 512}, () => __clone(0)), 0, Array.from({length: 8}, () => __clone(0)), [false, false, false, false, false, false], [], Array.from({length: 4096}, () => __clone(0)), 0, 0, 0, 0, false, 0, false);
}

function ymTimerTick(cpu, us) {
  if (cpu.timerARun) {
    cpu.timerACnt = Math.trunc((cpu.timerACnt + us));
    const na = ((((((cpu.ym[36] & 255) >>> 0) << 2) >>> 0) | ((cpu.ym[37] & 3) >>> 0)) >>> 0);
    const periodA = Math.trunc((18 * Math.trunc((1024 - na))));
    if (((periodA > 0) && (cpu.timerACnt >= periodA))) {
      cpu.timerACnt = Math.trunc((cpu.timerACnt - periodA));
      if ((((cpu.ym[39] & 4) >>> 0) != 0)) {
        cpu.ymStatus = ((cpu.ymStatus | 1) >>> 0);
      }
    }
  }
  if (cpu.timerBRun) {
    cpu.timerBCnt = Math.trunc((cpu.timerBCnt + us));
    const nb = ((cpu.ym[38] & 255) >>> 0);
    const periodB = Math.trunc((288 * Math.trunc((256 - nb))));
    if (((periodB > 0) && (cpu.timerBCnt >= periodB))) {
      cpu.timerBCnt = Math.trunc((cpu.timerBCnt - periodB));
      if ((((cpu.ym[39] & 8) >>> 0) != 0)) {
        cpu.ymStatus = ((cpu.ymStatus | 2) >>> 0);
      }
    }
  }
}

function rd(cpu, addr) {
  const a = ((addr & 65535) >>> 0);
  if (cpu.gen) {
    if ((a < 16384)) {
      return Math.trunc(cpu.mem[((a & 8191) >>> 0)]);
    }
    if ((a >= 32768)) {
      const src = ((((((cpu.bank << 15) >>> 0) | ((a & 32767) >>> 0)) >>> 0) & 16777215) >>> 0);
      if ((src < cpu.rom.length)) {
        return Math.trunc(cpu.rom[src]);
      }
      return 0;
    }
    if (((a >= 16384) && (a <= 16387))) {
      return cpu.ymStatus;
    }
    return 0;
  }
  return Math.trunc(cpu.mem[a]);
}

function wr(cpu, addr, val) {
  const a = ((addr & 65535) >>> 0);
  if (cpu.gen) {
    z80DevWrite(cpu, a, ((val & 255) >>> 0));
    return;
  }
  cpu.mem[a] = (((val & 255) >>> 0) & 0xFF);
}

function z80DevWrite(cpu, a, val) {
  if ((a < 16384)) {
    cpu.mem[((a & 8191) >>> 0)] = (val & 0xFF);
    return;
  }
  if ((a == 16384)) {
    cpu.ymAddr0 = val;
    return;
  }
  if ((a == 16385)) {
    const reg = ((cpu.ymAddr0 & 255) >>> 0);
    cpu.ym[reg] = val;
    if ((reg == 42)) {
      cpu.dac[((cpu.dacW & 4095) >>> 0)] = val;
      cpu.dacW = Math.trunc((cpu.dacW + 1));
    }
    if ((reg == 39)) {
      cpu.timerARun = (((val & 1) >>> 0) != 0);
      cpu.timerBRun = (((val & 2) >>> 0) != 0);
      if ((((val & 16) >>> 0) != 0)) {
        cpu.ymStatus = ((cpu.ymStatus & (~1)) >>> 0);
      }
      if ((((val & 32) >>> 0) != 0)) {
        cpu.ymStatus = ((cpu.ymStatus & (~2)) >>> 0);
      }
    }
    if ((reg == 40)) {
      const sel = ((val & 7) >>> 0);
      let ch = sel;
      if ((sel >= 4)) {
        ch = Math.trunc((sel - 1));
      }
      if ((ch < 6)) {
        cpu.fmKey[ch] = (((val & 240) >>> 0) != 0);
      }
    }
    return;
  }
  if ((a == 16386)) {
    cpu.ymAddr1 = val;
    return;
  }
  if ((a == 16387)) {
    cpu.ym[Math.trunc((256 + ((cpu.ymAddr1 & 255) >>> 0)))] = val;
    return;
  }
  if ((a == 24576)) {
    cpu.bank = ((((Math.floor(cpu.bank / 2 ** (1)) | ((((val & 1) >>> 0) << 8) >>> 0)) >>> 0) & 511) >>> 0);
    return;
  }
  if ((a == 32529)) {
    psgWrite(cpu, val);
    return;
  }
}

function psgWrite(cpu, val) {
  if ((((val & 128) >>> 0) != 0)) {
    const reg = ((Math.floor(val / 2 ** (4)) & 7) >>> 0);
    cpu.psgLatch = reg;
    cpu.psg[reg] = ((((cpu.psg[reg] & 1008) >>> 0) | ((val & 15) >>> 0)) >>> 0);
  } else {
    const reg = cpu.psgLatch;
    if ((((reg & 1) >>> 0) == 0)) {
      cpu.psg[reg] = ((((cpu.psg[reg] & 15) >>> 0) | ((((val & 63) >>> 0) << 4) >>> 0)) >>> 0);
    } else {
      cpu.psg[reg] = ((val & 15) >>> 0);
    }
  }
}

function fetchOp(cpu) {
  const op = rd(cpu, cpu.pc);
  cpu.pc = ((Math.trunc((cpu.pc + 1)) & 65535) >>> 0);
  cpu.r = ((((cpu.r & 128) >>> 0) | ((Math.trunc((cpu.r + 1)) & 127) >>> 0)) >>> 0);
  return op;
}

function zfetch8(cpu) {
  const v = rd(cpu, cpu.pc);
  cpu.pc = ((Math.trunc((cpu.pc + 1)) & 65535) >>> 0);
  return v;
}

function zfetch16(cpu) {
  const lo = zfetch8(cpu);
  const hi = zfetch8(cpu);
  return ((((hi << 8) >>> 0) | lo) >>> 0);
}

function getHL(cpu) {
  return ((((cpu.h << 8) >>> 0) | cpu.l) >>> 0);
}

function setHL(cpu, v) {
  cpu.h = ((Math.floor(v / 2 ** (8)) & 255) >>> 0);
  cpu.l = ((v & 255) >>> 0);
}

function getBC(cpu) {
  return ((((cpu.b << 8) >>> 0) | cpu.c) >>> 0);
}

function getDE(cpu) {
  return ((((cpu.d << 8) >>> 0) | cpu.e) >>> 0);
}

function setFlag(cpu, bit, on) {
  if (on) {
    cpu.f = ((cpu.f | bit) >>> 0);
  } else {
    cpu.f = ((cpu.f & (~bit)) >>> 0);
  }
}

function parityEven(v) {
  let x = ((v & 255) >>> 0);
  let count = 0;
  let i = 0;
  while ((i < 8)) {
    if ((((x & 1) >>> 0) != 0)) {
      count = Math.trunc((count + 1));
    }
    x = Math.floor(x / 2 ** (1));
    i = Math.trunc((i + 1));
  }
  return (((count & 1) >>> 0) == 0);
}

function setSZYX(cpu, r) {
  const v = ((r & 255) >>> 0);
  setFlag(cpu, FS, (((v & 128) >>> 0) != 0));
  setFlag(cpu, FZ, (v == 0));
  setFlag(cpu, FY, (((v & 32) >>> 0) != 0));
  setFlag(cpu, FX, (((v & 8) >>> 0) != 0));
}

function getReg(cpu, idx) {
  if ((idx == 0)) {
    return cpu.b;
  }
  if ((idx == 1)) {
    return cpu.c;
  }
  if ((idx == 2)) {
    return cpu.d;
  }
  if ((idx == 3)) {
    return cpu.e;
  }
  if ((idx == 4)) {
    return cpu.h;
  }
  if ((idx == 5)) {
    return cpu.l;
  }
  if ((idx == 6)) {
    return rd(cpu, getHL(cpu));
  }
  return cpu.a;
}

function setReg(cpu, idx, val) {
  const v = ((val & 255) >>> 0);
  if ((idx == 0)) {
    cpu.b = v;
  } else {
    if ((idx == 1)) {
      cpu.c = v;
    } else {
      if ((idx == 2)) {
        cpu.d = v;
      } else {
        if ((idx == 3)) {
          cpu.e = v;
        } else {
          if ((idx == 4)) {
            cpu.h = v;
          } else {
            if ((idx == 5)) {
              cpu.l = v;
            } else {
              if ((idx == 6)) {
                wr(cpu, getHL(cpu), v);
              } else {
                cpu.a = v;
              }
            }
          }
        }
      }
    }
  }
}

function aluAdd(cpu, val, carry) {
  const a = cpu.a;
  const r = Math.trunc((Math.trunc((a + val)) + carry));
  const res = ((r & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, (Math.trunc((Math.trunc((((a & 15) >>> 0) + ((val & 15) >>> 0))) + carry)) > 15));
  setFlag(cpu, FPV, (((((((a ^ (~val)) >>> 0) & ((a ^ res) >>> 0)) >>> 0) & 128) >>> 0) != 0));
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, (r > 255));
  cpu.a = res;
}

function aluSub(cpu, val, carry, store) {
  const a = cpu.a;
  const r = Math.trunc((Math.trunc((a - val)) - carry));
  const res = ((r & 255) >>> 0);
  setFlag(cpu, FS, (((res & 128) >>> 0) != 0));
  setFlag(cpu, FZ, (res == 0));
  setFlag(cpu, FH, (Math.trunc((Math.trunc((((a & 15) >>> 0) - ((val & 15) >>> 0))) - carry)) < 0));
  setFlag(cpu, FPV, (((((((a ^ val) >>> 0) & ((a ^ res) >>> 0)) >>> 0) & 128) >>> 0) != 0));
  setFlag(cpu, FN, true);
  setFlag(cpu, FC, (r < 0));
  if (store) {
    setFlag(cpu, FY, (((res & 32) >>> 0) != 0));
    setFlag(cpu, FX, (((res & 8) >>> 0) != 0));
    cpu.a = res;
  } else {
    setFlag(cpu, FY, (((val & 32) >>> 0) != 0));
    setFlag(cpu, FX, (((val & 8) >>> 0) != 0));
  }
}

function aluAnd(cpu, val) {
  const res = ((((cpu.a & val) >>> 0) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, true);
  setFlag(cpu, FPV, parityEven(res));
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, false);
  cpu.a = res;
}

function aluXor(cpu, val) {
  const res = ((((cpu.a ^ val) >>> 0) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, false);
  setFlag(cpu, FPV, parityEven(res));
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, false);
  cpu.a = res;
}

function aluOr(cpu, val) {
  const res = ((((cpu.a | val) >>> 0) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, false);
  setFlag(cpu, FPV, parityEven(res));
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, false);
  cpu.a = res;
}

function doAlu(cpu, op, val) {
  const cf = ((cpu.f & FC) >>> 0);
  if ((op == 0)) {
    aluAdd(cpu, val, 0);
  } else {
    if ((op == 1)) {
      aluAdd(cpu, val, cf);
    } else {
      if ((op == 2)) {
        aluSub(cpu, val, 0, true);
      } else {
        if ((op == 3)) {
          aluSub(cpu, val, cf, true);
        } else {
          if ((op == 4)) {
            aluAnd(cpu, val);
          } else {
            if ((op == 5)) {
              aluXor(cpu, val);
            } else {
              if ((op == 6)) {
                aluOr(cpu, val);
              } else {
                aluSub(cpu, val, 0, false);
              }
            }
          }
        }
      }
    }
  }
}

function incReg(cpu, idx) {
  const v = getReg(cpu, idx);
  const res = ((Math.trunc((v + 1)) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, (((v & 15) >>> 0) == 15));
  setFlag(cpu, FPV, (v == 127));
  setFlag(cpu, FN, false);
  setReg(cpu, idx, res);
}

function decReg(cpu, idx) {
  const v = getReg(cpu, idx);
  const res = ((Math.trunc((v - 1)) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, (((v & 15) >>> 0) == 0));
  setFlag(cpu, FPV, (v == 128));
  setFlag(cpu, FN, true);
  setReg(cpu, idx, res);
}

function getAF(cpu) {
  return ((((cpu.a << 8) >>> 0) | cpu.f) >>> 0);
}

function setAF(cpu, v) {
  cpu.a = ((Math.floor(v / 2 ** (8)) & 255) >>> 0);
  cpu.f = ((v & 255) >>> 0);
}

function setBC(cpu, v) {
  cpu.b = ((Math.floor(v / 2 ** (8)) & 255) >>> 0);
  cpu.c = ((v & 255) >>> 0);
}

function setDE(cpu, v) {
  cpu.d = ((Math.floor(v / 2 ** (8)) & 255) >>> 0);
  cpu.e = ((v & 255) >>> 0);
}

function getRP(cpu, p) {
  if ((p == 0)) {
    return getBC(cpu);
  }
  if ((p == 1)) {
    return getDE(cpu);
  }
  if ((p == 2)) {
    return getHL(cpu);
  }
  return cpu.sp;
}

function setRP(cpu, p, v) {
  if ((p == 0)) {
    setBC(cpu, v);
  } else {
    if ((p == 1)) {
      setDE(cpu, v);
    } else {
      if ((p == 2)) {
        setHL(cpu, v);
      } else {
        cpu.sp = ((v & 65535) >>> 0);
      }
    }
  }
}

function getRP2(cpu, p) {
  if ((p == 3)) {
    return getAF(cpu);
  }
  return getRP(cpu, p);
}

function setRP2(cpu, p, v) {
  if ((p == 3)) {
    setAF(cpu, v);
  } else {
    setRP(cpu, p, v);
  }
}

function z80Interrupt(cpu) {
  if ((!cpu.iff1)) {
    return false;
  }
  cpu.iff1 = false;
  cpu.iff2 = false;
  cpu.halted = false;
  push16(cpu, cpu.pc);
  if ((cpu.im == 2)) {
    const vec = ((((((cpu.i << 8) >>> 0) | 255) >>> 0) & 65535) >>> 0);
    cpu.pc = ((rd(cpu, vec) | ((rd(cpu, ((Math.trunc((vec + 1)) & 65535) >>> 0)) << 8) >>> 0)) >>> 0);
  } else {
    cpu.pc = 56;
  }
  return true;
}

function push16(cpu, v) {
  cpu.sp = ((Math.trunc((cpu.sp - 1)) & 65535) >>> 0);
  wr(cpu, cpu.sp, ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
  cpu.sp = ((Math.trunc((cpu.sp - 1)) & 65535) >>> 0);
  wr(cpu, cpu.sp, ((v & 255) >>> 0));
}

function pop16(cpu) {
  const lo = rd(cpu, cpu.sp);
  cpu.sp = ((Math.trunc((cpu.sp + 1)) & 65535) >>> 0);
  const hi = rd(cpu, cpu.sp);
  cpu.sp = ((Math.trunc((cpu.sp + 1)) & 65535) >>> 0);
  return ((((hi << 8) >>> 0) | lo) >>> 0);
}

function testCC(cpu, y) {
  if ((y == 0)) {
    return (((cpu.f & FZ) >>> 0) == 0);
  }
  if ((y == 1)) {
    return (((cpu.f & FZ) >>> 0) != 0);
  }
  if ((y == 2)) {
    return (((cpu.f & FC) >>> 0) == 0);
  }
  if ((y == 3)) {
    return (((cpu.f & FC) >>> 0) != 0);
  }
  if ((y == 4)) {
    return (((cpu.f & FPV) >>> 0) == 0);
  }
  if ((y == 5)) {
    return (((cpu.f & FPV) >>> 0) != 0);
  }
  if ((y == 6)) {
    return (((cpu.f & FS) >>> 0) == 0);
  }
  return (((cpu.f & FS) >>> 0) != 0);
}

function add16(cpu, a, b) {
  const r = Math.trunc((a + b));
  const res = ((r & 65535) >>> 0);
  setFlag(cpu, FH, (Math.trunc((((a & 4095) >>> 0) + ((b & 4095) >>> 0))) > 4095));
  setFlag(cpu, FC, (r > 65535));
  setFlag(cpu, FN, false);
  setFlag(cpu, FY, (((res & 8192) >>> 0) != 0));
  setFlag(cpu, FX, (((res & 2048) >>> 0) != 0));
  return res;
}

function rotAcc(cpu, kind) {
  const a = cpu.a;
  let res = 0;
  let carry = false;
  if ((kind == 0)) {
    carry = (((a & 128) >>> 0) != 0);
    res = ((((((a << 1) >>> 0) | (() => {
    if (carry) {
      return 1;
    } else {
      return 0;
    }
    })()) >>> 0) & 255) >>> 0);
  } else {
    if ((kind == 1)) {
      carry = (((a & 1) >>> 0) != 0);
      res = ((((Math.floor(a / 2 ** (1)) | (() => {
      if (carry) {
        return 128;
      } else {
        return 0;
      }
      })()) >>> 0) & 255) >>> 0);
    } else {
      if ((kind == 2)) {
        const cin = (((cpu.f & FC) >>> 0) != 0);
        carry = (((a & 128) >>> 0) != 0);
        res = ((((((a << 1) >>> 0) | (() => {
        if (cin) {
          return 1;
        } else {
          return 0;
        }
        })()) >>> 0) & 255) >>> 0);
      } else {
        const cin = (((cpu.f & FC) >>> 0) != 0);
        carry = (((a & 1) >>> 0) != 0);
        res = ((((Math.floor(a / 2 ** (1)) | (() => {
        if (cin) {
          return 128;
        } else {
          return 0;
        }
        })()) >>> 0) & 255) >>> 0);
      }
    }
  }
  cpu.a = res;
  setFlag(cpu, FC, carry);
  setFlag(cpu, FH, false);
  setFlag(cpu, FN, false);
  setFlag(cpu, FY, (((res & 32) >>> 0) != 0));
  setFlag(cpu, FX, (((res & 8) >>> 0) != 0));
}

function doDaa(cpu) {
  let a = cpu.a;
  let adjust = 0;
  const n = (((cpu.f & FN) >>> 0) != 0);
  let carry = (((cpu.f & FC) >>> 0) != 0);
  if (((((cpu.f & FH) >>> 0) != 0) || (((a & 15) >>> 0) > 9))) {
    adjust = ((adjust | 6) >>> 0);
  }
  if ((carry || (a > 153))) {
    adjust = ((adjust | 96) >>> 0);
    carry = true;
  }
  if (n) {
    a = ((Math.trunc((a - adjust)) & 255) >>> 0);
  } else {
    a = ((Math.trunc((a + adjust)) & 255) >>> 0);
  }
  setFlag(cpu, FH, (((((cpu.a ^ a) >>> 0) & 16) >>> 0) != 0));
  cpu.a = a;
  setSZYX(cpu, a);
  setFlag(cpu, FPV, parityEven(a));
  setFlag(cpu, FC, carry);
}

function stepZ80(cpu) {
  ymTimerTick(cpu, 1);
  const op = fetchOp(cpu);
  const x = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const y = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const z = ((op & 7) >>> 0);
  const p = Math.floor(y / 2 ** (1));
  const q = ((y & 1) >>> 0);
  if ((op == 118)) {
    cpu.halted = true;
    return true;
  }
  if ((op == 203)) {
    return execCB(cpu);
  }
  if ((op == 237)) {
    return execED(cpu);
  }
  if ((op == 221)) {
    return execIndex(cpu, false);
  }
  if ((op == 253)) {
    return execIndex(cpu, true);
  }
  if ((x == 1)) {
    setReg(cpu, y, getReg(cpu, z));
    return true;
  }
  if ((x == 2)) {
    doAlu(cpu, y, getReg(cpu, z));
    return true;
  }
  if ((x == 0)) {
    return execX0(cpu, op, y, z, p, q);
  }
  return execX3(cpu, op, y, z, p, q);
}

function execX0(cpu, _op, y, z, p, q) {
  if ((z == 0)) {
    if ((y == 0)) {
      return true;
    }
    if ((y == 1)) {
      const t = getAF(cpu);
      setAF(cpu, cpu.af_);
      cpu.af_ = t;
      return true;
    }
    const d = signExt8(zfetch8(cpu));
    if ((y == 2)) {
      cpu.b = ((Math.trunc((cpu.b - 1)) & 255) >>> 0);
      if ((cpu.b != 0)) {
        cpu.pc = ((Math.trunc((cpu.pc + d)) & 65535) >>> 0);
      }
      return true;
    }
    if ((y == 3)) {
      cpu.pc = ((Math.trunc((cpu.pc + d)) & 65535) >>> 0);
      return true;
    }
    if (testCC(cpu, Math.trunc((y - 4)))) {
      cpu.pc = ((Math.trunc((cpu.pc + d)) & 65535) >>> 0);
    }
    return true;
  }
  if ((z == 1)) {
    if ((q == 0)) {
      setRP(cpu, p, zfetch16(cpu));
    } else {
      setHL(cpu, add16(cpu, getHL(cpu), getRP(cpu, p)));
    }
    return true;
  }
  if ((z == 2)) {
    return execIndirect(cpu, p, q);
  }
  if ((z == 3)) {
    if ((q == 0)) {
      setRP(cpu, p, ((Math.trunc((getRP(cpu, p) + 1)) & 65535) >>> 0));
    } else {
      setRP(cpu, p, ((Math.trunc((getRP(cpu, p) - 1)) & 65535) >>> 0));
    }
    return true;
  }
  if ((z == 4)) {
    incReg(cpu, y);
    return true;
  }
  if ((z == 5)) {
    decReg(cpu, y);
    return true;
  }
  if ((z == 6)) {
    setReg(cpu, y, zfetch8(cpu));
    return true;
  }
  if ((y < 4)) {
    rotAcc(cpu, y);
  } else {
    if ((y == 4)) {
      doDaa(cpu);
    } else {
      if ((y == 5)) {
        cpu.a = (((~cpu.a) & 255) >>> 0);
        setFlag(cpu, FH, true);
        setFlag(cpu, FN, true);
        setFlag(cpu, FY, (((cpu.a & 32) >>> 0) != 0));
        setFlag(cpu, FX, (((cpu.a & 8) >>> 0) != 0));
      } else {
        if ((y == 6)) {
          setFlag(cpu, FC, true);
          setFlag(cpu, FH, false);
          setFlag(cpu, FN, false);
          setFlag(cpu, FY, (((cpu.a & 32) >>> 0) != 0));
          setFlag(cpu, FX, (((cpu.a & 8) >>> 0) != 0));
        } else {
          const oldC = (((cpu.f & FC) >>> 0) != 0);
          setFlag(cpu, FH, oldC);
          setFlag(cpu, FC, (!oldC));
          setFlag(cpu, FN, false);
          setFlag(cpu, FY, (((cpu.a & 32) >>> 0) != 0));
          setFlag(cpu, FX, (((cpu.a & 8) >>> 0) != 0));
        }
      }
    }
  }
  return true;
}

function execIndirect(cpu, p, q) {
  if ((q == 0)) {
    if ((p == 0)) {
      wr(cpu, getBC(cpu), cpu.a);
    } else {
      if ((p == 1)) {
        wr(cpu, getDE(cpu), cpu.a);
      } else {
        if ((p == 2)) {
          const nn = zfetch16(cpu);
          wr(cpu, nn, cpu.l);
          wr(cpu, Math.trunc((nn + 1)), cpu.h);
        } else {
          wr(cpu, zfetch16(cpu), cpu.a);
        }
      }
    }
  } else {
    if ((p == 0)) {
      cpu.a = rd(cpu, getBC(cpu));
    } else {
      if ((p == 1)) {
        cpu.a = rd(cpu, getDE(cpu));
      } else {
        if ((p == 2)) {
          const nn = zfetch16(cpu);
          cpu.l = rd(cpu, nn);
          cpu.h = rd(cpu, Math.trunc((nn + 1)));
        } else {
          cpu.a = rd(cpu, zfetch16(cpu));
        }
      }
    }
  }
  return true;
}

function execX3(cpu, _op, y, z, p, q) {
  if ((z == 0)) {
    if (testCC(cpu, y)) {
      cpu.pc = pop16(cpu);
    }
    return true;
  }
  if ((z == 1)) {
    if ((q == 0)) {
      setRP2(cpu, p, pop16(cpu));
      return true;
    }
    if ((p == 0)) {
      cpu.pc = pop16(cpu);
    } else {
      if ((p == 1)) {
        const b = getBC(cpu);
        const d = getDE(cpu);
        const h = getHL(cpu);
        setBC(cpu, cpu.bc_);
        setDE(cpu, cpu.de_);
        setHL(cpu, cpu.hl_);
        cpu.bc_ = b;
        cpu.de_ = d;
        cpu.hl_ = h;
      } else {
        if ((p == 2)) {
          cpu.pc = getHL(cpu);
        } else {
          cpu.sp = getHL(cpu);
        }
      }
    }
    return true;
  }
  if ((z == 2)) {
    const nn = zfetch16(cpu);
    if (testCC(cpu, y)) {
      cpu.pc = nn;
    }
    return true;
  }
  if ((z == 3)) {
    if ((y == 0)) {
      cpu.pc = zfetch16(cpu);
      return true;
    }
    if ((y == 4)) {
      const lo = rd(cpu, cpu.sp);
      const hi = rd(cpu, Math.trunc((cpu.sp + 1)));
      wr(cpu, cpu.sp, cpu.l);
      wr(cpu, Math.trunc((cpu.sp + 1)), cpu.h);
      cpu.l = lo;
      cpu.h = hi;
      return true;
    }
    if ((y == 5)) {
      const d = getDE(cpu);
      setDE(cpu, getHL(cpu));
      setHL(cpu, d);
      return true;
    }
    if ((y == 6)) {
      cpu.iff1 = false;
      cpu.iff2 = false;
      return true;
    }
    if ((y == 7)) {
      cpu.iff1 = true;
      cpu.iff2 = true;
      return true;
    }
    return false;
  }
  if ((z == 4)) {
    const nn = zfetch16(cpu);
    if (testCC(cpu, y)) {
      push16(cpu, cpu.pc);
      cpu.pc = nn;
    }
    return true;
  }
  if ((z == 5)) {
    if ((q == 0)) {
      push16(cpu, getRP2(cpu, p));
      return true;
    }
    if ((p == 0)) {
      const nn = zfetch16(cpu);
      push16(cpu, cpu.pc);
      cpu.pc = nn;
      return true;
    }
    return false;
  }
  if ((z == 6)) {
    doAlu(cpu, y, zfetch8(cpu));
    return true;
  }
  push16(cpu, cpu.pc);
  cpu.pc = Math.trunc((y * 8));
  return true;
}

function signExt8(v) {
  if ((((v & 128) >>> 0) != 0)) {
    return Math.trunc((v - 256));
  }
  return v;
}

function incVal(cpu, v) {
  const res = ((Math.trunc((v + 1)) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, (((v & 15) >>> 0) == 15));
  setFlag(cpu, FPV, (v == 127));
  setFlag(cpu, FN, false);
  return res;
}

function decVal(cpu, v) {
  const res = ((Math.trunc((v - 1)) & 255) >>> 0);
  setSZYX(cpu, res);
  setFlag(cpu, FH, (((v & 15) >>> 0) == 0));
  setFlag(cpu, FPV, (v == 128));
  setFlag(cpu, FN, true);
  return res;
}

function execIndex(cpu, isIY) {
  let base = (() => {
  if (isIY) {
    return cpu.iy;
  } else {
    return cpu.ix;
  }
  })();
  const op = fetchOp(cpu);
  if ((op == 203)) {
    const d = signExt8(zfetch8(cpu));
    const addr = ((Math.trunc((base + d)) & 65535) >>> 0);
    return execDDCB(cpu, addr);
  }
  if (((((op == 9) || (op == 25)) || (op == 41)) || (op == 57))) {
    const p = ((Math.floor(op / 2 ** (4)) & 3) >>> 0);
    let rp = getRP(cpu, p);
    if ((p == 2)) {
      rp = base;
    }
    base = add16(cpu, base, rp);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 33)) {
    base = zfetch16(cpu);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 34)) {
    const nn = zfetch16(cpu);
    wr(cpu, nn, ((base & 255) >>> 0));
    wr(cpu, Math.trunc((nn + 1)), ((Math.floor(base / 2 ** (8)) & 255) >>> 0));
    return true;
  }
  if ((op == 42)) {
    const nn = zfetch16(cpu);
    base = ((rd(cpu, nn) | ((rd(cpu, Math.trunc((nn + 1))) << 8) >>> 0)) >>> 0);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 35)) {
    base = ((Math.trunc((base + 1)) & 65535) >>> 0);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 43)) {
    base = ((Math.trunc((base - 1)) & 65535) >>> 0);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 229)) {
    push16(cpu, base);
    return true;
  }
  if ((op == 225)) {
    base = pop16(cpu);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 227)) {
    const lo = rd(cpu, cpu.sp);
    const hi = rd(cpu, Math.trunc((cpu.sp + 1)));
    wr(cpu, cpu.sp, ((base & 255) >>> 0));
    wr(cpu, Math.trunc((cpu.sp + 1)), ((Math.floor(base / 2 ** (8)) & 255) >>> 0));
    base = ((((hi << 8) >>> 0) | lo) >>> 0);
    return storeIndex(cpu, isIY, base);
  }
  if ((op == 233)) {
    cpu.pc = base;
    return true;
  }
  if ((op == 249)) {
    cpu.sp = base;
    return true;
  }
  if ((op == 52)) {
    const d = signExt8(zfetch8(cpu));
    const a = ((Math.trunc((base + d)) & 65535) >>> 0);
    wr(cpu, a, incVal(cpu, rd(cpu, a)));
    return true;
  }
  if ((op == 53)) {
    const d = signExt8(zfetch8(cpu));
    const a = ((Math.trunc((base + d)) & 65535) >>> 0);
    wr(cpu, a, decVal(cpu, rd(cpu, a)));
    return true;
  }
  if ((op == 54)) {
    const d = signExt8(zfetch8(cpu));
    const n = zfetch8(cpu);
    wr(cpu, ((Math.trunc((base + d)) & 65535) >>> 0), n);
    return true;
  }
  const x = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const y = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const z = ((op & 7) >>> 0);
  if ((((x == 1) && (op != 118)) && ((y == 6) || (z == 6)))) {
    const d = signExt8(zfetch8(cpu));
    const a = ((Math.trunc((base + d)) & 65535) >>> 0);
    if ((z == 6)) {
      setReg(cpu, y, rd(cpu, a));
    } else {
      wr(cpu, a, getReg(cpu, z));
    }
    return true;
  }
  if (((x == 2) && (z == 6))) {
    const d = signExt8(zfetch8(cpu));
    doAlu(cpu, y, rd(cpu, ((Math.trunc((base + d)) & 65535) >>> 0)));
    return true;
  }
  return false;
}

function storeIndex(cpu, isIY, v) {
  if (isIY) {
    cpu.iy = ((v & 65535) >>> 0);
  } else {
    cpu.ix = ((v & 65535) >>> 0);
  }
  return true;
}

function execDDCB(cpu, addr) {
  const op = zfetch8(cpu);
  const x = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const y = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const z = ((op & 7) >>> 0);
  const v = rd(cpu, addr);
  if ((x == 1)) {
    const bitset = (((Math.floor(v / 2 ** (y)) & 1) >>> 0) != 0);
    setFlag(cpu, FZ, (!bitset));
    setFlag(cpu, FPV, (!bitset));
    setFlag(cpu, FH, true);
    setFlag(cpu, FN, false);
    setFlag(cpu, FS, ((y == 7) && bitset));
    setFlag(cpu, FY, (((Math.floor(addr / 2 ** (8)) & 32) >>> 0) != 0));
    setFlag(cpu, FX, (((Math.floor(addr / 2 ** (8)) & 8) >>> 0) != 0));
    return true;
  }
  let res = 0;
  if ((x == 0)) {
    res = shiftOp(cpu, y, v);
  } else {
    if ((x == 2)) {
      res = ((v & (~((1 << y) >>> 0))) >>> 0);
    } else {
      res = ((v | ((1 << y) >>> 0)) >>> 0);
    }
  }
  wr(cpu, addr, res);
  if ((z != 6)) {
    setReg(cpu, z, res);
  }
  return true;
}

function execCB(cpu) {
  const op = fetchOp(cpu);
  const x = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const y = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const z = ((op & 7) >>> 0);
  if ((x == 0)) {
    const v = getReg(cpu, z);
    const res = shiftOp(cpu, y, v);
    setReg(cpu, z, res);
    return true;
  }
  if ((x == 1)) {
    const v = getReg(cpu, z);
    const bitset = (((Math.floor(v / 2 ** (y)) & 1) >>> 0) != 0);
    setFlag(cpu, FZ, (!bitset));
    setFlag(cpu, FPV, (!bitset));
    setFlag(cpu, FH, true);
    setFlag(cpu, FN, false);
    setFlag(cpu, FS, ((y == 7) && bitset));
    if ((z == 6)) {
      setFlag(cpu, FY, (((Math.floor(cpu.wz / 2 ** (8)) & 32) >>> 0) != 0));
      setFlag(cpu, FX, (((Math.floor(cpu.wz / 2 ** (8)) & 8) >>> 0) != 0));
    } else {
      setFlag(cpu, FY, (((v & 32) >>> 0) != 0));
      setFlag(cpu, FX, (((v & 8) >>> 0) != 0));
    }
    return true;
  }
  if ((x == 2)) {
    setReg(cpu, z, ((getReg(cpu, z) & (~((1 << y) >>> 0))) >>> 0));
    return true;
  }
  setReg(cpu, z, ((getReg(cpu, z) | ((1 << y) >>> 0)) >>> 0));
  return true;
}

function adcHL(cpu, rp) {
  const hl = getHL(cpu);
  const c = ((cpu.f & FC) >>> 0);
  const r = Math.trunc((Math.trunc((hl + rp)) + c));
  const res = ((r & 65535) >>> 0);
  setFlag(cpu, FS, (((res & 32768) >>> 0) != 0));
  setFlag(cpu, FZ, (res == 0));
  setFlag(cpu, FH, (Math.trunc((Math.trunc((((hl & 4095) >>> 0) + ((rp & 4095) >>> 0))) + c)) > 4095));
  setFlag(cpu, FPV, ((((((~((hl ^ rp) >>> 0)) & ((hl ^ res) >>> 0)) >>> 0) & 32768) >>> 0) != 0));
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, (r > 65535));
  setFlag(cpu, FY, (((res & 8192) >>> 0) != 0));
  setFlag(cpu, FX, (((res & 2048) >>> 0) != 0));
  setHL(cpu, res);
}

function sbcHL(cpu, rp) {
  const hl = getHL(cpu);
  const c = ((cpu.f & FC) >>> 0);
  const r = Math.trunc((Math.trunc((hl - rp)) - c));
  const res = ((r & 65535) >>> 0);
  setFlag(cpu, FS, (((res & 32768) >>> 0) != 0));
  setFlag(cpu, FZ, (res == 0));
  setFlag(cpu, FH, (Math.trunc((Math.trunc((((hl & 4095) >>> 0) - ((rp & 4095) >>> 0))) - c)) < 0));
  setFlag(cpu, FPV, (((((((hl ^ rp) >>> 0) & ((hl ^ res) >>> 0)) >>> 0) & 32768) >>> 0) != 0));
  setFlag(cpu, FN, true);
  setFlag(cpu, FC, (r < 0));
  setFlag(cpu, FY, (((res & 8192) >>> 0) != 0));
  setFlag(cpu, FX, (((res & 2048) >>> 0) != 0));
  setHL(cpu, res);
}

function blockLd(cpu, dir) {
  const v = rd(cpu, getHL(cpu));
  wr(cpu, getDE(cpu), v);
  setDE(cpu, ((Math.trunc((getDE(cpu) + dir)) & 65535) >>> 0));
  setHL(cpu, ((Math.trunc((getHL(cpu) + dir)) & 65535) >>> 0));
  setBC(cpu, ((Math.trunc((getBC(cpu) - 1)) & 65535) >>> 0));
  const n = ((Math.trunc((v + cpu.a)) & 255) >>> 0);
  setFlag(cpu, FH, false);
  setFlag(cpu, FN, false);
  setFlag(cpu, FPV, (getBC(cpu) != 0));
  setFlag(cpu, FY, (((n & 2) >>> 0) != 0));
  setFlag(cpu, FX, (((n & 8) >>> 0) != 0));
}

function blockCp(cpu, dir) {
  const v = rd(cpu, getHL(cpu));
  const r = ((Math.trunc((cpu.a - v)) & 255) >>> 0);
  const hcarry = (Math.trunc((((cpu.a & 15) >>> 0) - ((v & 15) >>> 0))) < 0);
  setHL(cpu, ((Math.trunc((getHL(cpu) + dir)) & 65535) >>> 0));
  setBC(cpu, ((Math.trunc((getBC(cpu) - 1)) & 65535) >>> 0));
  setFlag(cpu, FS, (((r & 128) >>> 0) != 0));
  setFlag(cpu, FZ, (r == 0));
  setFlag(cpu, FH, hcarry);
  setFlag(cpu, FN, true);
  setFlag(cpu, FPV, (getBC(cpu) != 0));
  let hb = 0;
  if (hcarry) {
    hb = 1;
  }
  const n = ((Math.trunc((r - hb)) & 255) >>> 0);
  setFlag(cpu, FY, (((n & 2) >>> 0) != 0));
  setFlag(cpu, FX, (((n & 8) >>> 0) != 0));
}

function execED(cpu) {
  const op = fetchOp(cpu);
  const x = ((Math.floor(op / 2 ** (6)) & 3) >>> 0);
  const y = ((Math.floor(op / 2 ** (3)) & 7) >>> 0);
  const z = ((op & 7) >>> 0);
  const p = Math.floor(y / 2 ** (1));
  const q = ((y & 1) >>> 0);
  if ((x == 1)) {
    if ((z == 2)) {
      if ((q == 0)) {
        sbcHL(cpu, getRP(cpu, p));
      } else {
        adcHL(cpu, getRP(cpu, p));
      }
      return true;
    }
    if ((z == 3)) {
      const nn = zfetch16(cpu);
      if ((q == 0)) {
        const v = getRP(cpu, p);
        wr(cpu, nn, ((v & 255) >>> 0));
        wr(cpu, Math.trunc((nn + 1)), ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
      } else {
        const lo = rd(cpu, nn);
        const hi = rd(cpu, Math.trunc((nn + 1)));
        setRP(cpu, p, ((((hi << 8) >>> 0) | lo) >>> 0));
      }
      return true;
    }
    if ((z == 4)) {
      const a = cpu.a;
      cpu.a = ((Math.trunc((0 - a)) & 255) >>> 0);
      setSZYX(cpu, cpu.a);
      setFlag(cpu, FH, (((a & 15) >>> 0) != 0));
      setFlag(cpu, FPV, (a == 128));
      setFlag(cpu, FN, true);
      setFlag(cpu, FC, (a != 0));
      return true;
    }
    if ((z == 5)) {
      cpu.pc = pop16(cpu);
      cpu.iff1 = cpu.iff2;
      return true;
    }
    if ((z == 6)) {
      if (((y == 2) || (y == 6))) {
        cpu.im = 1;
      } else {
        if (((y == 3) || (y == 7))) {
          cpu.im = 2;
        } else {
          cpu.im = 0;
        }
      }
      return true;
    }
    if ((z == 7)) {
      if ((y == 0)) {
        cpu.i = cpu.a;
      } else {
        if ((y == 1)) {
          cpu.r = cpu.a;
        } else {
          if (((y == 2) || (y == 3))) {
            cpu.a = (() => {
            if ((y == 2)) {
              return cpu.i;
            } else {
              return cpu.r;
            }
            })();
            setFlag(cpu, FS, (((cpu.a & 128) >>> 0) != 0));
            setFlag(cpu, FZ, (cpu.a == 0));
            setFlag(cpu, FY, (((cpu.a & 32) >>> 0) != 0));
            setFlag(cpu, FX, (((cpu.a & 8) >>> 0) != 0));
            setFlag(cpu, FH, false);
            setFlag(cpu, FN, false);
            setFlag(cpu, FPV, cpu.iff2);
          } else {
            if ((y == 4)) {
              const m = rd(cpu, getHL(cpu));
              const newM = ((((Math.floor(m / 2 ** (4)) | ((((cpu.a & 15) >>> 0) << 4) >>> 0)) >>> 0) & 255) >>> 0);
              cpu.a = ((((cpu.a & 240) >>> 0) | ((m & 15) >>> 0)) >>> 0);
              wr(cpu, getHL(cpu), newM);
              setSZYX(cpu, cpu.a);
              setFlag(cpu, FPV, parityEven(cpu.a));
              setFlag(cpu, FH, false);
              setFlag(cpu, FN, false);
            } else {
              if ((y == 5)) {
                const m = rd(cpu, getHL(cpu));
                const newM = ((((((m << 4) >>> 0) | ((cpu.a & 15) >>> 0)) >>> 0) & 255) >>> 0);
                cpu.a = ((((cpu.a & 240) >>> 0) | ((Math.floor(m / 2 ** (4)) & 15) >>> 0)) >>> 0);
                wr(cpu, getHL(cpu), newM);
                setSZYX(cpu, cpu.a);
                setFlag(cpu, FPV, parityEven(cpu.a));
                setFlag(cpu, FH, false);
                setFlag(cpu, FN, false);
              }
            }
          }
        }
      }
      return true;
    }
    return false;
  }
  if ((x == 2)) {
    if (((y >= 4) && (z < 4))) {
      let dir = (-1);
      if (((y == 4) || (y == 6))) {
        dir = 1;
      }
      if ((z == 0)) {
        blockLd(cpu, dir);
        if ((((y == 6) || (y == 7)) && (getBC(cpu) != 0))) {
          cpu.pc = ((Math.trunc((cpu.pc - 2)) & 65535) >>> 0);
        }
        return true;
      }
      if ((z == 1)) {
        blockCp(cpu, dir);
        if (((((y == 6) || (y == 7)) && (getBC(cpu) != 0)) && (((cpu.f & FZ) >>> 0) == 0))) {
          cpu.pc = ((Math.trunc((cpu.pc - 2)) & 65535) >>> 0);
        }
        return true;
      }
      return false;
    }
    return true;
  }
  return true;
}

function shiftOp(cpu, kind, v) {
  const oldC = (((cpu.f & FC) >>> 0) != 0);
  let res = 0;
  let carry = false;
  if ((kind == 0)) {
    carry = (((v & 128) >>> 0) != 0);
    res = ((((((v << 1) >>> 0) | (() => {
    if (carry) {
      return 1;
    } else {
      return 0;
    }
    })()) >>> 0) & 255) >>> 0);
  } else {
    if ((kind == 1)) {
      carry = (((v & 1) >>> 0) != 0);
      res = ((((Math.floor(v / 2 ** (1)) | (() => {
      if (carry) {
        return 128;
      } else {
        return 0;
      }
      })()) >>> 0) & 255) >>> 0);
    } else {
      if ((kind == 2)) {
        carry = (((v & 128) >>> 0) != 0);
        res = ((((((v << 1) >>> 0) | (() => {
        if (oldC) {
          return 1;
        } else {
          return 0;
        }
        })()) >>> 0) & 255) >>> 0);
      } else {
        if ((kind == 3)) {
          carry = (((v & 1) >>> 0) != 0);
          res = ((((Math.floor(v / 2 ** (1)) | (() => {
          if (oldC) {
            return 128;
          } else {
            return 0;
          }
          })()) >>> 0) & 255) >>> 0);
        } else {
          if ((kind == 4)) {
            carry = (((v & 128) >>> 0) != 0);
            res = ((((v << 1) >>> 0) & 255) >>> 0);
          } else {
            if ((kind == 5)) {
              carry = (((v & 1) >>> 0) != 0);
              res = ((((Math.floor(v / 2 ** (1)) | ((v & 128) >>> 0)) >>> 0) & 255) >>> 0);
            } else {
              if ((kind == 6)) {
                carry = (((v & 128) >>> 0) != 0);
                res = ((((((v << 1) >>> 0) | 1) >>> 0) & 255) >>> 0);
              } else {
                carry = (((v & 1) >>> 0) != 0);
                res = ((Math.floor(v / 2 ** (1)) & 255) >>> 0);
              }
            }
          }
        }
      }
    }
  }
  setSZYX(cpu, res);
  setFlag(cpu, FPV, parityEven(res));
  setFlag(cpu, FH, false);
  setFlag(cpu, FN, false);
  setFlag(cpu, FC, carry);
  return res;
}

function newSynth() {
  return new Synth([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], Array.from({length: 24}, () => __clone(0)), [0, 0, 0, 0, 0, 0], 32768);
}

function opOff(opNum) {
  if ((opNum == 1)) {
    return 0;
  }
  if ((opNum == 2)) {
    return 8;
  }
  if ((opNum == 3)) {
    return 4;
  }
  return 12;
}

function operatorOut(s, z, c, part, ci, opNum, baseInc, modIn) {
  const off = opOff(opNum);
  const idx = Math.trunc((Math.trunc((c * 4)) + Math.trunc((opNum - 1))));
  const inc = Math.trunc(Math.trunc(Math.trunc((baseInc * opMulX2(z, part, off, ci))) / 2));
  s.opPhase[idx] = ((Math.trunc((s.opPhase[idx] + inc)) & 16777215) >>> 0);
  const tl = ((z.ym[Math.trunc((Math.trunc((Math.trunc((part + 64)) + off)) + ci))] & 127) >>> 0);
  const atten = Math.trunc((127 - tl));
  if ((atten <= 0)) {
    return 0;
  }
  const ph = ((Math.trunc((Math.floor(s.opPhase[idx] / 2 ** (8)) + modIn)) & 255) >>> 0);
  return Math.trunc(Math.trunc(Math.trunc((sineLut(ph) * atten)) / 127));
}

function fmChannel4op(s, z, c, part, ci, baseInc) {
  const alg = ((z.ym[Math.trunc((Math.trunc((part + 176)) + ci))] & 7) >>> 0);
  const fb = ((Math.floor(z.ym[Math.trunc((Math.trunc((part + 176)) + ci))] / 2 ** (3)) & 7) >>> 0);
  let fbIn = 0;
  if ((fb > 0)) {
    fbIn = Math.floor(s.fbMem[c] / 2 ** (Math.trunc((9 - fb))));
  }
  const o1 = operatorOut(s, z, c, part, ci, 1, baseInc, fbIn);
  s.fbMem[c] = o1;
  let out = 0;
  if ((alg == 0)) {
    const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, o1);
    const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, o2);
    out = operatorOut(s, z, c, part, ci, 4, baseInc, o3);
  } else {
    if ((alg == 1)) {
      const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, 0);
      const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, Math.trunc((o1 + o2)));
      out = operatorOut(s, z, c, part, ci, 4, baseInc, o3);
    } else {
      if ((alg == 2)) {
        const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, 0);
        const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, o2);
        out = operatorOut(s, z, c, part, ci, 4, baseInc, Math.trunc((o1 + o3)));
      } else {
        if ((alg == 3)) {
          const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, o1);
          const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, 0);
          out = operatorOut(s, z, c, part, ci, 4, baseInc, Math.trunc((o2 + o3)));
        } else {
          if ((alg == 4)) {
            const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, o1);
            const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, 0);
            const o4 = operatorOut(s, z, c, part, ci, 4, baseInc, o3);
            out = Math.trunc((o2 + o4));
          } else {
            if ((alg == 5)) {
              const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, o1);
              const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, o1);
              const o4 = operatorOut(s, z, c, part, ci, 4, baseInc, o1);
              out = Math.trunc((Math.trunc((o2 + o3)) + o4));
            } else {
              if ((alg == 6)) {
                const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, o1);
                const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, 0);
                const o4 = operatorOut(s, z, c, part, ci, 4, baseInc, 0);
                out = Math.trunc((Math.trunc((o2 + o3)) + o4));
              } else {
                const o2 = operatorOut(s, z, c, part, ci, 2, baseInc, 0);
                const o3 = operatorOut(s, z, c, part, ci, 3, baseInc, 0);
                const o4 = operatorOut(s, z, c, part, ci, 4, baseInc, 0);
                out = Math.trunc((Math.trunc((Math.trunc((o1 + o2)) + o3)) + o4));
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function opMulX2(z, part, slotOff, ci) {
  const mul = ((z.ym[Math.trunc((Math.trunc((Math.trunc((part + 48)) + slotOff)) + ci))] & 15) >>> 0);
  if ((mul == 0)) {
    return 1;
  }
  return Math.trunc((mul * 2));
}

function fmFreqMilli(z, c) {
  const part = (() => {
  if ((c < 3)) {
    return 0;
  } else {
    return 256;
  }
  })();
  const ci = (c % 3);
  const lo = z.ym[Math.trunc((Math.trunc((part + 160)) + ci))];
  const hi = z.ym[Math.trunc((Math.trunc((part + 164)) + ci))];
  const fnum = ((((((hi & 7) >>> 0) << 8) >>> 0) | lo) >>> 0);
  const block = ((Math.floor(hi / 2 ** (3)) & 7) >>> 0);
  const shifted = ((fnum << block) >>> 0);
  return Math.trunc(Math.trunc(Math.trunc((shifted * FM_SCALE_1E6)) / 1000));
}

function fmAmp(z, c) {
  const part = (() => {
  if ((c < 3)) {
    return 0;
  } else {
    return 256;
  }
  })();
  const ci = (c % 3);
  const tl = ((z.ym[Math.trunc((Math.trunc((part + 76)) + ci))] & 127) >>> 0);
  const a = Math.trunc((255 - Math.trunc((tl * 2))));
  if ((a < 0)) {
    return 0;
  }
  return a;
}

function keyOnMask(z) {
  return z.ym[40];
}

function panLR(z, part, ci) {
  const p = ((Math.floor(z.ym[Math.trunc((Math.trunc((part + 180)) + ci))] / 2 ** (6)) & 3) >>> 0);
  if ((p == 0)) {
    return 3;
  }
  return p;
}

function synthSample(s, z) {
  let accL = 0;
  let accR = 0;
  const dacOn = (((z.ym[43] & 128) >>> 0) != 0);
  if (dacOn) {
    if ((z.dacR < z.dacW)) {
      const smp = z.dac[((z.dacR & 4095) >>> 0)];
      z.dacR = Math.trunc((z.dacR + 1));
      const v = Math.trunc((Math.trunc((smp - 128)) * 3));
      const pan = panLR(z, 256, 2);
      if ((((pan & 2) >>> 0) != 0)) {
        accL = Math.trunc((accL + v));
      }
      if ((((pan & 1) >>> 0) != 0)) {
        accR = Math.trunc((accR + v));
      }
    }
  }
  let c = 0;
  while ((c < 6)) {
    if ((!((c == 5) && dacOn))) {
      const part = (() => {
      if ((c < 3)) {
        return 0;
      } else {
        return 256;
      }
      })();
      const ci = (c % 3);
      const target = (() => {
      if (z.fmKey[c]) {
        return fmAmp(z, c);
      } else {
        return 0;
      }
      })();
      if ((s.envLevel[c] < target)) {
        s.envLevel[c] = Math.trunc((s.envLevel[c] + 8));
        if ((s.envLevel[c] > target)) {
          s.envLevel[c] = target;
        }
      } else {
        if ((s.envLevel[c] > target)) {
          const rr = ((z.ym[Math.trunc((Math.trunc((part + 140)) + ci))] & 15) >>> 0);
          const step = Math.trunc((1 + rr));
          s.envLevel[c] = Math.trunc((s.envLevel[c] - step));
          if ((s.envLevel[c] < target)) {
            s.envLevel[c] = target;
          }
        }
      }
      const fMilli = fmFreqMilli(z, c);
      if (((fMilli > 0) && (s.envLevel[c] > 0))) {
        const baseInc = Math.trunc(Math.trunc(Math.trunc((fMilli * 65536)) / Math.trunc((SAMPLE_RATE * 1000))));
        const chOut = Math.trunc(Math.trunc(Math.trunc((fmChannel4op(s, z, c, part, ci, baseInc) * s.envLevel[c])) / 255));
        const pan = panLR(z, part, ci);
        if ((((pan & 2) >>> 0) != 0)) {
          accL = Math.trunc((accL + chOut));
        }
        if ((((pan & 1) >>> 0) != 0)) {
          accR = Math.trunc((accR + chOut));
        }
      }
    }
    c = Math.trunc((c + 1));
  }
  let ch = 0;
  while ((ch < 3)) {
    const period = z.psg[Math.trunc((ch * 2))];
    const vol = Math.trunc((15 - ((z.psg[Math.trunc((Math.trunc((ch * 2)) + 1))] & 15) >>> 0)));
    if (((period > 0) && (vol > 0))) {
      const psgClk = 3579545;
      const freqMilli = Math.trunc(Math.trunc(Math.trunc((psgClk * 1000)) / Math.trunc((32 * period))));
      const inc = Math.trunc(Math.trunc(Math.trunc((freqMilli * 65536)) / Math.trunc((SAMPLE_RATE * 1000))));
      s.phase[Math.trunc((6 + ch))] = ((Math.trunc((s.phase[Math.trunc((6 + ch))] + inc)) & 16777215) >>> 0);
      const sq = (() => {
      if ((((Math.floor(s.phase[Math.trunc((6 + ch))] / 2 ** (15)) & 1) >>> 0) != 0)) {
        return 1;
      } else {
        return (-1);
      }
      })();
      const pv = Math.trunc((Math.trunc((sq * vol)) * 40));
      accL = Math.trunc((accL + pv));
      accR = Math.trunc((accR + pv));
    }
    ch = Math.trunc((ch + 1));
  }
  return new StereoSample(clampS16(Math.trunc((accL * 40))), clampS16(Math.trunc((accR * 40))));
}

function clampS16(v) {
  if ((v > 32767)) {
    return 32767;
  }
  if ((v < (-32768))) {
    return (-32768);
  }
  return v;
}

function sineLut(idx) {
  const i = ((idx & 255) >>> 0);
  const x = i;
  let t = 0;
  if ((x < 64)) {
    t = x;
  } else {
    if ((x < 128)) {
      t = Math.trunc((128 - x));
    } else {
      if ((x < 192)) {
        t = (-Math.trunc((x - 128)));
      } else {
        t = (-Math.trunc((256 - x)));
      }
    }
  }
  return t;
}

function frameWidth(m) {
  if ((((m.vdpRegs[12] & 1) >>> 0) != 0)) {
    return 320;
  }
  return 256;
}

function frameHeight(_m) {
  return 224;
}

function planeCells(code) {
  if ((code == 0)) {
    return 32;
  }
  if ((code == 1)) {
    return 64;
  }
  return 128;
}

function cramR(e) {
  return Math.trunc((((Math.floor(e / 2 ** (1)) & 7) >>> 0) * 36));
}

function cramG(e) {
  return Math.trunc((((Math.floor(e / 2 ** (5)) & 7) >>> 0) * 36));
}

function cramB(e) {
  return Math.trunc((((Math.floor(e / 2 ** (9)) & 7) >>> 0) * 36));
}

function shComp(c, mode) {
  if ((mode == 1)) {
    return Math.trunc(Math.trunc(c / 2));
  }
  if ((mode == 2)) {
    const v = Math.trunc((Math.trunc(Math.trunc(c / 2)) + 128));
    if ((v > 255)) {
      return 255;
    }
    return v;
  }
  return c;
}

function pixelR(m, packed) {
  return shComp(cramR(m.cram[((packed & 63) >>> 0)]), ((Math.floor(packed / 2 ** (6)) & 3) >>> 0));
}

function pixelG(m, packed) {
  return shComp(cramG(m.cram[((packed & 63) >>> 0)]), ((Math.floor(packed / 2 ** (6)) & 3) >>> 0));
}

function pixelB(m, packed) {
  return shComp(cramB(m.cram[((packed & 63) >>> 0)]), ((Math.floor(packed / 2 ** (6)) & 3) >>> 0));
}

function vram8(m, addr) {
  const a = ((addr & 65535) >>> 0);
  if ((a < m.vram.length)) {
    return Math.trunc(m.vram[a]);
  }
  return 0;
}

function wrapCoord(v, span) {
  const r = (v % span);
  if ((r < 0)) {
    return Math.trunc((r + span));
  }
  return r;
}

function hscrollFor(m, y, planeB) {
  const hbase = ((((m.vdpRegs[13] & 63) >>> 0) << 10) >>> 0);
  const mode = ((m.vdpRegs[11] & 3) >>> 0);
  let row = 0;
  if ((mode == 3)) {
    row = y;
  } else {
    if ((mode == 2)) {
      row = ((y & (~7)) >>> 0);
    }
  }
  const planeOff = (() => {
  if (planeB) {
    return 2;
  } else {
    return 0;
  }
  })();
  const off = Math.trunc((Math.trunc((hbase + Math.trunc((row * 4)))) + planeOff));
  return ((((vram8(m, off) << 8) >>> 0) | vram8(m, Math.trunc((off + 1)))) >>> 0);
}

function vscrollFor(m, planeB, colPair) {
  let idx = 0;
  if ((((m.vdpRegs[11] & 4) >>> 0) != 0)) {
    idx = (Math.trunc((colPair * 2)) % 40);
  }
  if (planeB) {
    return m.vsram[(Math.trunc((idx + 1)) % 40)];
  }
  return m.vsram[idx];
}

function sampleNametable(m, base, stride, cellX, cellY, fxIn, fyIn) {
  const entryAddr = Math.trunc((base + Math.trunc((Math.trunc((Math.trunc((cellY * stride)) + cellX)) * 2))));
  const entry = ((((vram8(m, entryAddr) << 8) >>> 0) | vram8(m, Math.trunc((entryAddr + 1)))) >>> 0);
  const tileIdx = ((entry & 2047) >>> 0);
  const palLine = ((Math.floor(entry / 2 ** (13)) & 3) >>> 0);
  const hflip = (((entry & 2048) >>> 0) != 0);
  const vflip = (((entry & 4096) >>> 0) != 0);
  let fx = fxIn;
  let fy = fyIn;
  if (hflip) {
    fx = Math.trunc((7 - fx));
  }
  if (vflip) {
    fy = Math.trunc((7 - fy));
  }
  const byte = vram8(m, Math.trunc((Math.trunc((Math.trunc((tileIdx * 32)) + Math.trunc((fy * 4)))) + Math.trunc(Math.trunc(fx / 2)))));
  let color = 0;
  if ((((fx & 1) >>> 0) == 0)) {
    color = ((Math.floor(byte / 2 ** (4)) & 15) >>> 0);
  } else {
    color = ((byte & 15) >>> 0);
  }
  if ((color == 0)) {
    return (-1);
  }
  let packed = Math.trunc((Math.trunc((palLine * 16)) + color));
  if ((((entry & 32768) >>> 0) != 0)) {
    packed = ((packed | PRI) >>> 0);
  }
  return packed;
}

function samplePlane(m, base, pw, ph, px, py) {
  return sampleNametable(m, base, pw, (Math.trunc(Math.trunc(px / 8)) % pw), (Math.trunc(Math.trunc(py / 8)) % ph), (px % 8), (py % 8));
}

function inWindow(m, x, y) {
  const rv = m.vdpRegs[18];
  const vval = Math.trunc((((rv & 31) >>> 0) * 8));
  let yin = false;
  if ((((rv & 128) >>> 0) != 0)) {
    yin = (y >= vval);
  } else {
    yin = (y < vval);
  }
  const rh = m.vdpRegs[17];
  const hval = Math.trunc((((rh & 31) >>> 0) * 16));
  let xin = false;
  if ((((rh & 128) >>> 0) != 0)) {
    xin = (x >= hval);
  } else {
    xin = (x < hval);
  }
  return (yin || xin);
}

function sampleWindow(m, x, y, width) {
  const stride = (() => {
  if ((width == 320)) {
    return 64;
  } else {
    return 32;
  }
  })();
  const base = (() => {
  if ((width == 320)) {
    return ((((m.vdpRegs[3] & 62) >>> 0) << 10) >>> 0);
  } else {
    return ((((m.vdpRegs[3] & 63) >>> 0) << 10) >>> 0);
  }
  })();
  return sampleNametable(m, base, stride, Math.trunc(Math.trunc(x / 8)), Math.trunc(Math.trunc(y / 8)), (x % 8), (y % 8));
}

function renderIndexed(m) {
  const width = frameWidth(m);
  const height = frameHeight(m);
  const planeW = planeCells(((m.vdpRegs[16] & 3) >>> 0));
  const planeH = planeCells(((Math.floor(m.vdpRegs[16] / 2 ** (4)) & 3) >>> 0));
  const baseA = ((((m.vdpRegs[2] & 56) >>> 0) << 10) >>> 0);
  const baseB = ((((m.vdpRegs[4] & 7) >>> 0) << 13) >>> 0);
  const backdrop = ((m.vdpRegs[7] & 63) >>> 0);
  const sh = (((m.vdpRegs[12] & 8) >>> 0) != 0);
  if ((((m.vdpRegs[1] & 64) >>> 0) == 0)) {
    let blank = [];
    let bi = 0;
    while ((bi < Math.trunc((width * height)))) {
      blank.push(((backdrop & 63) >>> 0));
      bi = Math.trunc((bi + 1));
    }
    return blank;
  }
  const spanAx = Math.trunc((planeW * 8));
  const spanAy = Math.trunc((planeH * 8));
  let spr = [];
  let s = 0;
  while ((s < Math.trunc((width * height)))) {
    spr.push((-1));
    s = Math.trunc((s + 1));
  }
  drawSprites(m, spr, width, height);
  let fb = [];
  let y = 0;
  while ((y < height)) {
    const hA = hscrollFor(m, y, false);
    const hB = hscrollFor(m, y, true);
    let x = 0;
    while ((x < width)) {
      const colPair = Math.trunc(Math.trunc(x / 16));
      const pyA = wrapCoord(Math.trunc((y + vscrollFor(m, false, colPair))), spanAy);
      const pyB = wrapCoord(Math.trunc((y + vscrollFor(m, true, colPair))), spanAy);
      let aVal = (-1);
      if (inWindow(m, x, y)) {
        aVal = sampleWindow(m, x, y, width);
      } else {
        aVal = samplePlane(m, baseA, planeW, planeH, wrapCoord(Math.trunc((x - hA)), spanAx), pyA);
      }
      const bVal = samplePlane(m, baseB, planeW, planeH, wrapCoord(Math.trunc((x - hB)), spanAx), pyB);
      let sVal = spr[Math.trunc((Math.trunc((y * width)) + x))];
      let shadowed = false;
      let highlighted = false;
      if (sh) {
        const hiPlane = (((aVal >= 0) && (((aVal & PRI) >>> 0) != 0)) || ((bVal >= 0) && (((bVal & PRI) >>> 0) != 0)));
        shadowed = (!hiPlane);
        if ((sVal >= 0)) {
          const sc = ((sVal & 63) >>> 0);
          if ((sc == 63)) {
            shadowed = true;
            sVal = (-1);
          } else {
            if ((sc == 62)) {
              if (shadowed) {
                shadowed = false;
              } else {
                highlighted = true;
              }
              sVal = (-1);
            }
          }
        }
      }
      let pick = backdrop;
      let winSprite = false;
      if (((sVal >= 0) && (((sVal & PRI) >>> 0) != 0))) {
        pick = ((sVal & 63) >>> 0);
        winSprite = true;
      } else {
        if (((aVal >= 0) && (((aVal & PRI) >>> 0) != 0))) {
          pick = ((aVal & 63) >>> 0);
        } else {
          if (((bVal >= 0) && (((bVal & PRI) >>> 0) != 0))) {
            pick = ((bVal & 63) >>> 0);
          } else {
            if ((sVal >= 0)) {
              pick = ((sVal & 63) >>> 0);
              winSprite = true;
            } else {
              if ((aVal >= 0)) {
                pick = ((aVal & 63) >>> 0);
              } else {
                if ((bVal >= 0)) {
                  pick = ((bVal & 63) >>> 0);
                }
              }
            }
          }
        }
      }
      let mode = 0;
      if ((sh && (!winSprite))) {
        if (highlighted) {
          mode = 2;
        } else {
          if (shadowed) {
            mode = 1;
          }
        }
      }
      fb.push(((((pick & 63) >>> 0) | ((mode << 6) >>> 0)) >>> 0));
      x = Math.trunc((x + 1));
    }
    y = Math.trunc((y + 1));
  }
  return fb;
}

function drawSprites(m, fb, width, height) {
  const satBase = ((((m.vdpRegs[5] & 127) >>> 0) << 9) >>> 0);
  let sprIdx = 0;
  let guard = 0;
  while ((guard < 80)) {
    const o = Math.trunc((satBase + Math.trunc((sprIdx * 8))));
    const yraw = ((((((vram8(m, o) << 8) >>> 0) | vram8(m, Math.trunc((o + 1)))) >>> 0) & 1023) >>> 0);
    const sizeByte = vram8(m, Math.trunc((o + 2)));
    const hs = Math.trunc((((Math.floor(sizeByte / 2 ** (2)) & 3) >>> 0) + 1));
    const vs = Math.trunc((((sizeByte & 3) >>> 0) + 1));
    const link = ((vram8(m, Math.trunc((o + 3))) & 127) >>> 0);
    const attr = ((((vram8(m, Math.trunc((o + 4))) << 8) >>> 0) | vram8(m, Math.trunc((o + 5)))) >>> 0);
    const xraw = ((((((vram8(m, Math.trunc((o + 6))) << 8) >>> 0) | vram8(m, Math.trunc((o + 7)))) >>> 0) & 511) >>> 0);
    const tileBase = ((attr & 2047) >>> 0);
    const pal = ((Math.floor(attr / 2 ** (13)) & 3) >>> 0);
    const hflip = (((attr & 2048) >>> 0) != 0);
    const vflip = (((attr & 4096) >>> 0) != 0);
    const pri = (((attr & 32768) >>> 0) != 0);
    const sx = Math.trunc((xraw - 128));
    const sy = Math.trunc((yraw - 128));
    let col = 0;
    while ((col < hs)) {
      let row = 0;
      while ((row < vs)) {
        const tile = Math.trunc((Math.trunc((tileBase + Math.trunc((col * vs)))) + row));
        const destCol = (() => {
        if (hflip) {
          return Math.trunc((Math.trunc((hs - 1)) - col));
        } else {
          return col;
        }
        })();
        const destRow = (() => {
        if (vflip) {
          return Math.trunc((Math.trunc((vs - 1)) - row));
        } else {
          return row;
        }
        })();
        drawSprTile(m, fb, width, height, tile, Math.trunc((sx + Math.trunc((destCol * 8)))), Math.trunc((sy + Math.trunc((destRow * 8)))), pal, hflip, vflip, pri);
        row = Math.trunc((row + 1));
      }
      col = Math.trunc((col + 1));
    }
    if ((link == 0)) {
      return;
    }
    sprIdx = link;
    guard = Math.trunc((guard + 1));
  }
}

function drawSprTile(m, fb, width, height, tile, ox, oy, pal, hflip, vflip, pri) {
  let py = 0;
  while ((py < 8)) {
    let px = 0;
    while ((px < 8)) {
      const dx = Math.trunc((ox + px));
      const dy = Math.trunc((oy + py));
      if (((((dx >= 0) && (dx < width)) && (dy >= 0)) && (dy < height))) {
        const slot = Math.trunc((Math.trunc((dy * width)) + dx));
        if ((fb[slot] < 0)) {
          let fx = px;
          let fy = py;
          if (hflip) {
            fx = Math.trunc((7 - px));
          }
          if (vflip) {
            fy = Math.trunc((7 - py));
          }
          const byte = vram8(m, Math.trunc((Math.trunc((Math.trunc((tile * 32)) + Math.trunc((fy * 4)))) + Math.trunc(Math.trunc(fx / 2)))));
          let color = 0;
          if ((((fx & 1) >>> 0) == 0)) {
            color = ((Math.floor(byte / 2 ** (4)) & 15) >>> 0);
          } else {
            color = ((byte & 15) >>> 0);
          }
          if ((color != 0)) {
            let packed = Math.trunc((Math.trunc((pal * 16)) + color));
            if (pri) {
              packed = ((packed | PRI) >>> 0);
            }
            fb[slot] = packed;
          }
        }
      }
      px = Math.trunc((px + 1));
    }
    py = Math.trunc((py + 1));
  }
}

function StereoSample$Eq$eq(self, other) {
  return ((self.l == other.l) && (self.r == other.r));
}

main();
__flush();
