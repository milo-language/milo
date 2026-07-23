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

class SnesHandle {
  constructor(cpu, m, fb, rgba) {
    this.cpu = cpu;
    this.m = m;
    this.fb = fb;
    this.rgba = rgba;
  }
}

class Cpu {
  constructor(a, x, y, s, d, pc, p, dbr, pbr, e) {
    this.a = a;
    this.x = x;
    this.y = y;
    this.s = s;
    this.d = d;
    this.pc = pc;
    this.p = p;
    this.dbr = dbr;
    this.pbr = pbr;
    this.e = e;
  }
}

class Mem {
  constructor(addr, val, testMode, wram, rom, romMask, sram, sramMask, mapMode, mmio, nmitimen, htime, vtime, timeup, wmadd, wrmpya, wrdiv, rddiv, rdmpy, vblankToggle, hcounter, joy1, joy2, apuSpc, apuMem, ppu) {
    this.addr = addr;
    this.val = val;
    this.testMode = testMode;
    this.wram = wram;
    this.rom = rom;
    this.romMask = romMask;
    this.sram = sram;
    this.sramMask = sramMask;
    this.mapMode = mapMode;
    this.mmio = mmio;
    this.nmitimen = nmitimen;
    this.htime = htime;
    this.vtime = vtime;
    this.timeup = timeup;
    this.wmadd = wmadd;
    this.wrmpya = wrmpya;
    this.wrdiv = wrdiv;
    this.rddiv = rddiv;
    this.rdmpy = rdmpy;
    this.vblankToggle = vblankToggle;
    this.hcounter = hcounter;
    this.joy1 = joy1;
    this.joy2 = joy2;
    this.apuSpc = apuSpc;
    this.apuMem = apuMem;
    this.ppu = ppu;
  }
}

class Spc {
  constructor(a, x, y, sp, pc, psw) {
    this.a = a;
    this.x = x;
    this.y = y;
    this.sp = sp;
    this.pc = pc;
    this.psw = psw;
  }
}

class SpcMem {
  constructor(addr, val, testMode, ram, ipl, iplEnabled, inPort, outPort, tEnable, tTarget, tDiv, tCount, tOut, dspAddr, dsp) {
    this.addr = addr;
    this.val = val;
    this.testMode = testMode;
    this.ram = ram;
    this.ipl = ipl;
    this.iplEnabled = iplEnabled;
    this.inPort = inPort;
    this.outPort = outPort;
    this.tEnable = tEnable;
    this.tTarget = tTarget;
    this.tDiv = tDiv;
    this.tCount = tCount;
    this.tOut = tOut;
    this.dspAddr = dspAddr;
    this.dsp = dsp;
  }
}

class Ppu {
  constructor(vram, cgram, oam, inidisp, obsel, oamaddr, oamLatch, oamHi, bgmode, bgsc0, bgsc1, bgsc2, bgsc3, bg12nba, bg34nba, bghofs, bgvofs, scrollLatch, scrollHi, vmain, vmaddr, vmLatch, cgaddr, cgLatch, cgHi, tm, ts, cgadsub, coldR, coldG, coldB, m7a, m7b, m7c, m7d, m7x, m7y, m7hofs, m7vofs, m7sel, m7Latch, hdmaOn, lineBright, lineColdR, lineColdG, lineColdB, w12sel, w34sel, wh0, wh1, wh2, wh3, wbglog, tmw, tsw, lineWH0, lineWH1) {
    this.vram = vram;
    this.cgram = cgram;
    this.oam = oam;
    this.inidisp = inidisp;
    this.obsel = obsel;
    this.oamaddr = oamaddr;
    this.oamLatch = oamLatch;
    this.oamHi = oamHi;
    this.bgmode = bgmode;
    this.bgsc0 = bgsc0;
    this.bgsc1 = bgsc1;
    this.bgsc2 = bgsc2;
    this.bgsc3 = bgsc3;
    this.bg12nba = bg12nba;
    this.bg34nba = bg34nba;
    this.bghofs = bghofs;
    this.bgvofs = bgvofs;
    this.scrollLatch = scrollLatch;
    this.scrollHi = scrollHi;
    this.vmain = vmain;
    this.vmaddr = vmaddr;
    this.vmLatch = vmLatch;
    this.cgaddr = cgaddr;
    this.cgLatch = cgLatch;
    this.cgHi = cgHi;
    this.tm = tm;
    this.ts = ts;
    this.cgadsub = cgadsub;
    this.coldR = coldR;
    this.coldG = coldG;
    this.coldB = coldB;
    this.m7a = m7a;
    this.m7b = m7b;
    this.m7c = m7c;
    this.m7d = m7d;
    this.m7x = m7x;
    this.m7y = m7y;
    this.m7hofs = m7hofs;
    this.m7vofs = m7vofs;
    this.m7sel = m7sel;
    this.m7Latch = m7Latch;
    this.hdmaOn = hdmaOn;
    this.lineBright = lineBright;
    this.lineColdR = lineColdR;
    this.lineColdG = lineColdG;
    this.lineColdB = lineColdB;
    this.w12sel = w12sel;
    this.w34sel = w34sel;
    this.wh0 = wh0;
    this.wh1 = wh1;
    this.wh2 = wh2;
    this.wh3 = wh3;
    this.wbglog = wbglog;
    this.tmw = tmw;
    this.tsw = tsw;
    this.lineWH0 = lineWH0;
    this.lineWH1 = lineWH1;
  }
}

class Cart {
  constructor(rom, map) {
    this.rom = rom;
    this.map = map;
  }
}

const Result_Cart_string = {
  Ok(_0) { return { tag: 0, data: [_0] }; },
  Err(_0) { return { tag: 1, data: [_0] }; },
};

const __enumMeta = {
  "Result_Cart_string": [["Ok", 1], ["Err", 1]],
  "Option": [["Some", 1], ["None", 0]],
  "Result": [["Ok", 1], ["Err", 1]]
};

const SNES_W = 256;
const SNES_H = 224;
const FC = 1;
const FZ = 2;
const FI = 4;
const FD = 8;
const FX = 16;
const FM = 32;
const FV = 64;
const FN = 128;
const PC_ = 1;
const PZ = 2;
const PI = 4;
const PH = 8;
const PB = 16;
const PP = 32;
const PV = 64;
const PN = 128;

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

function createSnes(rom) {
  let data = [];
  let mapMode = 0;
  const _t0 = parseCart(rom);
  if (_t0.tag === 0) {
    const c = _t0.data[0];
    data = c.rom;
    mapMode = c.map;
  } else if (_t0.tag === 1) {
    const e = _t0.data[0];
    __print(("SNES ROM parse failed: " + e) + "\n");
  }
  let m = busNew(data, mapMode);
  let cpu = newCpuReset(m);
  let fb = [];
  let rgba = [];
  let i = 0;
  while ((i < Math.trunc((SNES_W * SNES_H)))) {
    fb.push(0);
    rgba.push(0);
    rgba.push(0);
    rgba.push(0);
    rgba.push(255);
    i = Math.trunc((i + 1));
  }
  return new SnesHandle(cpu, m, fb, rgba);
}

function setButtons(h, j) {
  h.m.joy1 = j;
}

function setButtons2(h, j) {
  h.m.joy2 = j;
}

function advanceFrame(h) {
  stepFrame(h.cpu, h.m);
  renderFrame(h.m.ppu, h.fb);
  let i = 0;
  while ((i < Math.trunc((SNES_W * SNES_H)))) {
    const c = h.fb[i];
    const dst = Math.trunc((i * 4));
    h.rgba[dst] = (((Math.floor(c / 2 ** (16)) & 255) >>> 0) & 0xFF);
    h.rgba[Math.trunc((dst + 1))] = (((Math.floor(c / 2 ** (8)) & 255) >>> 0) & 0xFF);
    h.rgba[Math.trunc((dst + 2))] = (((c & 255) >>> 0) & 0xFF);
    h.rgba[Math.trunc((dst + 3))] = 255;
    i = Math.trunc((i + 1));
  }
}

function frameW(h) {
  return SNES_W;
}

function frameH(h) {
  return SNES_H;
}

function main() {
  return 0;
}

function newApuSpc() {
  return new Spc(0, 0, 0, 0, 0, 0);
}

function memNew() {
  return new Mem([], [], true, [], [], 0, [], 0, 0, [], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, newApuSpc(), spcMemNew(), newPpu());
}

function vecZeros(n) {
  let v = [];
  let i = 0;
  while ((i < n)) {
    v.push(0);
    i = Math.trunc((i + 1));
  }
  return v;
}

function busNew(rom, mapMode) {
  const len = rom.length;
  let mask = 1;
  while ((mask < len)) {
    mask = ((mask << 1) >>> 0);
  }
  mask = Math.trunc((mask - 1));
  let mem = new Mem([], [], false, vecZeros(131072), rom, mask, vecZeros(32768), 32767, mapMode, vecZeros(16384), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, newApuSpc(), spcMemReal(), newPpu());
  mem.apuSpc.pc = 65472;
  mem.apuSpc.sp = 239;
  mem.apuSpc.psw = 2;
  return mem;
}

function runApu(m, n) {
  if (m.testMode) {
    return;
  }
  let i = 0;
  while ((i < n)) {
    spcStep(m.apuSpc, m.apuMem);
    i = Math.trunc((i + 1));
  }
}

function busReadCgram(m, a) {
  return ppuCgram(m.ppu, a);
}

function busReadVram(m, a) {
  return ppuVram(m.ppu, a);
}

function scratch(m, addr) {
  return Math.trunc(m.mmio[Math.trunc((addr - 8192))]);
}

function setScratch(m, addr, v) {
  m.mmio[Math.trunc((addr - 8192))] = (((v & 255) >>> 0) & 0xFF);
}

function dmaPatternOffset(pattern, count) {
  if ((pattern == 0)) {
    return 0;
  }
  if ((pattern == 1)) {
    return ((count & 1) >>> 0);
  }
  if ((pattern == 2)) {
    return 0;
  }
  if ((pattern == 3)) {
    return Math.floor(((count & 3) >>> 0) / 2 ** (1));
  }
  if ((pattern == 4)) {
    return ((count & 3) >>> 0);
  }
  return ((count & 1) >>> 0);
}

function runDMA(m, channels) {
  let ch = 0;
  while ((ch < 8)) {
    if ((((Math.floor(channels / 2 ** (ch)) & 1) >>> 0) != 0)) {
      const base = Math.trunc((17152 + Math.trunc((ch * 16))));
      const dmap = scratch(m, Math.trunc((base + 0)));
      const bbad = scratch(m, Math.trunc((base + 1)));
      let aaddr = ((scratch(m, Math.trunc((base + 2))) | ((scratch(m, Math.trunc((base + 3))) << 8) >>> 0)) >>> 0);
      const abank = scratch(m, Math.trunc((base + 4)));
      let size = ((scratch(m, Math.trunc((base + 5))) | ((scratch(m, Math.trunc((base + 6))) << 8) >>> 0)) >>> 0);
      if ((size == 0)) {
        size = 65536;
      }
      const dir = ((Math.floor(dmap / 2 ** (7)) & 1) >>> 0);
      const pattern = ((dmap & 7) >>> 0);
      const amode = ((Math.floor(dmap / 2 ** (3)) & 3) >>> 0);
      const astep = (() => {
      if ((amode == 0)) {
        return 1;
      } else {
        return (() => {
        if ((amode == 2)) {
          return (-1);
        } else {
          return 0;
        }
        })();
      }
      })();
      let count = 0;
      while ((count < size)) {
        const bAddr = ((8448 | ((Math.trunc((bbad + dmaPatternOffset(pattern, count))) & 255) >>> 0)) >>> 0);
        const aFull = ((((abank << 16) >>> 0) | ((aaddr & 65535) >>> 0)) >>> 0);
        if ((dir == 0)) {
          const v = memRead(m, aFull);
          memWrite(m, bAddr, v);
        } else {
          const v = memRead(m, bAddr);
          memWrite(m, aFull, v);
        }
        aaddr = ((Math.trunc((aaddr + astep)) & 65535) >>> 0);
        count = Math.trunc((count + 1));
      }
      setScratch(m, Math.trunc((base + 2)), ((aaddr & 255) >>> 0));
      setScratch(m, Math.trunc((base + 3)), ((Math.floor(aaddr / 2 ** (8)) & 255) >>> 0));
      setScratch(m, Math.trunc((base + 5)), 0);
      setScratch(m, Math.trunc((base + 6)), 0);
    }
    ch = Math.trunc((ch + 1));
  }
}

function hdmaUnitBytes(pattern) {
  if ((pattern == 0)) {
    return 1;
  }
  if ((((pattern == 1) || (pattern == 2)) || (pattern == 6))) {
    return 2;
  }
  return 4;
}

function hdmaByteReg(pattern, j) {
  if ((pattern == 1)) {
    return j;
  }
  if ((pattern == 4)) {
    return j;
  }
  if ((pattern == 5)) {
    return ((j & 1) >>> 0);
  }
  if (((pattern == 3) || (pattern == 7))) {
    if ((j < 2)) {
      return 0;
    }
    return 1;
  }
  return 0;
}

function hdmaApplyReg(m, line, reg, v) {
  if ((reg == 8448)) {
    let b = ((v & 15) >>> 0);
    if ((((v & 128) >>> 0) != 0)) {
      b = 0;
    }
    m.ppu.lineBright[line] = b;
    return;
  }
  if ((reg == 8498)) {
    const inten = ((v & 31) >>> 0);
    if ((((v & 32) >>> 0) != 0)) {
      m.ppu.lineColdR[line] = inten;
    }
    if ((((v & 64) >>> 0) != 0)) {
      m.ppu.lineColdG[line] = inten;
    }
    if ((((v & 128) >>> 0) != 0)) {
      m.ppu.lineColdB[line] = inten;
    }
    return;
  }
  if ((reg == 8486)) {
    m.ppu.lineWH0[line] = ((v & 255) >>> 0);
    return;
  }
  if ((reg == 8487)) {
    m.ppu.lineWH1[line] = ((v & 255) >>> 0);
    return;
  }
}

function hdmaWalkFrame(m) {
  const brightScalar = ((m.ppu.inidisp & 15) >>> 0);
  m.ppu.lineBright[0] = brightScalar;
  m.ppu.lineColdR[0] = m.ppu.coldR;
  m.ppu.lineColdG[0] = m.ppu.coldG;
  m.ppu.lineColdB[0] = m.ppu.coldB;
  m.ppu.lineWH0[0] = m.ppu.wh0;
  m.ppu.lineWH1[0] = m.ppu.wh1;
  const en = scratch(m, 16908);
  if ((en == 0)) {
    m.ppu.hdmaOn = false;
    return;
  }
  m.ppu.hdmaOn = true;
  let a2a = [];
  let a2b = [];
  let lctr = [];
  let done = [];
  let indAddr = [];
  let ch = 0;
  while ((ch < 8)) {
    const base = Math.trunc((17152 + Math.trunc((ch * 16))));
    a2a.push(((scratch(m, Math.trunc((base + 2))) | ((scratch(m, Math.trunc((base + 3))) << 8) >>> 0)) >>> 0));
    a2b.push(scratch(m, Math.trunc((base + 4))));
    lctr.push(0);
    done.push(0);
    indAddr.push(0);
    ch = Math.trunc((ch + 1));
  }
  let line = 0;
  while ((line < 224)) {
    if ((line > 0)) {
      m.ppu.lineBright[line] = m.ppu.lineBright[Math.trunc((line - 1))];
      m.ppu.lineColdR[line] = m.ppu.lineColdR[Math.trunc((line - 1))];
      m.ppu.lineColdG[line] = m.ppu.lineColdG[Math.trunc((line - 1))];
      m.ppu.lineColdB[line] = m.ppu.lineColdB[Math.trunc((line - 1))];
      m.ppu.lineWH0[line] = m.ppu.lineWH0[Math.trunc((line - 1))];
      m.ppu.lineWH1[line] = m.ppu.lineWH1[Math.trunc((line - 1))];
    }
    ch = 0;
    while ((ch < 8)) {
      if (((((Math.floor(en / 2 ** (ch)) & 1) >>> 0) != 0) && (done[ch] == 0))) {
        const base = Math.trunc((17152 + Math.trunc((ch * 16))));
        const dmap = scratch(m, Math.trunc((base + 0)));
        const bbad = scratch(m, Math.trunc((base + 1)));
        const indirect = (((dmap & 64) >>> 0) != 0);
        const pattern = ((dmap & 7) >>> 0);
        let doXfer = false;
        let terminated = false;
        if ((((lctr[ch] & 127) >>> 0) == 0)) {
          const bank = a2b[ch];
          let ptr = a2a[ch];
          const ntlr = memRead(m, ((((bank << 16) >>> 0) | ptr) >>> 0));
          ptr = ((Math.trunc((ptr + 1)) & 65535) >>> 0);
          if ((ntlr == 0)) {
            done[ch] = 1;
            terminated = true;
            a2a[ch] = ptr;
          } else {
            lctr[ch] = ntlr;
            doXfer = true;
            if (indirect) {
              const lo = memRead(m, ((((bank << 16) >>> 0) | ptr) >>> 0));
              ptr = ((Math.trunc((ptr + 1)) & 65535) >>> 0);
              const hi = memRead(m, ((((bank << 16) >>> 0) | ptr) >>> 0));
              ptr = ((Math.trunc((ptr + 1)) & 65535) >>> 0);
              indAddr[ch] = ((lo | ((hi << 8) >>> 0)) >>> 0);
            }
            a2a[ch] = ptr;
          }
        } else {
          doXfer = (((lctr[ch] & 128) >>> 0) != 0);
        }
        if ((!terminated)) {
          if (doXfer) {
            const nbytes = hdmaUnitBytes(pattern);
            let j = 0;
            while ((j < nbytes)) {
              const reg = ((8448 | ((Math.trunc((bbad + hdmaByteReg(pattern, j))) & 255) >>> 0)) >>> 0);
              let v = 0;
              if (indirect) {
                const dbank = scratch(m, Math.trunc((base + 7)));
                v = memRead(m, ((((dbank << 16) >>> 0) | ((indAddr[ch] & 65535) >>> 0)) >>> 0));
                indAddr[ch] = ((Math.trunc((indAddr[ch] + 1)) & 65535) >>> 0);
              } else {
                v = memRead(m, ((((a2b[ch] << 16) >>> 0) | a2a[ch]) >>> 0));
                a2a[ch] = ((Math.trunc((a2a[ch] + 1)) & 65535) >>> 0);
              }
              hdmaApplyReg(m, line, reg, v);
              j = Math.trunc((j + 1));
            }
          }
          lctr[ch] = ((Math.trunc((lctr[ch] - 1)) & 255) >>> 0);
        }
      }
      ch = Math.trunc((ch + 1));
    }
    line = Math.trunc((line + 1));
  }
}

function mmioRead(m, off) {
  if (((off >= 8448) && (off <= 8511))) {
    return ppuRegReadPure(m.ppu, Math.trunc((off - 8448)));
  }
  if (((off >= 8512) && (off <= 8515))) {
    return apuReadPort(m.apuMem, Math.trunc((off - 8512)));
  }
  if ((off == 8576)) {
    return Math.trunc(m.wram[((m.wmadd & 131071) >>> 0)]);
  }
  if ((off == 16912)) {
    return ((m.vblankToggle | 2) >>> 0);
  }
  if ((off == 16913)) {
    return m.timeup;
  }
  if ((off == 16914)) {
    let hb = 0;
    if ((((m.hcounter & 7) >>> 0) < 2)) {
      hb = 64;
    }
    return ((m.vblankToggle | hb) >>> 0);
  }
  if ((off == 16916)) {
    return ((m.rddiv & 255) >>> 0);
  }
  if ((off == 16917)) {
    return ((Math.floor(m.rddiv / 2 ** (8)) & 255) >>> 0);
  }
  if ((off == 16918)) {
    return ((m.rdmpy & 255) >>> 0);
  }
  if ((off == 16919)) {
    return ((Math.floor(m.rdmpy / 2 ** (8)) & 255) >>> 0);
  }
  if ((off == 16920)) {
    return ((m.joy1 & 255) >>> 0);
  }
  if ((off == 16921)) {
    return ((Math.floor(m.joy1 / 2 ** (8)) & 255) >>> 0);
  }
  if ((off == 16922)) {
    return ((m.joy2 & 255) >>> 0);
  }
  if ((off == 16923)) {
    return ((Math.floor(m.joy2 / 2 ** (8)) & 255) >>> 0);
  }
  return Math.trunc(m.mmio[Math.trunc((off - 8192))]);
}

function mmioWrite(m, off, val) {
  if (((off >= 8448) && (off <= 8511))) {
    ppuRegWrite(m.ppu, Math.trunc((off - 8448)), val);
    return;
  }
  if (((off >= 8512) && (off <= 8515))) {
    apuWritePort(m.apuMem, Math.trunc((off - 8512)), val);
    return;
  }
  if ((off == 16907)) {
    m.mmio[Math.trunc((off - 8192))] = (((val & 255) >>> 0) & 0xFF);
    runDMA(m, val);
    return;
  }
  if ((off == 8576)) {
    m.wram[((m.wmadd & 131071) >>> 0)] = (((val & 255) >>> 0) & 0xFF);
    m.wmadd = ((Math.trunc((m.wmadd + 1)) & 131071) >>> 0);
    return;
  }
  if ((off == 8577)) {
    m.wmadd = ((((m.wmadd & 130816) >>> 0) | val) >>> 0);
    return;
  }
  if ((off == 8578)) {
    m.wmadd = ((((m.wmadd & 65791) >>> 0) | ((val << 8) >>> 0)) >>> 0);
    return;
  }
  if ((off == 8579)) {
    m.wmadd = ((((m.wmadd & 65535) >>> 0) | ((((val & 1) >>> 0) << 16) >>> 0)) >>> 0);
    return;
  }
  if ((off == 16896)) {
    m.nmitimen = val;
    return;
  }
  if ((off == 16898)) {
    m.wrmpya = val;
    return;
  }
  if ((off == 16899)) {
    m.rdmpy = ((Math.trunc((m.wrmpya * val)) & 65535) >>> 0);
    return;
  }
  if ((off == 16900)) {
    m.wrdiv = ((((m.wrdiv & 65280) >>> 0) | val) >>> 0);
    return;
  }
  if ((off == 16901)) {
    m.wrdiv = ((((m.wrdiv & 255) >>> 0) | ((val << 8) >>> 0)) >>> 0);
    return;
  }
  if ((off == 16902)) {
    if ((val == 0)) {
      m.rddiv = 65535;
      m.rdmpy = m.wrdiv;
    } else {
      m.rddiv = ((Math.trunc(Math.trunc(m.wrdiv / val)) & 65535) >>> 0);
      m.rdmpy = (((m.wrdiv % val) & 65535) >>> 0);
    }
    return;
  }
  if ((off == 16903)) {
    m.htime = ((((m.htime & 256) >>> 0) | val) >>> 0);
    return;
  }
  if ((off == 16904)) {
    m.htime = ((((((val & 1) >>> 0) << 8) >>> 0) | ((m.htime & 255) >>> 0)) >>> 0);
    return;
  }
  if ((off == 16905)) {
    m.vtime = ((((m.vtime & 256) >>> 0) | val) >>> 0);
    return;
  }
  if ((off == 16906)) {
    m.vtime = ((((((val & 1) >>> 0) << 8) >>> 0) | ((m.vtime & 255) >>> 0)) >>> 0);
    return;
  }
  m.mmio[Math.trunc((off - 8192))] = (((val & 255) >>> 0) & 0xFF);
}

function memReset(m) {
  m.addr = [];
  m.val = [];
}

function romOffset(m, bank, off) {
  if ((m.mapMode == 1)) {
    return ((((((((bank & 63) >>> 0) << 16) >>> 0) | off) >>> 0) & m.romMask) >>> 0);
  }
  return ((((((((bank & 127) >>> 0) << 15) >>> 0) | ((off & 32767) >>> 0)) >>> 0) & m.romMask) >>> 0);
}

function romByte(m, bank, off) {
  const o = romOffset(m, bank, off);
  if ((o < m.rom.length)) {
    return Math.trunc(m.rom[o]);
  }
  return 0;
}

function sramIndex(m, bank, off) {
  const b = ((bank & 127) >>> 0);
  if ((m.mapMode == 0)) {
    if ((((b >= 112) && (b <= 125)) && (off < 32768))) {
      return ((((((Math.trunc((b - 112)) << 15) >>> 0) | off) >>> 0) & m.sramMask) >>> 0);
    }
    return (-1);
  }
  if (((((b >= 32) && (b <= 63)) && (off >= 24576)) && (off < 32768))) {
    return ((((((Math.trunc((b - 32)) << 13) >>> 0) | Math.trunc((off - 24576))) >>> 0) & m.sramMask) >>> 0);
  }
  return (-1);
}

function sramToString(m) {
  let s = "";
  for (const b of m.sram) {
    (s += String.fromCharCode(b));
  }
  return s;
}

function sramFromString(m, data) {
  let i = 0;
  while (((i < m.sram.length) && (i < data.length))) {
    m.sram[i] = data.charCodeAt(i);
    i = Math.trunc((i + 1));
  }
}

function memRead(m, a) {
  if (m.testMode) {
    let i = 0;
    while ((i < m.addr.length)) {
      if ((m.addr[i] == a)) {
        return m.val[i];
      }
      i = Math.trunc((i + 1));
    }
    return 0;
  }
  const bank = ((Math.floor(a / 2 ** (16)) & 255) >>> 0);
  const off = ((a & 65535) >>> 0);
  if ((bank == 126)) {
    return Math.trunc(m.wram[off]);
  }
  if ((bank == 127)) {
    return Math.trunc(m.wram[Math.trunc((65536 + off))]);
  }
  const si = sramIndex(m, bank, off);
  if ((si >= 0)) {
    return Math.trunc(m.sram[si]);
  }
  const b = ((bank & 127) >>> 0);
  if ((b <= 63)) {
    if ((off < 8192)) {
      return Math.trunc(m.wram[off]);
    }
    if ((off < 24576)) {
      return mmioRead(m, off);
    }
    if ((off < 32768)) {
      return 0;
    }
    return romByte(m, bank, off);
  }
  return romByte(m, bank, off);
}

function memWrite(m, a, v) {
  if (m.testMode) {
    let i = 0;
    while ((i < m.addr.length)) {
      if ((m.addr[i] == a)) {
        m.val[i] = ((v & 255) >>> 0);
        return;
      }
      i = Math.trunc((i + 1));
    }
    m.addr.push(a);
    m.val.push(((v & 255) >>> 0));
    return;
  }
  const bank = ((Math.floor(a / 2 ** (16)) & 255) >>> 0);
  const off = ((a & 65535) >>> 0);
  const bv = (((v & 255) >>> 0) & 0xFF);
  if ((bank == 126)) {
    m.wram[off] = bv;
    return;
  }
  if ((bank == 127)) {
    m.wram[Math.trunc((65536 + off))] = bv;
    return;
  }
  const si = sramIndex(m, bank, off);
  if ((si >= 0)) {
    m.sram[si] = bv;
    return;
  }
  const b = ((bank & 127) >>> 0);
  if ((b <= 63)) {
    if ((off < 8192)) {
      m.wram[off] = bv;
      return;
    }
    if ((off < 24576)) {
      mmioWrite(m, off, v);
      return;
    }
    return;
  }
}

function newCpuReset(m) {
  const lo = memRead(m, 65532);
  const hi = memRead(m, 65533);
  return new Cpu(0, 0, 0, 511, 0, ((lo | ((hi << 8) >>> 0)) >>> 0), 52, 0, 0, 1);
}

function nmi(cpu, m) {
  if ((cpu.e == 0)) {
    push8(cpu, m, cpu.pbr);
    push16(cpu, m, cpu.pc);
    push8(cpu, m, cpu.p);
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    cpu.pc = ((memRead(m, 65514) | ((memRead(m, 65515) << 8) >>> 0)) >>> 0);
  } else {
    push16(cpu, m, cpu.pc);
    push8(cpu, m, ((cpu.p & (~16)) >>> 0));
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    cpu.pc = ((memRead(m, 65530) | ((memRead(m, 65531) << 8) >>> 0)) >>> 0);
  }
}

function irq(cpu, m) {
  if ((cpu.e == 0)) {
    push8(cpu, m, cpu.pbr);
    push16(cpu, m, cpu.pc);
    push8(cpu, m, cpu.p);
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    cpu.pc = ((memRead(m, 65518) | ((memRead(m, 65519) << 8) >>> 0)) >>> 0);
  } else {
    push16(cpu, m, cpu.pc);
    push8(cpu, m, ((cpu.p & (~16)) >>> 0));
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    cpu.pc = ((memRead(m, 65534) | ((memRead(m, 65535) << 8) >>> 0)) >>> 0);
  }
}

function maybeIrq(cpu, m) {
  if ((((m.nmitimen & 48) >>> 0) == 0)) {
    return;
  }
  m.timeup = 128;
  if ((((cpu.p & FI) >>> 0) == 0)) {
    irq(cpu, m);
  }
}

function stepFrame(cpu, m) {
  m.timeup = 0;
  let irqAt = (-1);
  if ((((m.nmitimen & 48) >>> 0) != 0)) {
    let vt = m.vtime;
    if ((vt > 224)) {
      vt = 224;
    }
    irqAt = Math.trunc(Math.trunc(Math.trunc((vt * 7600)) / 224));
  }
  let fired = false;
  let i = 0;
  while ((i < 7600)) {
    if ((((!fired) && (irqAt >= 0)) && (i >= irqAt))) {
      maybeIrq(cpu, m);
      fired = true;
    }
    step(cpu, m);
    if ((((i & 3) >>> 0) == 0)) {
      runApu(m, 2);
    }
    i = Math.trunc((i + 1));
  }
  hdmaWalkFrame(m);
  m.vblankToggle = 128;
  if ((((m.nmitimen & 128) >>> 0) != 0)) {
    nmi(cpu, m);
  }
  i = 0;
  while ((i < 1400)) {
    step(cpu, m);
    if ((((i & 3) >>> 0) == 0)) {
      runApu(m, 2);
    }
    i = Math.trunc((i + 1));
  }
  m.vblankToggle = 0;
}

function m8(cpu) {
  return ((cpu.e == 1) || (((cpu.p & FM) >>> 0) != 0));
}

function x8(cpu) {
  return ((cpu.e == 1) || (((cpu.p & FX) >>> 0) != 0));
}

function setBit(cpu, mask, on) {
  if (on) {
    cpu.p = ((cpu.p | mask) >>> 0);
  } else {
    cpu.p = ((cpu.p & (~mask)) >>> 0);
  }
}

function setNZ8(cpu, v) {
  setBit(cpu, FZ, (((v & 255) >>> 0) == 0));
  setBit(cpu, FN, (((v & 128) >>> 0) != 0));
}

function setNZ16(cpu, v) {
  setBit(cpu, FZ, (((v & 65535) >>> 0) == 0));
  setBit(cpu, FN, (((v & 32768) >>> 0) != 0));
}

function setNZa(cpu, v) {
  if (m8(cpu)) {
    setNZ8(cpu, v);
  } else {
    setNZ16(cpu, v);
  }
}

function setNZx(cpu, v) {
  if (x8(cpu)) {
    setNZ8(cpu, v);
  } else {
    setNZ16(cpu, v);
  }
}

function fetch8(cpu, m) {
  const a = ((((cpu.pbr << 16) >>> 0) | cpu.pc) >>> 0);
  const v = memRead(m, a);
  cpu.pc = ((Math.trunc((cpu.pc + 1)) & 65535) >>> 0);
  return v;
}

function applyEmulationConstraints(cpu) {
  if ((cpu.e == 1)) {
    cpu.p = ((((cpu.p | FM) >>> 0) | FX) >>> 0);
    cpu.x = ((cpu.x & 255) >>> 0);
    cpu.y = ((cpu.y & 255) >>> 0);
    cpu.s = ((256 | ((cpu.s & 255) >>> 0)) >>> 0);
  }
}

function spDec(cpu) {
  if ((cpu.e == 1)) {
    cpu.s = ((256 | ((Math.trunc((cpu.s - 1)) & 255) >>> 0)) >>> 0);
  } else {
    cpu.s = ((Math.trunc((cpu.s - 1)) & 65535) >>> 0);
  }
}

function spInc(cpu) {
  if ((cpu.e == 1)) {
    cpu.s = ((256 | ((Math.trunc((cpu.s + 1)) & 255) >>> 0)) >>> 0);
  } else {
    cpu.s = ((Math.trunc((cpu.s + 1)) & 65535) >>> 0);
  }
}

function push8(cpu, m, v) {
  memWrite(m, cpu.s, ((v & 255) >>> 0));
  spDec(cpu);
}

function pull8(cpu, m) {
  spInc(cpu);
  return memRead(m, cpu.s);
}

function push16(cpu, m, v) {
  push8(cpu, m, ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
  push8(cpu, m, ((v & 255) >>> 0));
}

function pull16(cpu, m) {
  const lo = pull8(cpu, m);
  const hi = pull8(cpu, m);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function fetch16(cpu, m) {
  const lo = fetch8(cpu, m);
  const hi = fetch8(cpu, m);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function push8f(cpu, m, v) {
  memWrite(m, cpu.s, ((v & 255) >>> 0));
  cpu.s = ((Math.trunc((cpu.s - 1)) & 65535) >>> 0);
}

function pull8f(cpu, m) {
  cpu.s = ((Math.trunc((cpu.s + 1)) & 65535) >>> 0);
  return memRead(m, cpu.s);
}

function push16f(cpu, m, v) {
  push8f(cpu, m, ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
  push8f(cpu, m, ((v & 255) >>> 0));
}

function pull16f(cpu, m) {
  const lo = pull8f(cpu, m);
  const hi = pull8f(cpu, m);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function clampEmuStack(cpu) {
  if ((cpu.e == 1)) {
    cpu.s = ((256 | ((cpu.s & 255) >>> 0)) >>> 0);
  }
}

function fetch24(cpu, m) {
  const lo = fetch8(cpu, m);
  const mid = fetch8(cpu, m);
  const hi = fetch8(cpu, m);
  return ((((lo | ((mid << 8) >>> 0)) >>> 0) | ((hi << 16) >>> 0)) >>> 0);
}

function aDp(cpu, m) {
  return ((Math.trunc((cpu.d + fetch8(cpu, m))) & 65535) >>> 0);
}

function dpIndexed(cpu, dp, idx) {
  if (((cpu.e == 1) && (((cpu.d & 255) >>> 0) == 0))) {
    return ((((cpu.d & 65280) >>> 0) | ((Math.trunc((dp + idx)) & 255) >>> 0)) >>> 0);
  }
  return ((Math.trunc((Math.trunc((cpu.d + dp)) + idx)) & 65535) >>> 0);
}

function aDpX(cpu, m) {
  return dpIndexed(cpu, fetch8(cpu, m), cpu.x);
}

function aDpY(cpu, m) {
  return dpIndexed(cpu, fetch8(cpu, m), cpu.y);
}

function aAbs(cpu, m) {
  return ((((cpu.dbr << 16) >>> 0) | fetch16(cpu, m)) >>> 0);
}

function aAbsX(cpu, m) {
  return ((Math.trunc((((((cpu.dbr << 16) >>> 0) | fetch16(cpu, m)) >>> 0) + cpu.x)) & 16777215) >>> 0);
}

function aAbsY(cpu, m) {
  return ((Math.trunc((((((cpu.dbr << 16) >>> 0) | fetch16(cpu, m)) >>> 0) + cpu.y)) & 16777215) >>> 0);
}

function aLong(cpu, m) {
  return fetch24(cpu, m);
}

function aLongX(cpu, m) {
  return ((Math.trunc((fetch24(cpu, m) + cpu.x)) & 16777215) >>> 0);
}

function readPtr16(m, addr) {
  const lo = memRead(m, ((addr & 65535) >>> 0));
  const hi = memRead(m, ((Math.trunc((addr + 1)) & 65535) >>> 0));
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function readPtr24(m, addr) {
  const lo = memRead(m, ((addr & 65535) >>> 0));
  const mid = memRead(m, ((Math.trunc((addr + 1)) & 65535) >>> 0));
  const hi = memRead(m, ((Math.trunc((addr + 2)) & 65535) >>> 0));
  return ((((lo | ((mid << 8) >>> 0)) >>> 0) | ((hi << 16) >>> 0)) >>> 0);
}

function aDpIndX(cpu, m) {
  const ptr = readPtr16(m, dpIndexed(cpu, fetch8(cpu, m), cpu.x));
  return ((((cpu.dbr << 16) >>> 0) | ptr) >>> 0);
}

function aDpIndY(cpu, m) {
  const ptr = readPtr16(m, ((Math.trunc((cpu.d + fetch8(cpu, m))) & 65535) >>> 0));
  return ((Math.trunc((((((cpu.dbr << 16) >>> 0) | ptr) >>> 0) + cpu.y)) & 16777215) >>> 0);
}

function aDpInd(cpu, m) {
  const ptr = readPtr16(m, ((Math.trunc((cpu.d + fetch8(cpu, m))) & 65535) >>> 0));
  return ((((((cpu.dbr << 16) >>> 0) | ptr) >>> 0) & 16777215) >>> 0);
}

function aDpLong(cpu, m) {
  return readPtr24(m, ((Math.trunc((cpu.d + fetch8(cpu, m))) & 65535) >>> 0));
}

function aDpLongY(cpu, m) {
  return ((Math.trunc((readPtr24(m, ((Math.trunc((cpu.d + fetch8(cpu, m))) & 65535) >>> 0)) + cpu.y)) & 16777215) >>> 0);
}

function aSr(cpu, m) {
  return ((Math.trunc((cpu.s + fetch8(cpu, m))) & 65535) >>> 0);
}

function aSrY(cpu, m) {
  const ptr = readPtr16(m, ((Math.trunc((cpu.s + fetch8(cpu, m))) & 65535) >>> 0));
  return ((Math.trunc((((((cpu.dbr << 16) >>> 0) | ptr) >>> 0) + cpu.y)) & 16777215) >>> 0);
}

function read16w(m, addr, bank0wrap) {
  const lo = memRead(m, addr);
  const hiAddr = (() => {
  if (bank0wrap) {
    return ((((addr & 16711680) >>> 0) | ((Math.trunc((addr + 1)) & 65535) >>> 0)) >>> 0);
  } else {
    return ((Math.trunc((addr + 1)) & 16777215) >>> 0);
  }
  })();
  const hi = memRead(m, hiAddr);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function write16w(m, addr, v, bank0wrap) {
  memWrite(m, addr, ((v & 255) >>> 0));
  const hiAddr = (() => {
  if (bank0wrap) {
    return ((((addr & 16711680) >>> 0) | ((Math.trunc((addr + 1)) & 65535) >>> 0)) >>> 0);
  } else {
    return ((Math.trunc((addr + 1)) & 16777215) >>> 0);
  }
  })();
  memWrite(m, hiAddr, ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
}

function staTo(cpu, m, addr, bank0wrap) {
  if (m8(cpu)) {
    memWrite(m, addr, ((cpu.a & 255) >>> 0));
  } else {
    write16w(m, addr, cpu.a, bank0wrap);
  }
}

function ldaFrom(cpu, m, addr, bank0wrap) {
  if (m8(cpu)) {
    const v = memRead(m, addr);
    cpu.a = ((((cpu.a & 65280) >>> 0) | v) >>> 0);
    setNZ8(cpu, v);
  } else {
    const v = read16w(m, addr, bank0wrap);
    cpu.a = v;
    setNZ16(cpu, v);
  }
}

function readMval(cpu, m, addr, bank0wrap) {
  if (m8(cpu)) {
    return memRead(m, addr);
  }
  return read16w(m, addr, bank0wrap);
}

function readXval(cpu, m, addr, bank0wrap) {
  if (x8(cpu)) {
    return memRead(m, addr);
  }
  return read16w(m, addr, bank0wrap);
}

function immM(cpu, m) {
  if (m8(cpu)) {
    return fetch8(cpu, m);
  }
  return fetch16(cpu, m);
}

function immX(cpu, m) {
  if (x8(cpu)) {
    return fetch8(cpu, m);
  }
  return fetch16(cpu, m);
}

function setA(cpu, r) {
  if (m8(cpu)) {
    cpu.a = ((((cpu.a & 65280) >>> 0) | ((r & 255) >>> 0)) >>> 0);
    setNZ8(cpu, r);
  } else {
    cpu.a = ((r & 65535) >>> 0);
    setNZ16(cpu, r);
  }
}

function setXreg(cpu, r) {
  if (x8(cpu)) {
    cpu.x = ((r & 255) >>> 0);
    setNZ8(cpu, r);
  } else {
    cpu.x = ((r & 65535) >>> 0);
    setNZ16(cpu, r);
  }
}

function setYreg(cpu, r) {
  if (x8(cpu)) {
    cpu.y = ((r & 255) >>> 0);
    setNZ8(cpu, r);
  } else {
    cpu.y = ((r & 65535) >>> 0);
    setNZ16(cpu, r);
  }
}

function compareVals(cpu, reg, v, wide) {
  const mask = (() => {
  if (wide) {
    return 65535;
  } else {
    return 255;
  }
  })();
  const signbit = (() => {
  if (wide) {
    return 32768;
  } else {
    return 128;
  }
  })();
  const a = ((reg & mask) >>> 0);
  const b = ((v & mask) >>> 0);
  setBit(cpu, FC, (a >= b));
  const r = ((Math.trunc((a - b)) & mask) >>> 0);
  setBit(cpu, FZ, (r == 0));
  setBit(cpu, FN, (((r & signbit) >>> 0) != 0));
}

function oraFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  setA(cpu, ((cpu.a | v) >>> 0));
}

function andFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  setA(cpu, ((cpu.a & v) >>> 0));
}

function eorFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  setA(cpu, ((cpu.a ^ v) >>> 0));
}

function cmpFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  compareVals(cpu, cpu.a, v, (!m8(cpu)));
}

function cpxFrom(cpu, m, addr, wrap) {
  const v = readXval(cpu, m, addr, wrap);
  compareVals(cpu, cpu.x, v, (!x8(cpu)));
}

function cpyFrom(cpu, m, addr, wrap) {
  const v = readXval(cpu, m, addr, wrap);
  compareVals(cpu, cpu.y, v, (!x8(cpu)));
}

function ldxFrom(cpu, m, addr, wrap) {
  const v = readXval(cpu, m, addr, wrap);
  setXreg(cpu, v);
}

function ldyFrom(cpu, m, addr, wrap) {
  const v = readXval(cpu, m, addr, wrap);
  setYreg(cpu, v);
}

function stxTo(cpu, m, addr, wrap) {
  if (x8(cpu)) {
    memWrite(m, addr, ((cpu.x & 255) >>> 0));
  } else {
    write16w(m, addr, cpu.x, wrap);
  }
}

function styTo(cpu, m, addr, wrap) {
  if (x8(cpu)) {
    memWrite(m, addr, ((cpu.y & 255) >>> 0));
  } else {
    write16w(m, addr, cpu.y, wrap);
  }
}

function stzTo(cpu, m, addr, wrap) {
  if (m8(cpu)) {
    memWrite(m, addr, 0);
  } else {
    write16w(m, addr, 0, wrap);
  }
}

function doADC(cpu, v) {
  const wide = (!m8(cpu));
  const mask = (() => {
  if (wide) {
    return 65535;
  } else {
    return 255;
  }
  })();
  const signbit = (() => {
  if (wide) {
    return 32768;
  } else {
    return 128;
  }
  })();
  const carrybit = (() => {
  if (wide) {
    return 65536;
  } else {
    return 256;
  }
  })();
  const a = ((cpu.a & mask) >>> 0);
  const b = ((v & mask) >>> 0);
  const c = ((cpu.p & FC) >>> 0);
  if ((((cpu.p & FD) >>> 0) != 0)) {
    const nib = (() => {
    if (wide) {
      return 4;
    } else {
      return 2;
    }
    })();
    let carry = c;
    let r = 0;
    let sTop = 0;
    let i = 0;
    while ((i < nib)) {
      const sh = Math.trunc((i * 4));
      let d = Math.trunc((Math.trunc((((Math.floor(a / 2 ** (sh)) & 15) >>> 0) + ((Math.floor(b / 2 ** (sh)) & 15) >>> 0))) + carry));
      if ((i == Math.trunc((nib - 1)))) {
        sTop = d;
      }
      if ((d >= 10)) {
        d = ((Math.trunc((d + 6)) & 15) >>> 0);
        carry = 1;
      } else {
        carry = 0;
      }
      r = ((r | ((d << sh) >>> 0)) >>> 0);
      i = Math.trunc((i + 1));
    }
    const topsh = Math.trunc((Math.trunc((nib - 1)) * 4));
    const sV = ((((r & Math.trunc((((1 << topsh) >>> 0) - 1))) >>> 0) | ((sTop << topsh) >>> 0)) >>> 0);
    setBit(cpu, FV, ((((((~((a ^ b) >>> 0)) & ((a ^ sV) >>> 0)) >>> 0) & signbit) >>> 0) != 0));
    setBit(cpu, FC, (carry != 0));
    const rr = ((r & mask) >>> 0);
    setBit(cpu, FN, (((rr & signbit) >>> 0) != 0));
    setBit(cpu, FZ, (rr == 0));
    if (wide) {
      cpu.a = rr;
    } else {
      cpu.a = ((((cpu.a & 65280) >>> 0) | rr) >>> 0);
    }
  } else {
    const sum = Math.trunc((Math.trunc((a + b)) + c));
    const r = ((sum & mask) >>> 0);
    setBit(cpu, FC, (sum >= carrybit));
    setBit(cpu, FV, (((((((a ^ r) >>> 0) & ((b ^ r) >>> 0)) >>> 0) & signbit) >>> 0) != 0));
    setBit(cpu, FZ, (r == 0));
    setBit(cpu, FN, (((r & signbit) >>> 0) != 0));
    if (wide) {
      cpu.a = r;
    } else {
      cpu.a = ((((cpu.a & 65280) >>> 0) | r) >>> 0);
    }
  }
}

function doSBC(cpu, v) {
  const wide = (!m8(cpu));
  const mask = (() => {
  if (wide) {
    return 65535;
  } else {
    return 255;
  }
  })();
  const signbit = (() => {
  if (wide) {
    return 32768;
  } else {
    return 128;
  }
  })();
  const carrybit = (() => {
  if (wide) {
    return 65536;
  } else {
    return 256;
  }
  })();
  const a = ((cpu.a & mask) >>> 0);
  const b = ((v & mask) >>> 0);
  const c = ((cpu.p & FC) >>> 0);
  const comp = ((b ^ mask) >>> 0);
  const sum = Math.trunc((Math.trunc((a + comp)) + c));
  const rbin = ((sum & mask) >>> 0);
  setBit(cpu, FC, (sum >= carrybit));
  setBit(cpu, FV, (((((((a ^ rbin) >>> 0) & ((comp ^ rbin) >>> 0)) >>> 0) & signbit) >>> 0) != 0));
  setBit(cpu, FN, (((rbin & signbit) >>> 0) != 0));
  setBit(cpu, FZ, (rbin == 0));
  let r = rbin;
  if ((((cpu.p & FD) >>> 0) != 0)) {
    const nib = (() => {
    if (wide) {
      return 4;
    } else {
      return 2;
    }
    })();
    let borrow = Math.trunc((1 - c));
    let dr = 0;
    let i = 0;
    while ((i < nib)) {
      const sh = Math.trunc((i * 4));
      let d = Math.trunc((Math.trunc((((Math.floor(a / 2 ** (sh)) & 15) >>> 0) - ((Math.floor(b / 2 ** (sh)) & 15) >>> 0))) - borrow));
      if ((d < 0)) {
        d = ((Math.trunc((d - 6)) & 15) >>> 0);
        borrow = 1;
      } else {
        d = ((d & 15) >>> 0);
        borrow = 0;
      }
      dr = ((dr | ((d << sh) >>> 0)) >>> 0);
      i = Math.trunc((i + 1));
    }
    r = ((dr & mask) >>> 0);
    setBit(cpu, FN, (((r & signbit) >>> 0) != 0));
    setBit(cpu, FZ, (r == 0));
  }
  if (wide) {
    cpu.a = r;
  } else {
    cpu.a = ((((cpu.a & 65280) >>> 0) | r) >>> 0);
  }
}

function adcFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  doADC(cpu, v);
}

function sbcFrom(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  doSBC(cpu, v);
}

function accMask(cpu) {
  if (m8(cpu)) {
    return 255;
  }
  return 65535;
}

function aslVal(cpu, v) {
  const mask = accMask(cpu);
  const signbit = (() => {
  if (m8(cpu)) {
    return 128;
  } else {
    return 32768;
  }
  })();
  setBit(cpu, FC, (((v & signbit) >>> 0) != 0));
  const r = ((((v << 1) >>> 0) & mask) >>> 0);
  setNZa(cpu, r);
  return r;
}

function lsrVal(cpu, v) {
  const mask = accMask(cpu);
  setBit(cpu, FC, (((v & 1) >>> 0) != 0));
  const r = Math.floor(((v & mask) >>> 0) / 2 ** (1));
  setNZa(cpu, r);
  return r;
}

function rolVal(cpu, v) {
  const mask = accMask(cpu);
  const signbit = (() => {
  if (m8(cpu)) {
    return 128;
  } else {
    return 32768;
  }
  })();
  const oldC = ((cpu.p & FC) >>> 0);
  setBit(cpu, FC, (((v & signbit) >>> 0) != 0));
  const r = ((((((v << 1) >>> 0) | oldC) >>> 0) & mask) >>> 0);
  setNZa(cpu, r);
  return r;
}

function rorVal(cpu, v) {
  const mask = accMask(cpu);
  const topbit = (() => {
  if (m8(cpu)) {
    return 128;
  } else {
    return 32768;
  }
  })();
  const oldC = ((cpu.p & FC) >>> 0);
  setBit(cpu, FC, (((v & 1) >>> 0) != 0));
  let r = Math.floor(((v & mask) >>> 0) / 2 ** (1));
  if ((oldC != 0)) {
    r = ((r | topbit) >>> 0);
  }
  setNZa(cpu, r);
  return r;
}

function incVal(cpu, v) {
  const mask = accMask(cpu);
  const r = ((Math.trunc((v + 1)) & mask) >>> 0);
  setNZa(cpu, r);
  return r;
}

function decVal(cpu, v) {
  const mask = accMask(cpu);
  const r = ((Math.trunc((v - 1)) & mask) >>> 0);
  setNZa(cpu, r);
  return r;
}

function writeAccW(cpu, r) {
  if (m8(cpu)) {
    cpu.a = ((((cpu.a & 65280) >>> 0) | ((r & 255) >>> 0)) >>> 0);
  } else {
    cpu.a = ((r & 65535) >>> 0);
  }
}

function accASL(cpu) {
  const v = ((cpu.a & accMask(cpu)) >>> 0);
  const r = aslVal(cpu, v);
  writeAccW(cpu, r);
}

function accLSR(cpu) {
  const v = ((cpu.a & accMask(cpu)) >>> 0);
  const r = lsrVal(cpu, v);
  writeAccW(cpu, r);
}

function accROL(cpu) {
  const v = ((cpu.a & accMask(cpu)) >>> 0);
  const r = rolVal(cpu, v);
  writeAccW(cpu, r);
}

function accROR(cpu) {
  const v = ((cpu.a & accMask(cpu)) >>> 0);
  const r = rorVal(cpu, v);
  writeAccW(cpu, r);
}

function rmwWrite(cpu, m, addr, wrap, r) {
  if (m8(cpu)) {
    memWrite(m, addr, ((r & 255) >>> 0));
  } else {
    write16w(m, addr, r, wrap);
  }
}

function rmwMem(cpu, m, addr, wrap, kind) {
  const v = readMval(cpu, m, addr, wrap);
  let r = 0;
  if ((kind == 0)) {
    r = aslVal(cpu, v);
  } else {
    if ((kind == 1)) {
      r = lsrVal(cpu, v);
    } else {
      if ((kind == 2)) {
        r = rolVal(cpu, v);
      } else {
        if ((kind == 3)) {
          r = rorVal(cpu, v);
        } else {
          if ((kind == 4)) {
            r = incVal(cpu, v);
          } else {
            r = decVal(cpu, v);
          }
        }
      }
    }
  }
  rmwWrite(cpu, m, addr, wrap, r);
}

function tsbMem(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  const a = ((cpu.a & accMask(cpu)) >>> 0);
  setBit(cpu, FZ, (((a & v) >>> 0) == 0));
  rmwWrite(cpu, m, addr, wrap, ((v | a) >>> 0));
}

function trbMem(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  const a = ((cpu.a & accMask(cpu)) >>> 0);
  setBit(cpu, FZ, (((a & v) >>> 0) == 0));
  rmwWrite(cpu, m, addr, wrap, ((v & (~a)) >>> 0));
}

function bitMem(cpu, m, addr, wrap) {
  const v = readMval(cpu, m, addr, wrap);
  const signbit = (() => {
  if (m8(cpu)) {
    return 128;
  } else {
    return 32768;
  }
  })();
  const ovbit = (() => {
  if (m8(cpu)) {
    return 64;
  } else {
    return 16384;
  }
  })();
  setBit(cpu, FZ, (((((cpu.a & accMask(cpu)) >>> 0) & v) >>> 0) == 0));
  setBit(cpu, FN, (((v & signbit) >>> 0) != 0));
  setBit(cpu, FV, (((v & ovbit) >>> 0) != 0));
}

function bitImm(cpu, v) {
  setBit(cpu, FZ, (((((cpu.a & accMask(cpu)) >>> 0) & v) >>> 0) == 0));
}

function branchIf(cpu, m, cond) {
  const off = fetch8(cpu, m);
  const soff = (() => {
  if ((off >= 128)) {
    return Math.trunc((off - 256));
  } else {
    return off;
  }
  })();
  if (cond) {
    cpu.pc = ((Math.trunc((cpu.pc + soff)) & 65535) >>> 0);
  }
}

function softInterrupt(cpu, m, nativeVec, emuVec) {
  const ret = ((Math.trunc((cpu.pc + 1)) & 65535) >>> 0);
  if ((cpu.e == 0)) {
    push8(cpu, m, cpu.pbr);
    push16(cpu, m, ret);
    push8(cpu, m, cpu.p);
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    const lo = memRead(m, nativeVec);
    const hi = memRead(m, Math.trunc((nativeVec + 1)));
    cpu.pc = ((lo | ((hi << 8) >>> 0)) >>> 0);
  } else {
    push16(cpu, m, ret);
    push8(cpu, m, ((cpu.p | 16) >>> 0));
    setBit(cpu, FI, true);
    setBit(cpu, FD, false);
    cpu.pbr = 0;
    const lo = memRead(m, emuVec);
    const hi = memRead(m, Math.trunc((emuVec + 1)));
    cpu.pc = ((lo | ((hi << 8) >>> 0)) >>> 0);
  }
}

function blockMove(cpu, m, dir) {
  const destbank = fetch8(cpu, m);
  const srcbank = fetch8(cpu, m);
  cpu.dbr = destbank;
  let guard = 0;
  while (true) {
    const v = memRead(m, ((((srcbank << 16) >>> 0) | ((cpu.x & 65535) >>> 0)) >>> 0));
    memWrite(m, ((((destbank << 16) >>> 0) | ((cpu.y & 65535) >>> 0)) >>> 0), v);
    if (x8(cpu)) {
      cpu.x = ((Math.trunc((cpu.x + dir)) & 255) >>> 0);
      cpu.y = ((Math.trunc((cpu.y + dir)) & 255) >>> 0);
    } else {
      cpu.x = ((Math.trunc((cpu.x + dir)) & 65535) >>> 0);
      cpu.y = ((Math.trunc((cpu.y + dir)) & 65535) >>> 0);
    }
    const last = (cpu.a == 0);
    cpu.a = ((Math.trunc((cpu.a - 1)) & 65535) >>> 0);
    if (last) {
      break;
    }
    guard = Math.trunc((guard + 1));
    if ((guard > 65536)) {
      break;
    }
  }
}

function step(cpu, m) {
  m.hcounter = Math.trunc((m.hcounter + 1));
  const op = fetch8(cpu, m);
  const _t1 = op;
  if (_t1 === 234) {
  } else if (_t1 === 24) {
    setBit(cpu, FC, false);
  } else if (_t1 === 56) {
    setBit(cpu, FC, true);
  } else if (_t1 === 88) {
    setBit(cpu, FI, false);
  } else if (_t1 === 120) {
    setBit(cpu, FI, true);
  } else if (_t1 === 184) {
    setBit(cpu, FV, false);
  } else if (_t1 === 216) {
    setBit(cpu, FD, false);
  } else if (_t1 === 248) {
    setBit(cpu, FD, true);
  } else if (_t1 === 251) {
    const oldC = ((cpu.p & FC) >>> 0);
    const oldE = cpu.e;
    cpu.e = oldC;
    setBit(cpu, FC, (oldE != 0));
    applyEmulationConstraints(cpu);
  } else if (_t1 === 194) {
    const mask = fetch8(cpu, m);
    cpu.p = ((cpu.p & (~mask)) >>> 0);
    applyEmulationConstraints(cpu);
  } else if (_t1 === 226) {
    const mask = fetch8(cpu, m);
    cpu.p = ((cpu.p | mask) >>> 0);
    if ((((cpu.p & FX) >>> 0) != 0)) {
      cpu.x = ((cpu.x & 255) >>> 0);
      cpu.y = ((cpu.y & 255) >>> 0);
    }
  } else if (_t1 === 170) {
    const v = (() => {
    if (x8(cpu)) {
      return ((cpu.a & 255) >>> 0);
    } else {
      return ((cpu.a & 65535) >>> 0);
    }
    })();
    cpu.x = v;
    setNZx(cpu, v);
  } else if (_t1 === 168) {
    const v = (() => {
    if (x8(cpu)) {
      return ((cpu.a & 255) >>> 0);
    } else {
      return ((cpu.a & 65535) >>> 0);
    }
    })();
    cpu.y = v;
    setNZx(cpu, v);
  } else if (_t1 === 138) {
    if (m8(cpu)) {
      cpu.a = ((((cpu.a & 65280) >>> 0) | ((cpu.x & 255) >>> 0)) >>> 0);
      setNZ8(cpu, cpu.x);
    } else {
      cpu.a = ((cpu.x & 65535) >>> 0);
      setNZ16(cpu, cpu.x);
    }
  } else if (_t1 === 152) {
    if (m8(cpu)) {
      cpu.a = ((((cpu.a & 65280) >>> 0) | ((cpu.y & 255) >>> 0)) >>> 0);
      setNZ8(cpu, cpu.y);
    } else {
      cpu.a = ((cpu.y & 65535) >>> 0);
      setNZ16(cpu, cpu.y);
    }
  } else if (_t1 === 186) {
    const v = (() => {
    if (x8(cpu)) {
      return ((cpu.s & 255) >>> 0);
    } else {
      return ((cpu.s & 65535) >>> 0);
    }
    })();
    cpu.x = v;
    setNZx(cpu, v);
  } else if (_t1 === 154) {
    if ((cpu.e == 1)) {
      cpu.s = ((256 | ((cpu.x & 255) >>> 0)) >>> 0);
    } else {
      cpu.s = ((cpu.x & 65535) >>> 0);
    }
  } else if (_t1 === 155) {
    const v = (() => {
    if (x8(cpu)) {
      return ((cpu.x & 255) >>> 0);
    } else {
      return ((cpu.x & 65535) >>> 0);
    }
    })();
    cpu.y = v;
    setNZx(cpu, v);
  } else if (_t1 === 187) {
    const v = (() => {
    if (x8(cpu)) {
      return ((cpu.y & 255) >>> 0);
    } else {
      return ((cpu.y & 65535) >>> 0);
    }
    })();
    cpu.x = v;
    setNZx(cpu, v);
  } else if (_t1 === 27) {
    if ((cpu.e == 1)) {
      cpu.s = ((256 | ((cpu.a & 255) >>> 0)) >>> 0);
    } else {
      cpu.s = ((cpu.a & 65535) >>> 0);
    }
  } else if (_t1 === 59) {
    cpu.a = ((cpu.s & 65535) >>> 0);
    setNZ16(cpu, cpu.a);
  } else if (_t1 === 91) {
    cpu.d = ((cpu.a & 65535) >>> 0);
    setNZ16(cpu, cpu.d);
  } else if (_t1 === 123) {
    cpu.a = ((cpu.d & 65535) >>> 0);
    setNZ16(cpu, cpu.a);
  } else if (_t1 === 235) {
    const lo = ((cpu.a & 255) >>> 0);
    const hi = ((Math.floor(cpu.a / 2 ** (8)) & 255) >>> 0);
    cpu.a = ((((lo << 8) >>> 0) | hi) >>> 0);
    setNZ8(cpu, hi);
  } else if (_t1 === 232) {
    if (x8(cpu)) {
      cpu.x = ((Math.trunc((cpu.x + 1)) & 255) >>> 0);
    } else {
      cpu.x = ((Math.trunc((cpu.x + 1)) & 65535) >>> 0);
    }
    setNZx(cpu, cpu.x);
  } else if (_t1 === 200) {
    if (x8(cpu)) {
      cpu.y = ((Math.trunc((cpu.y + 1)) & 255) >>> 0);
    } else {
      cpu.y = ((Math.trunc((cpu.y + 1)) & 65535) >>> 0);
    }
    setNZx(cpu, cpu.y);
  } else if (_t1 === 202) {
    if (x8(cpu)) {
      cpu.x = ((Math.trunc((cpu.x - 1)) & 255) >>> 0);
    } else {
      cpu.x = ((Math.trunc((cpu.x - 1)) & 65535) >>> 0);
    }
    setNZx(cpu, cpu.x);
  } else if (_t1 === 136) {
    if (x8(cpu)) {
      cpu.y = ((Math.trunc((cpu.y - 1)) & 255) >>> 0);
    } else {
      cpu.y = ((Math.trunc((cpu.y - 1)) & 65535) >>> 0);
    }
    setNZx(cpu, cpu.y);
  } else if (_t1 === 26) {
    if (m8(cpu)) {
      const lo = ((Math.trunc((cpu.a + 1)) & 255) >>> 0);
      cpu.a = ((((cpu.a & 65280) >>> 0) | lo) >>> 0);
      setNZ8(cpu, lo);
    } else {
      cpu.a = ((Math.trunc((cpu.a + 1)) & 65535) >>> 0);
      setNZ16(cpu, cpu.a);
    }
  } else if (_t1 === 58) {
    if (m8(cpu)) {
      const lo = ((Math.trunc((cpu.a - 1)) & 255) >>> 0);
      cpu.a = ((((cpu.a & 65280) >>> 0) | lo) >>> 0);
      setNZ8(cpu, lo);
    } else {
      cpu.a = ((Math.trunc((cpu.a - 1)) & 65535) >>> 0);
      setNZ16(cpu, cpu.a);
    }
  } else if (_t1 === 169) {
    if (m8(cpu)) {
      const v = fetch8(cpu, m);
      cpu.a = ((((cpu.a & 65280) >>> 0) | v) >>> 0);
      setNZ8(cpu, v);
    } else {
      const lo = fetch8(cpu, m);
      const hi = fetch8(cpu, m);
      cpu.a = ((lo | ((hi << 8) >>> 0)) >>> 0);
      setNZ16(cpu, cpu.a);
    }
  } else if (_t1 === 162) {
    if (x8(cpu)) {
      const v = fetch8(cpu, m);
      cpu.x = v;
      setNZ8(cpu, v);
    } else {
      const lo = fetch8(cpu, m);
      const hi = fetch8(cpu, m);
      cpu.x = ((lo | ((hi << 8) >>> 0)) >>> 0);
      setNZ16(cpu, cpu.x);
    }
  } else if (_t1 === 160) {
    if (x8(cpu)) {
      const v = fetch8(cpu, m);
      cpu.y = v;
      setNZ8(cpu, v);
    } else {
      const lo = fetch8(cpu, m);
      const hi = fetch8(cpu, m);
      cpu.y = ((lo | ((hi << 8) >>> 0)) >>> 0);
      setNZ16(cpu, cpu.y);
    }
  } else if (_t1 === 165) {
    ldaFrom(cpu, m, aDp(cpu, m), true);
  } else if (_t1 === 181) {
    ldaFrom(cpu, m, aDpX(cpu, m), true);
  } else if (_t1 === 173) {
    ldaFrom(cpu, m, aAbs(cpu, m), false);
  } else if (_t1 === 189) {
    ldaFrom(cpu, m, aAbsX(cpu, m), false);
  } else if (_t1 === 185) {
    ldaFrom(cpu, m, aAbsY(cpu, m), false);
  } else if (_t1 === 175) {
    ldaFrom(cpu, m, aLong(cpu, m), false);
  } else if (_t1 === 191) {
    ldaFrom(cpu, m, aLongX(cpu, m), false);
  } else if (_t1 === 161) {
    ldaFrom(cpu, m, aDpIndX(cpu, m), false);
  } else if (_t1 === 177) {
    ldaFrom(cpu, m, aDpIndY(cpu, m), false);
  } else if (_t1 === 178) {
    ldaFrom(cpu, m, aDpInd(cpu, m), false);
  } else if (_t1 === 167) {
    ldaFrom(cpu, m, aDpLong(cpu, m), false);
  } else if (_t1 === 183) {
    ldaFrom(cpu, m, aDpLongY(cpu, m), false);
  } else if (_t1 === 163) {
    ldaFrom(cpu, m, aSr(cpu, m), true);
  } else if (_t1 === 179) {
    ldaFrom(cpu, m, aSrY(cpu, m), false);
  } else if (_t1 === 133) {
    const a = aDp(cpu, m);
    staTo(cpu, m, a, true);
  } else if (_t1 === 149) {
    const a = aDpX(cpu, m);
    staTo(cpu, m, a, true);
  } else if (_t1 === 141) {
    const a = aAbs(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 157) {
    const a = aAbsX(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 153) {
    const a = aAbsY(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 143) {
    const a = aLong(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 159) {
    const a = aLongX(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 129) {
    const a = aDpIndX(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 145) {
    const a = aDpIndY(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 146) {
    const a = aDpInd(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 135) {
    const a = aDpLong(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 151) {
    const a = aDpLongY(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 131) {
    const a = aSr(cpu, m);
    staTo(cpu, m, a, true);
  } else if (_t1 === 147) {
    const a = aSrY(cpu, m);
    staTo(cpu, m, a, false);
  } else if (_t1 === 9) {
    const v = immM(cpu, m);
    setA(cpu, ((cpu.a | v) >>> 0));
  } else if (_t1 === 5) {
    const a = aDp(cpu, m);
    oraFrom(cpu, m, a, true);
  } else if (_t1 === 21) {
    const a = aDpX(cpu, m);
    oraFrom(cpu, m, a, true);
  } else if (_t1 === 13) {
    const a = aAbs(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 29) {
    const a = aAbsX(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 25) {
    const a = aAbsY(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 15) {
    const a = aLong(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 31) {
    const a = aLongX(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 1) {
    const a = aDpIndX(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 17) {
    const a = aDpIndY(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 18) {
    const a = aDpInd(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 7) {
    const a = aDpLong(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 23) {
    const a = aDpLongY(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 3) {
    const a = aSr(cpu, m);
    oraFrom(cpu, m, a, true);
  } else if (_t1 === 19) {
    const a = aSrY(cpu, m);
    oraFrom(cpu, m, a, false);
  } else if (_t1 === 41) {
    const v = immM(cpu, m);
    setA(cpu, ((cpu.a & v) >>> 0));
  } else if (_t1 === 37) {
    const a = aDp(cpu, m);
    andFrom(cpu, m, a, true);
  } else if (_t1 === 53) {
    const a = aDpX(cpu, m);
    andFrom(cpu, m, a, true);
  } else if (_t1 === 45) {
    const a = aAbs(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 61) {
    const a = aAbsX(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 57) {
    const a = aAbsY(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 47) {
    const a = aLong(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 63) {
    const a = aLongX(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 33) {
    const a = aDpIndX(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 49) {
    const a = aDpIndY(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 50) {
    const a = aDpInd(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 39) {
    const a = aDpLong(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 55) {
    const a = aDpLongY(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 35) {
    const a = aSr(cpu, m);
    andFrom(cpu, m, a, true);
  } else if (_t1 === 51) {
    const a = aSrY(cpu, m);
    andFrom(cpu, m, a, false);
  } else if (_t1 === 73) {
    const v = immM(cpu, m);
    setA(cpu, ((cpu.a ^ v) >>> 0));
  } else if (_t1 === 69) {
    const a = aDp(cpu, m);
    eorFrom(cpu, m, a, true);
  } else if (_t1 === 85) {
    const a = aDpX(cpu, m);
    eorFrom(cpu, m, a, true);
  } else if (_t1 === 77) {
    const a = aAbs(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 93) {
    const a = aAbsX(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 89) {
    const a = aAbsY(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 79) {
    const a = aLong(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 95) {
    const a = aLongX(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 65) {
    const a = aDpIndX(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 81) {
    const a = aDpIndY(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 82) {
    const a = aDpInd(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 71) {
    const a = aDpLong(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 87) {
    const a = aDpLongY(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 67) {
    const a = aSr(cpu, m);
    eorFrom(cpu, m, a, true);
  } else if (_t1 === 83) {
    const a = aSrY(cpu, m);
    eorFrom(cpu, m, a, false);
  } else if (_t1 === 201) {
    const v = immM(cpu, m);
    compareVals(cpu, cpu.a, v, (!m8(cpu)));
  } else if (_t1 === 197) {
    const a = aDp(cpu, m);
    cmpFrom(cpu, m, a, true);
  } else if (_t1 === 213) {
    const a = aDpX(cpu, m);
    cmpFrom(cpu, m, a, true);
  } else if (_t1 === 205) {
    const a = aAbs(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 221) {
    const a = aAbsX(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 217) {
    const a = aAbsY(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 207) {
    const a = aLong(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 223) {
    const a = aLongX(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 193) {
    const a = aDpIndX(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 209) {
    const a = aDpIndY(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 210) {
    const a = aDpInd(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 199) {
    const a = aDpLong(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 215) {
    const a = aDpLongY(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 195) {
    const a = aSr(cpu, m);
    cmpFrom(cpu, m, a, true);
  } else if (_t1 === 211) {
    const a = aSrY(cpu, m);
    cmpFrom(cpu, m, a, false);
  } else if (_t1 === 224) {
    const v = immX(cpu, m);
    compareVals(cpu, cpu.x, v, (!x8(cpu)));
  } else if (_t1 === 228) {
    const a = aDp(cpu, m);
    cpxFrom(cpu, m, a, true);
  } else if (_t1 === 236) {
    const a = aAbs(cpu, m);
    cpxFrom(cpu, m, a, false);
  } else if (_t1 === 192) {
    const v = immX(cpu, m);
    compareVals(cpu, cpu.y, v, (!x8(cpu)));
  } else if (_t1 === 196) {
    const a = aDp(cpu, m);
    cpyFrom(cpu, m, a, true);
  } else if (_t1 === 204) {
    const a = aAbs(cpu, m);
    cpyFrom(cpu, m, a, false);
  } else if (_t1 === 166) {
    const a = aDp(cpu, m);
    ldxFrom(cpu, m, a, true);
  } else if (_t1 === 182) {
    const a = aDpY(cpu, m);
    ldxFrom(cpu, m, a, true);
  } else if (_t1 === 174) {
    const a = aAbs(cpu, m);
    ldxFrom(cpu, m, a, false);
  } else if (_t1 === 190) {
    const a = aAbsY(cpu, m);
    ldxFrom(cpu, m, a, false);
  } else if (_t1 === 164) {
    const a = aDp(cpu, m);
    ldyFrom(cpu, m, a, true);
  } else if (_t1 === 180) {
    const a = aDpX(cpu, m);
    ldyFrom(cpu, m, a, true);
  } else if (_t1 === 172) {
    const a = aAbs(cpu, m);
    ldyFrom(cpu, m, a, false);
  } else if (_t1 === 188) {
    const a = aAbsX(cpu, m);
    ldyFrom(cpu, m, a, false);
  } else if (_t1 === 134) {
    const a = aDp(cpu, m);
    stxTo(cpu, m, a, true);
  } else if (_t1 === 150) {
    const a = aDpY(cpu, m);
    stxTo(cpu, m, a, true);
  } else if (_t1 === 142) {
    const a = aAbs(cpu, m);
    stxTo(cpu, m, a, false);
  } else if (_t1 === 132) {
    const a = aDp(cpu, m);
    styTo(cpu, m, a, true);
  } else if (_t1 === 148) {
    const a = aDpX(cpu, m);
    styTo(cpu, m, a, true);
  } else if (_t1 === 140) {
    const a = aAbs(cpu, m);
    styTo(cpu, m, a, false);
  } else if (_t1 === 100) {
    const a = aDp(cpu, m);
    stzTo(cpu, m, a, true);
  } else if (_t1 === 116) {
    const a = aDpX(cpu, m);
    stzTo(cpu, m, a, true);
  } else if (_t1 === 156) {
    const a = aAbs(cpu, m);
    stzTo(cpu, m, a, false);
  } else if (_t1 === 158) {
    const a = aAbsX(cpu, m);
    stzTo(cpu, m, a, false);
  } else if (_t1 === 105) {
    const v = immM(cpu, m);
    doADC(cpu, v);
  } else if (_t1 === 101) {
    const a = aDp(cpu, m);
    adcFrom(cpu, m, a, true);
  } else if (_t1 === 117) {
    const a = aDpX(cpu, m);
    adcFrom(cpu, m, a, true);
  } else if (_t1 === 109) {
    const a = aAbs(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 125) {
    const a = aAbsX(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 121) {
    const a = aAbsY(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 111) {
    const a = aLong(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 127) {
    const a = aLongX(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 97) {
    const a = aDpIndX(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 113) {
    const a = aDpIndY(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 114) {
    const a = aDpInd(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 103) {
    const a = aDpLong(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 119) {
    const a = aDpLongY(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 99) {
    const a = aSr(cpu, m);
    adcFrom(cpu, m, a, true);
  } else if (_t1 === 115) {
    const a = aSrY(cpu, m);
    adcFrom(cpu, m, a, false);
  } else if (_t1 === 233) {
    const v = immM(cpu, m);
    doSBC(cpu, v);
  } else if (_t1 === 229) {
    const a = aDp(cpu, m);
    sbcFrom(cpu, m, a, true);
  } else if (_t1 === 245) {
    const a = aDpX(cpu, m);
    sbcFrom(cpu, m, a, true);
  } else if (_t1 === 237) {
    const a = aAbs(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 253) {
    const a = aAbsX(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 249) {
    const a = aAbsY(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 239) {
    const a = aLong(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 255) {
    const a = aLongX(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 225) {
    const a = aDpIndX(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 241) {
    const a = aDpIndY(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 242) {
    const a = aDpInd(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 231) {
    const a = aDpLong(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 247) {
    const a = aDpLongY(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 227) {
    const a = aSr(cpu, m);
    sbcFrom(cpu, m, a, true);
  } else if (_t1 === 243) {
    const a = aSrY(cpu, m);
    sbcFrom(cpu, m, a, false);
  } else if (_t1 === 10) {
    accASL(cpu);
  } else if (_t1 === 6) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 0);
  } else if (_t1 === 22) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 0);
  } else if (_t1 === 14) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 0);
  } else if (_t1 === 30) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 0);
  } else if (_t1 === 74) {
    accLSR(cpu);
  } else if (_t1 === 70) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 1);
  } else if (_t1 === 86) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 1);
  } else if (_t1 === 78) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 1);
  } else if (_t1 === 94) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 1);
  } else if (_t1 === 42) {
    accROL(cpu);
  } else if (_t1 === 38) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 2);
  } else if (_t1 === 54) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 2);
  } else if (_t1 === 46) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 2);
  } else if (_t1 === 62) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 2);
  } else if (_t1 === 106) {
    accROR(cpu);
  } else if (_t1 === 102) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 3);
  } else if (_t1 === 118) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 3);
  } else if (_t1 === 110) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 3);
  } else if (_t1 === 126) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 3);
  } else if (_t1 === 230) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 4);
  } else if (_t1 === 246) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 4);
  } else if (_t1 === 238) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 4);
  } else if (_t1 === 254) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 4);
  } else if (_t1 === 198) {
    const a = aDp(cpu, m);
    rmwMem(cpu, m, a, true, 5);
  } else if (_t1 === 214) {
    const a = aDpX(cpu, m);
    rmwMem(cpu, m, a, true, 5);
  } else if (_t1 === 206) {
    const a = aAbs(cpu, m);
    rmwMem(cpu, m, a, false, 5);
  } else if (_t1 === 222) {
    const a = aAbsX(cpu, m);
    rmwMem(cpu, m, a, false, 5);
  } else if (_t1 === 4) {
    const a = aDp(cpu, m);
    tsbMem(cpu, m, a, true);
  } else if (_t1 === 12) {
    const a = aAbs(cpu, m);
    tsbMem(cpu, m, a, false);
  } else if (_t1 === 20) {
    const a = aDp(cpu, m);
    trbMem(cpu, m, a, true);
  } else if (_t1 === 28) {
    const a = aAbs(cpu, m);
    trbMem(cpu, m, a, false);
  } else if (_t1 === 137) {
    const v = immM(cpu, m);
    bitImm(cpu, v);
  } else if (_t1 === 36) {
    const a = aDp(cpu, m);
    bitMem(cpu, m, a, true);
  } else if (_t1 === 52) {
    const a = aDpX(cpu, m);
    bitMem(cpu, m, a, true);
  } else if (_t1 === 44) {
    const a = aAbs(cpu, m);
    bitMem(cpu, m, a, false);
  } else if (_t1 === 60) {
    const a = aAbsX(cpu, m);
    bitMem(cpu, m, a, false);
  } else if (_t1 === 16) {
    branchIf(cpu, m, (((cpu.p & FN) >>> 0) == 0));
  } else if (_t1 === 48) {
    branchIf(cpu, m, (((cpu.p & FN) >>> 0) != 0));
  } else if (_t1 === 80) {
    branchIf(cpu, m, (((cpu.p & FV) >>> 0) == 0));
  } else if (_t1 === 112) {
    branchIf(cpu, m, (((cpu.p & FV) >>> 0) != 0));
  } else if (_t1 === 144) {
    branchIf(cpu, m, (((cpu.p & FC) >>> 0) == 0));
  } else if (_t1 === 176) {
    branchIf(cpu, m, (((cpu.p & FC) >>> 0) != 0));
  } else if (_t1 === 208) {
    branchIf(cpu, m, (((cpu.p & FZ) >>> 0) == 0));
  } else if (_t1 === 240) {
    branchIf(cpu, m, (((cpu.p & FZ) >>> 0) != 0));
  } else if (_t1 === 128) {
    branchIf(cpu, m, true);
  } else if (_t1 === 130) {
    const off = fetch16(cpu, m);
    const soff = (() => {
    if ((off >= 32768)) {
      return Math.trunc((off - 65536));
    } else {
      return off;
    }
    })();
    cpu.pc = ((Math.trunc((cpu.pc + soff)) & 65535) >>> 0);
  } else if (_t1 === 76) {
    cpu.pc = fetch16(cpu, m);
  } else if (_t1 === 92) {
    const t = fetch24(cpu, m);
    cpu.pc = ((t & 65535) >>> 0);
    cpu.pbr = ((Math.floor(t / 2 ** (16)) & 255) >>> 0);
  } else if (_t1 === 108) {
    const ptr = fetch16(cpu, m);
    cpu.pc = readPtr16(m, ptr);
  } else if (_t1 === 124) {
    const base = fetch16(cpu, m);
    const a0 = ((Math.trunc((base + cpu.x)) & 65535) >>> 0);
    const lo = memRead(m, ((((cpu.pbr << 16) >>> 0) | a0) >>> 0));
    const hi = memRead(m, ((((cpu.pbr << 16) >>> 0) | ((Math.trunc((a0 + 1)) & 65535) >>> 0)) >>> 0));
    cpu.pc = ((lo | ((hi << 8) >>> 0)) >>> 0);
  } else if (_t1 === 220) {
    const ptr = fetch16(cpu, m);
    const t = readPtr24(m, ptr);
    cpu.pc = ((t & 65535) >>> 0);
    cpu.pbr = ((Math.floor(t / 2 ** (16)) & 255) >>> 0);
  } else if (_t1 === 32) {
    const target = fetch16(cpu, m);
    push16(cpu, m, ((Math.trunc((cpu.pc - 1)) & 65535) >>> 0));
    cpu.pc = target;
  } else if (_t1 === 96) {
    const addr = pull16(cpu, m);
    cpu.pc = ((Math.trunc((addr + 1)) & 65535) >>> 0);
  } else if (_t1 === 34) {
    const target = fetch24(cpu, m);
    push8f(cpu, m, cpu.pbr);
    push16f(cpu, m, ((Math.trunc((cpu.pc - 1)) & 65535) >>> 0));
    clampEmuStack(cpu);
    cpu.pc = ((target & 65535) >>> 0);
    cpu.pbr = ((Math.floor(target / 2 ** (16)) & 255) >>> 0);
  } else if (_t1 === 107) {
    const addr = pull16f(cpu, m);
    const bank = pull8f(cpu, m);
    clampEmuStack(cpu);
    cpu.pc = ((Math.trunc((addr + 1)) & 65535) >>> 0);
    cpu.pbr = ((bank & 255) >>> 0);
  } else if (_t1 === 212) {
    const ad = aDp(cpu, m);
    const v = readPtr16(m, ad);
    push16f(cpu, m, v);
    clampEmuStack(cpu);
  } else if (_t1 === 98) {
    const off = fetch16(cpu, m);
    const soff = (() => {
    if ((off >= 32768)) {
      return Math.trunc((off - 65536));
    } else {
      return off;
    }
    })();
    push16f(cpu, m, ((Math.trunc((cpu.pc + soff)) & 65535) >>> 0));
    clampEmuStack(cpu);
  } else if (_t1 === 72) {
    if (m8(cpu)) {
      push8(cpu, m, cpu.a);
    } else {
      push16(cpu, m, cpu.a);
    }
  } else if (_t1 === 104) {
    if (m8(cpu)) {
      const v = pull8(cpu, m);
      cpu.a = ((((cpu.a & 65280) >>> 0) | v) >>> 0);
      setNZ8(cpu, v);
    } else {
      cpu.a = pull16(cpu, m);
      setNZ16(cpu, cpu.a);
    }
  } else if (_t1 === 218) {
    if (x8(cpu)) {
      push8(cpu, m, cpu.x);
    } else {
      push16(cpu, m, cpu.x);
    }
  } else if (_t1 === 250) {
    if (x8(cpu)) {
      cpu.x = pull8(cpu, m);
      setNZ8(cpu, cpu.x);
    } else {
      cpu.x = pull16(cpu, m);
      setNZ16(cpu, cpu.x);
    }
  } else if (_t1 === 90) {
    if (x8(cpu)) {
      push8(cpu, m, cpu.y);
    } else {
      push16(cpu, m, cpu.y);
    }
  } else if (_t1 === 122) {
    if (x8(cpu)) {
      cpu.y = pull8(cpu, m);
      setNZ8(cpu, cpu.y);
    } else {
      cpu.y = pull16(cpu, m);
      setNZ16(cpu, cpu.y);
    }
  } else if (_t1 === 8) {
    push8(cpu, m, cpu.p);
  } else if (_t1 === 40) {
    cpu.p = pull8(cpu, m);
    applyEmulationConstraints(cpu);
    if ((((cpu.p & FX) >>> 0) != 0)) {
      cpu.x = ((cpu.x & 255) >>> 0);
      cpu.y = ((cpu.y & 255) >>> 0);
    }
  } else if (_t1 === 139) {
    push8f(cpu, m, cpu.dbr);
    clampEmuStack(cpu);
  } else if (_t1 === 171) {
    cpu.dbr = pull8f(cpu, m);
    clampEmuStack(cpu);
    setNZ8(cpu, cpu.dbr);
  } else if (_t1 === 75) {
    push8f(cpu, m, cpu.pbr);
    clampEmuStack(cpu);
  } else if (_t1 === 11) {
    push16f(cpu, m, cpu.d);
    clampEmuStack(cpu);
  } else if (_t1 === 43) {
    cpu.d = pull16f(cpu, m);
    clampEmuStack(cpu);
    setNZ16(cpu, cpu.d);
  } else if (_t1 === 244) {
    const v = fetch16(cpu, m);
    push16f(cpu, m, v);
    clampEmuStack(cpu);
  } else if (_t1 === 0) {
    softInterrupt(cpu, m, 65510, 65534);
  } else if (_t1 === 2) {
    softInterrupt(cpu, m, 65508, 65524);
  } else if (_t1 === 64) {
    cpu.p = pull8(cpu, m);
    const addr = pull16(cpu, m);
    if ((cpu.e == 0)) {
      cpu.pbr = pull8(cpu, m);
    }
    cpu.pc = addr;
    applyEmulationConstraints(cpu);
    if ((((cpu.p & FX) >>> 0) != 0)) {
      cpu.x = ((cpu.x & 255) >>> 0);
      cpu.y = ((cpu.y & 255) >>> 0);
    }
  } else if (_t1 === 84) {
    blockMove(cpu, m, 1);
  } else if (_t1 === 68) {
    blockMove(cpu, m, (-1));
  } else if (_t1 === 66) {
    const sig = fetch8(cpu, m);
  } else if (_t1 === 203) {
  } else if (_t1 === 219) {
  } else {
  }
}

function spcMemNew() {
  return new SpcMem([], [], true, [], [], false, [], [], 0, spcZerosI64(3), spcZerosI64(3), spcZerosI64(3), spcZerosI64(3), 0, []);
}

function spcZeros(n) {
  let v = [];
  let i = 0;
  while ((i < n)) {
    v.push(0);
    i = Math.trunc((i + 1));
  }
  return v;
}

function iplRom() {
  const b = [205, 239, 189, 232, 0, 198, 29, 208, 252, 143, 170, 244, 143, 187, 245, 120, 204, 244, 208, 251, 47, 25, 235, 244, 208, 252, 126, 244, 208, 11, 228, 245, 203, 244, 215, 0, 252, 208, 243, 171, 1, 16, 239, 126, 244, 16, 235, 186, 246, 218, 0, 186, 244, 196, 244, 221, 93, 208, 219, 31, 0, 0, 192, 255];
  let v = [];
  let i = 0;
  while ((i < 64)) {
    v.push((b[i] & 0xFF));
    i = Math.trunc((i + 1));
  }
  return v;
}

function spcZerosI64(n) {
  let v = [];
  let i = 0;
  while ((i < n)) {
    v.push(0);
    i = Math.trunc((i + 1));
  }
  return v;
}

function spcMemReal() {
  return new SpcMem([], [], false, spcZeros(65536), iplRom(), true, spcZerosI64(4), spcZerosI64(4), 0, spcZerosI64(3), spcZerosI64(3), spcZerosI64(3), spcZerosI64(3), 0, spcZeros(128));
}

function spcMemReset(m) {
  m.addr = [];
  m.val = [];
}

function spcRead(m, a) {
  if (m.testMode) {
    let i = 0;
    while ((i < m.addr.length)) {
      if ((m.addr[i] == ((a & 65535) >>> 0))) {
        return m.val[i];
      }
      i = Math.trunc((i + 1));
    }
    return 0;
  }
  const addr = ((a & 65535) >>> 0);
  if (((addr >= 244) && (addr <= 247))) {
    return m.inPort[Math.trunc((addr - 244))];
  }
  if ((addr == 242)) {
    return m.dspAddr;
  }
  if ((addr == 243)) {
    return Math.trunc(m.dsp[((m.dspAddr & 127) >>> 0)]);
  }
  if (((addr >= 253) && (addr <= 255))) {
    const t = Math.trunc((addr - 253));
    const r = ((m.tOut[t] & 15) >>> 0);
    m.tOut[t] = 0;
    return r;
  }
  if ((m.iplEnabled && (addr >= 65472))) {
    return Math.trunc(m.ipl[Math.trunc((addr - 65472))]);
  }
  return Math.trunc(m.ram[addr]);
}

function spcTimersTick(m, cyc) {
  let t = 0;
  while ((t < 3)) {
    if ((((m.tEnable & ((1 << t) >>> 0)) >>> 0) != 0)) {
      const period = (() => {
      if ((t == 2)) {
        return 16;
      } else {
        return 128;
      }
      })();
      m.tDiv[t] = Math.trunc((m.tDiv[t] + cyc));
      while ((m.tDiv[t] >= period)) {
        m.tDiv[t] = Math.trunc((m.tDiv[t] - period));
        m.tCount[t] = Math.trunc((m.tCount[t] + 1));
        const tgt = (() => {
        if ((m.tTarget[t] == 0)) {
          return 256;
        } else {
          return m.tTarget[t];
        }
        })();
        if ((m.tCount[t] >= tgt)) {
          m.tCount[t] = 0;
          m.tOut[t] = ((Math.trunc((m.tOut[t] + 1)) & 15) >>> 0);
        }
      }
    }
    t = Math.trunc((t + 1));
  }
}

function spcWrite(m, a, v) {
  if (m.testMode) {
    const addr = ((a & 65535) >>> 0);
    let i = 0;
    while ((i < m.addr.length)) {
      if ((m.addr[i] == addr)) {
        m.val[i] = ((v & 255) >>> 0);
        return;
      }
      i = Math.trunc((i + 1));
    }
    m.addr.push(addr);
    m.val.push(((v & 255) >>> 0));
    return;
  }
  const addr = ((a & 65535) >>> 0);
  const bv = ((v & 255) >>> 0);
  if ((addr == 241)) {
    m.iplEnabled = (((bv & 128) >>> 0) != 0);
    if ((((bv & 32) >>> 0) != 0)) {
      m.inPort[2] = 0;
      m.inPort[3] = 0;
    }
    if ((((bv & 16) >>> 0) != 0)) {
      m.inPort[0] = 0;
      m.inPort[1] = 0;
    }
    let t = 0;
    while ((t < 3)) {
      const was = ((Math.floor(m.tEnable / 2 ** (t)) & 1) >>> 0);
      const now = ((Math.floor(bv / 2 ** (t)) & 1) >>> 0);
      if (((now == 1) && (was == 0))) {
        m.tDiv[t] = 0;
        m.tCount[t] = 0;
        m.tOut[t] = 0;
      }
      t = Math.trunc((t + 1));
    }
    m.tEnable = ((bv & 7) >>> 0);
    m.ram[addr] = (bv & 0xFF);
    return;
  }
  if ((addr == 242)) {
    m.dspAddr = bv;
    m.ram[addr] = (bv & 0xFF);
    return;
  }
  if ((addr == 243)) {
    if ((((m.dspAddr & 128) >>> 0) == 0)) {
      m.dsp[((m.dspAddr & 127) >>> 0)] = (bv & 0xFF);
    }
    m.ram[addr] = (bv & 0xFF);
    return;
  }
  if (((addr >= 250) && (addr <= 252))) {
    m.tTarget[Math.trunc((addr - 250))] = bv;
    m.ram[addr] = (bv & 0xFF);
    return;
  }
  if (((addr >= 244) && (addr <= 247))) {
    m.outPort[Math.trunc((addr - 244))] = bv;
    m.ram[addr] = (bv & 0xFF);
    return;
  }
  m.ram[addr] = (bv & 0xFF);
}

function apuReadPort(m, i) {
  return m.outPort[((i & 3) >>> 0)];
}

function apuWritePort(m, i, v) {
  m.inPort[((i & 3) >>> 0)] = ((v & 255) >>> 0);
}

function spcReset(spc, m) {
  spc.pc = spcRead16(m, 65534);
  spc.sp = 239;
  spc.psw = 2;
}

function spcSetBit(spc, mask, on) {
  if (on) {
    spc.psw = ((spc.psw | mask) >>> 0);
  } else {
    spc.psw = ((spc.psw & (~mask)) >>> 0);
  }
}

function spcNZ(spc, v) {
  spcSetBit(spc, PZ, (((v & 255) >>> 0) == 0));
  spcSetBit(spc, PN, (((v & 128) >>> 0) != 0));
}

function spcFetch(spc, m) {
  const v = spcRead(m, spc.pc);
  spc.pc = ((Math.trunc((spc.pc + 1)) & 65535) >>> 0);
  return v;
}

function dpAddr(spc, dp) {
  if ((((spc.psw & PP) >>> 0) != 0)) {
    return ((256 | ((dp & 255) >>> 0)) >>> 0);
  }
  return ((dp & 255) >>> 0);
}

function spcFetch16(spc, m) {
  const lo = spcFetch(spc, m);
  const hi = spcFetch(spc, m);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function spcOr(spc, v) {
  spc.a = ((spc.a | v) >>> 0);
  spcNZ(spc, spc.a);
}

function spcAnd(spc, v) {
  spc.a = ((spc.a & v) >>> 0);
  spcNZ(spc, spc.a);
}

function spcEor(spc, v) {
  spc.a = ((spc.a ^ v) >>> 0);
  spcNZ(spc, spc.a);
}

function spcCmp(spc, reg, v) {
  const d = ((Math.trunc((reg - v)) & 255) >>> 0);
  spcSetBit(spc, PC_, (((reg & 255) >>> 0) >= ((v & 255) >>> 0)));
  spcSetBit(spc, PZ, (d == 0));
  spcSetBit(spc, PN, (((d & 128) >>> 0) != 0));
}

function aluAdcVal(spc, a, v) {
  const av = ((a & 255) >>> 0);
  const vv = ((v & 255) >>> 0);
  const c = ((spc.psw & PC_) >>> 0);
  const r = Math.trunc((Math.trunc((av + vv)) + c));
  spcSetBit(spc, PC_, (r > 255));
  spcSetBit(spc, PH, (Math.trunc((Math.trunc((((av & 15) >>> 0) + ((vv & 15) >>> 0))) + c)) > 15));
  spcSetBit(spc, PV, ((((((~((av ^ vv) >>> 0)) & ((av ^ r) >>> 0)) >>> 0) & 128) >>> 0) != 0));
  const rr = ((r & 255) >>> 0);
  spcNZ(spc, rr);
  return rr;
}

function aluSbcVal(spc, a, v) {
  return aluAdcVal(spc, a, ((((v ^ 255) >>> 0) & 255) >>> 0));
}

function spcAdc(spc, v) {
  spc.a = aluAdcVal(spc, spc.a, v);
}

function spcSbc(spc, v) {
  spc.a = aluSbcVal(spc, spc.a, v);
}

function readDp(spc, m) {
  return spcRead(m, dpAddr(spc, spcFetch(spc, m)));
}

function readAbs(spc, m) {
  return spcRead(m, spcFetch16(spc, m));
}

function readAbsX(spc, m) {
  return spcRead(m, ((Math.trunc((spcFetch16(spc, m) + spc.x)) & 65535) >>> 0));
}

function readAbsY(spc, m) {
  return spcRead(m, ((Math.trunc((spcFetch16(spc, m) + spc.y)) & 65535) >>> 0));
}

function spcPush(spc, m, v) {
  spcWrite(m, ((256 | ((spc.sp & 255) >>> 0)) >>> 0), v);
  spc.sp = ((Math.trunc((spc.sp - 1)) & 255) >>> 0);
}

function spcPull(spc, m) {
  spc.sp = ((Math.trunc((spc.sp + 1)) & 255) >>> 0);
  return spcRead(m, ((256 | ((spc.sp & 255) >>> 0)) >>> 0));
}

function spcPush16(spc, m, v) {
  spcPush(spc, m, ((Math.floor(v / 2 ** (8)) & 255) >>> 0));
  spcPush(spc, m, ((v & 255) >>> 0));
}

function spcPull16(spc, m) {
  const lo = spcPull(spc, m);
  const hi = spcPull(spc, m);
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function spcRead16(m, addr) {
  return ((spcRead(m, addr) | ((spcRead(m, ((Math.trunc((addr + 1)) & 65535) >>> 0)) << 8) >>> 0)) >>> 0);
}

function spcDaa(spc) {
  const oldA = ((spc.a & 255) >>> 0);
  let carry = (((spc.psw & PC_) >>> 0) != 0);
  let a = oldA;
  if ((carry || (oldA > 153))) {
    a = Math.trunc((a + 96));
    carry = true;
  }
  if (((((spc.psw & PH) >>> 0) != 0) || (((oldA & 15) >>> 0) > 9))) {
    a = Math.trunc((a + 6));
  }
  spc.a = ((a & 255) >>> 0);
  spcSetBit(spc, PC_, carry);
  spcNZ(spc, spc.a);
}

function spcDas(spc) {
  const oldA = ((spc.a & 255) >>> 0);
  let carry = (((spc.psw & PC_) >>> 0) != 0);
  let a = oldA;
  if (((!carry) || (oldA > 153))) {
    a = Math.trunc((a - 96));
    carry = false;
  }
  if (((((spc.psw & PH) >>> 0) == 0) || (((oldA & 15) >>> 0) > 9))) {
    a = Math.trunc((a - 6));
  }
  spc.a = ((a & 255) >>> 0);
  spcSetBit(spc, PC_, carry);
  spcNZ(spc, spc.a);
}

function spcDiv(spc) {
  const ya = ((((((spc.y << 8) >>> 0) | spc.a) >>> 0) & 65535) >>> 0);
  const x = ((spc.x & 255) >>> 0);
  spcSetBit(spc, PH, (((x & 15) >>> 0) <= ((spc.y & 15) >>> 0)));
  spcSetBit(spc, PV, (spc.y >= x));
  if ((spc.y < ((x << 1) >>> 0))) {
    spc.a = Math.trunc(Math.trunc(ya / x));
    spc.y = (ya % x);
  } else {
    spc.a = Math.trunc((255 - Math.trunc(Math.trunc(Math.trunc((ya - ((x << 9) >>> 0))) / Math.trunc((256 - x))))));
    spc.y = Math.trunc((x + (Math.trunc((ya - ((x << 9) >>> 0))) % Math.trunc((256 - x)))));
  }
  spc.a = ((spc.a & 255) >>> 0);
  spc.y = ((spc.y & 255) >>> 0);
  spcNZ(spc, spc.a);
}

function bbTest(spc, m, bit, wantSet) {
  const v = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
  const off = spcFetch(spc, m);
  const soff = (() => {
  if ((off >= 128)) {
    return Math.trunc((off - 256));
  } else {
    return off;
  }
  })();
  const bitset = (((Math.floor(v / 2 ** (bit)) & 1) >>> 0) != 0);
  if ((bitset == wantSet)) {
    spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
  }
}

function spcBranch(spc, m, cond) {
  const off = spcFetch(spc, m);
  const soff = (() => {
  if ((off >= 128)) {
    return Math.trunc((off - 256));
  } else {
    return off;
  }
  })();
  if (cond) {
    spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
  }
}

function spcAsl(spc, v) {
  spcSetBit(spc, PC_, (((v & 128) >>> 0) != 0));
  const r = ((((v << 1) >>> 0) & 255) >>> 0);
  spcNZ(spc, r);
  return r;
}

function spcLsr(spc, v) {
  spcSetBit(spc, PC_, (((v & 1) >>> 0) != 0));
  const r = Math.floor(((v & 255) >>> 0) / 2 ** (1));
  spcNZ(spc, r);
  return r;
}

function spcRol(spc, v) {
  const oldC = ((spc.psw & PC_) >>> 0);
  spcSetBit(spc, PC_, (((v & 128) >>> 0) != 0));
  const r = ((((((v << 1) >>> 0) | oldC) >>> 0) & 255) >>> 0);
  spcNZ(spc, r);
  return r;
}

function spcRor(spc, v) {
  const oldC = ((spc.psw & PC_) >>> 0);
  spcSetBit(spc, PC_, (((v & 1) >>> 0) != 0));
  let r = Math.floor(((v & 255) >>> 0) / 2 ** (1));
  if ((oldC != 0)) {
    r = ((r | 128) >>> 0);
  }
  spcNZ(spc, r);
  return r;
}

function spcNZ16(spc, w) {
  spcSetBit(spc, PZ, (((w & 65535) >>> 0) == 0));
  spcSetBit(spc, PN, (((w & 32768) >>> 0) != 0));
}

function readDpWord(spc, m, d) {
  const lo = spcRead(m, dpAddr(spc, d));
  const hi = spcRead(m, dpAddr(spc, ((Math.trunc((d + 1)) & 255) >>> 0)));
  return ((lo | ((hi << 8) >>> 0)) >>> 0);
}

function writeDpWord(spc, m, d, w) {
  spcWrite(m, dpAddr(spc, d), ((w & 255) >>> 0));
  spcWrite(m, dpAddr(spc, ((Math.trunc((d + 1)) & 255) >>> 0)), ((Math.floor(w / 2 ** (8)) & 255) >>> 0));
}

function readDpX(spc, m) {
  return spcRead(m, dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0)));
}

function readIndX(spc, m) {
  return spcRead(m, dpAddr(spc, spc.x));
}

function readIndDpX(spc, m) {
  const d = ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0);
  return spcRead(m, readDpWord(spc, m, d));
}

function readIndDpY(spc, m) {
  const d = spcFetch(spc, m);
  const ptr = readDpWord(spc, m, d);
  return spcRead(m, ((Math.trunc((ptr + spc.y)) & 65535) >>> 0));
}

function setBitMem(spc, m, bit, set) {
  const ad = dpAddr(spc, spcFetch(spc, m));
  let v = spcRead(m, ad);
  if (set) {
    v = ((v | ((1 << bit) >>> 0)) >>> 0);
  } else {
    v = ((v & (~((1 << bit) >>> 0))) >>> 0);
  }
  spcWrite(m, ad, v);
}

function spcAddw(spc, w) {
  const ya = ((((((spc.y << 8) >>> 0) | spc.a) >>> 0) & 65535) >>> 0);
  const r = Math.trunc((ya + w));
  spcSetBit(spc, PC_, (r > 65535));
  spcSetBit(spc, PH, (Math.trunc((((ya & 4095) >>> 0) + ((w & 4095) >>> 0))) > 4095));
  spcSetBit(spc, PV, ((((((~((ya ^ w) >>> 0)) & ((ya ^ r) >>> 0)) >>> 0) & 32768) >>> 0) != 0));
  spc.a = ((r & 255) >>> 0);
  spc.y = ((Math.floor(r / 2 ** (8)) & 255) >>> 0);
  spcNZ16(spc, r);
}

function spcSubw(spc, w) {
  const ya = ((((((spc.y << 8) >>> 0) | spc.a) >>> 0) & 65535) >>> 0);
  const comp = (((~w) & 65535) >>> 0);
  const r = Math.trunc((Math.trunc((ya + comp)) + 1));
  spcSetBit(spc, PC_, (r > 65535));
  spcSetBit(spc, PH, (Math.trunc((Math.trunc((((ya & 4095) >>> 0) + ((comp & 4095) >>> 0))) + 1)) > 4095));
  spcSetBit(spc, PV, ((((((~((ya ^ comp) >>> 0)) & ((ya ^ r) >>> 0)) >>> 0) & 32768) >>> 0) != 0));
  spc.a = ((r & 255) >>> 0);
  spc.y = ((Math.floor(r / 2 ** (8)) & 255) >>> 0);
  spcNZ16(spc, r);
}

function spcCmpw(spc, w) {
  const ya = ((((((spc.y << 8) >>> 0) | spc.a) >>> 0) & 65535) >>> 0);
  spcSetBit(spc, PC_, (ya >= ((w & 65535) >>> 0)));
  spcNZ16(spc, ((Math.trunc((ya - w)) & 65535) >>> 0));
}

function spcStep(spc, m) {
  spcTimersTick(m, 16);
  const op = spcFetch(spc, m);
  const _t2 = op;
  if (_t2 === 0) {
  } else if (_t2 === 32) {
    spcSetBit(spc, PP, false);
  } else if (_t2 === 64) {
    spcSetBit(spc, PP, true);
  } else if (_t2 === 96) {
    spcSetBit(spc, PC_, false);
  } else if (_t2 === 128) {
    spcSetBit(spc, PC_, true);
  } else if (_t2 === 224) {
    spcSetBit(spc, PV, false);
    spcSetBit(spc, PH, false);
  } else if (_t2 === 237) {
    spcSetBit(spc, PC_, (((spc.psw & PC_) >>> 0) == 0));
  } else if (_t2 === 160) {
    spcSetBit(spc, PI, true);
  } else if (_t2 === 192) {
    spcSetBit(spc, PI, false);
  } else if (_t2 === 232) {
    const v = spcFetch(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 205) {
    const v = spcFetch(spc, m);
    spc.x = v;
    spcNZ(spc, v);
  } else if (_t2 === 141) {
    const v = spcFetch(spc, m);
    spc.y = v;
    spcNZ(spc, v);
  } else if (_t2 === 125) {
    spc.a = spc.x;
    spcNZ(spc, spc.a);
  } else if (_t2 === 221) {
    spc.a = spc.y;
    spcNZ(spc, spc.a);
  } else if (_t2 === 93) {
    spc.x = spc.a;
    spcNZ(spc, spc.x);
  } else if (_t2 === 253) {
    spc.y = spc.a;
    spcNZ(spc, spc.y);
  } else if (_t2 === 157) {
    spc.x = spc.sp;
    spcNZ(spc, spc.x);
  } else if (_t2 === 189) {
    spc.sp = spc.x;
  } else if (_t2 === 188) {
    spc.a = ((Math.trunc((spc.a + 1)) & 255) >>> 0);
    spcNZ(spc, spc.a);
  } else if (_t2 === 61) {
    spc.x = ((Math.trunc((spc.x + 1)) & 255) >>> 0);
    spcNZ(spc, spc.x);
  } else if (_t2 === 252) {
    spc.y = ((Math.trunc((spc.y + 1)) & 255) >>> 0);
    spcNZ(spc, spc.y);
  } else if (_t2 === 156) {
    spc.a = ((Math.trunc((spc.a - 1)) & 255) >>> 0);
    spcNZ(spc, spc.a);
  } else if (_t2 === 29) {
    spc.x = ((Math.trunc((spc.x - 1)) & 255) >>> 0);
    spcNZ(spc, spc.x);
  } else if (_t2 === 220) {
    spc.y = ((Math.trunc((spc.y - 1)) & 255) >>> 0);
    spcNZ(spc, spc.y);
  } else if (_t2 === 8) {
    const v = spcFetch(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 4) {
    const v = readDp(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 5) {
    const v = readAbs(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 40) {
    const v = spcFetch(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 36) {
    const v = readDp(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 37) {
    const v = readAbs(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 72) {
    const v = spcFetch(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 68) {
    const v = readDp(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 69) {
    const v = readAbs(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 104) {
    const v = spcFetch(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 100) {
    const v = readDp(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 101) {
    const v = readAbs(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 136) {
    const v = spcFetch(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 132) {
    const v = readDp(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 133) {
    const v = readAbs(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 168) {
    const v = spcFetch(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 164) {
    const v = readDp(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 165) {
    const v = readAbs(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 200) {
    const v = spcFetch(spc, m);
    spcCmp(spc, spc.x, v);
  } else if (_t2 === 173) {
    const v = spcFetch(spc, m);
    spcCmp(spc, spc.y, v);
  } else if (_t2 === 228) {
    const v = readDp(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 229) {
    const v = readAbs(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 196) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcWrite(m, ad, spc.a);
  } else if (_t2 === 197) {
    const ad = spcFetch16(spc, m);
    spcWrite(m, ad, spc.a);
  } else if (_t2 === 248) {
    const v = readDp(spc, m);
    spc.x = v;
    spcNZ(spc, v);
  } else if (_t2 === 233) {
    const v = readAbs(spc, m);
    spc.x = v;
    spcNZ(spc, v);
  } else if (_t2 === 216) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcWrite(m, ad, spc.x);
  } else if (_t2 === 201) {
    const ad = spcFetch16(spc, m);
    spcWrite(m, ad, spc.x);
  } else if (_t2 === 235) {
    const v = readDp(spc, m);
    spc.y = v;
    spcNZ(spc, v);
  } else if (_t2 === 236) {
    const v = readAbs(spc, m);
    spc.y = v;
    spcNZ(spc, v);
  } else if (_t2 === 203) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcWrite(m, ad, spc.y);
  } else if (_t2 === 204) {
    const ad = spcFetch16(spc, m);
    spcWrite(m, ad, spc.y);
  } else if (_t2 === 230) {
    spc.a = spcRead(m, dpAddr(spc, spc.x));
    spcNZ(spc, spc.a);
  } else if (_t2 === 198) {
    spcWrite(m, dpAddr(spc, spc.x), spc.a);
  } else if (_t2 === 143) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcWrite(m, ad, imm);
  } else if (_t2 === 45) {
    spcPush(spc, m, spc.a);
  } else if (_t2 === 77) {
    spcPush(spc, m, spc.x);
  } else if (_t2 === 109) {
    spcPush(spc, m, spc.y);
  } else if (_t2 === 13) {
    spcPush(spc, m, spc.psw);
  } else if (_t2 === 174) {
    spc.a = spcPull(spc, m);
  } else if (_t2 === 206) {
    spc.x = spcPull(spc, m);
  } else if (_t2 === 238) {
    spc.y = spcPull(spc, m);
  } else if (_t2 === 142) {
    spc.psw = spcPull(spc, m);
  } else if (_t2 === 171) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((Math.trunc((spcRead(m, ad) + 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 172) {
    const ad = spcFetch16(spc, m);
    const r = ((Math.trunc((spcRead(m, ad) + 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 139) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((Math.trunc((spcRead(m, ad) - 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 140) {
    const ad = spcFetch16(spc, m);
    const r = ((Math.trunc((spcRead(m, ad) - 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 47) {
    spcBranch(spc, m, true);
  } else if (_t2 === 240) {
    spcBranch(spc, m, (((spc.psw & PZ) >>> 0) != 0));
  } else if (_t2 === 208) {
    spcBranch(spc, m, (((spc.psw & PZ) >>> 0) == 0));
  } else if (_t2 === 176) {
    spcBranch(spc, m, (((spc.psw & PC_) >>> 0) != 0));
  } else if (_t2 === 144) {
    spcBranch(spc, m, (((spc.psw & PC_) >>> 0) == 0));
  } else if (_t2 === 48) {
    spcBranch(spc, m, (((spc.psw & PN) >>> 0) != 0));
  } else if (_t2 === 16) {
    spcBranch(spc, m, (((spc.psw & PN) >>> 0) == 0));
  } else if (_t2 === 112) {
    spcBranch(spc, m, (((spc.psw & PV) >>> 0) != 0));
  } else if (_t2 === 80) {
    spcBranch(spc, m, (((spc.psw & PV) >>> 0) == 0));
  } else if (_t2 === 21) {
    const v = readAbsX(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 22) {
    const v = readAbsY(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 53) {
    const v = readAbsX(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 54) {
    const v = readAbsY(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 85) {
    const v = readAbsX(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 86) {
    const v = readAbsY(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 117) {
    const v = readAbsX(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 118) {
    const v = readAbsY(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 149) {
    const v = readAbsX(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 150) {
    const v = readAbsY(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 181) {
    const v = readAbsX(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 182) {
    const v = readAbsY(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 27) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = spcAsl(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 91) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = spcLsr(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 59) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = spcRol(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 123) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = spcRor(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 187) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = ((Math.trunc((spcRead(m, ad) + 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 155) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    const r = ((Math.trunc((spcRead(m, ad) - 1)) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 222) {
    const v = spcRead(m, dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0)));
    const off = spcFetch(spc, m);
    const soff = (() => {
    if ((off >= 128)) {
      return Math.trunc((off - 256));
    } else {
      return off;
    }
    })();
    if ((((spc.a & 255) >>> 0) != v)) {
      spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
    }
  } else if (_t2 === 245) {
    const v = readAbsX(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 246) {
    const v = readAbsY(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 231) {
    const v = readIndDpX(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 247) {
    const v = readIndDpY(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 213) {
    const ad = ((Math.trunc((spcFetch16(spc, m) + spc.x)) & 65535) >>> 0);
    spcWrite(m, ad, spc.a);
  } else if (_t2 === 214) {
    const ad = ((Math.trunc((spcFetch16(spc, m) + spc.y)) & 65535) >>> 0);
    spcWrite(m, ad, spc.a);
  } else if (_t2 === 199) {
    const ptr = readDpWord(spc, m, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    spcWrite(m, ptr, spc.a);
  } else if (_t2 === 215) {
    const ptr = readDpWord(spc, m, spcFetch(spc, m));
    spcWrite(m, ((Math.trunc((ptr + spc.y)) & 65535) >>> 0), spc.a);
  } else if (_t2 === 249) {
    const v = spcRead(m, dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.y)) & 255) >>> 0)));
    spc.x = v;
    spcNZ(spc, v);
  } else if (_t2 === 251) {
    const v = spcRead(m, dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0)));
    spc.y = v;
    spcNZ(spc, v);
  } else if (_t2 === 219) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    spcWrite(m, ad, spc.y);
  } else if (_t2 === 217) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.y)) & 255) >>> 0));
    spcWrite(m, ad, spc.x);
  } else if (_t2 === 10) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, ((((spc.psw & PC_) >>> 0) != 0) || (b != 0)));
  } else if (_t2 === 42) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, ((((spc.psw & PC_) >>> 0) != 0) || (b == 0)));
  } else if (_t2 === 74) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, ((((spc.psw & PC_) >>> 0) != 0) && (b != 0)));
  } else if (_t2 === 106) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, ((((spc.psw & PC_) >>> 0) != 0) && (b == 0)));
  } else if (_t2 === 138) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, ((((spc.psw & PC_) >>> 0) != 0) != (b != 0)));
  } else if (_t2 === 170) {
    const mb = spcFetch16(spc, m);
    const b = ((Math.floor(spcRead(m, ((mb & 8191) >>> 0)) / 2 ** (((Math.floor(mb / 2 ** (13)) & 7) >>> 0))) & 1) >>> 0);
    spcSetBit(spc, PC_, (b != 0));
  } else if (_t2 === 202) {
    const mb = spcFetch16(spc, m);
    const ad = ((mb & 8191) >>> 0);
    const bit = ((Math.floor(mb / 2 ** (13)) & 7) >>> 0);
    let v = spcRead(m, ad);
    if ((((spc.psw & PC_) >>> 0) != 0)) {
      v = ((v | ((1 << bit) >>> 0)) >>> 0);
    } else {
      v = ((v & (~((1 << bit) >>> 0))) >>> 0);
    }
    spcWrite(m, ad, v);
  } else if (_t2 === 234) {
    const mb = spcFetch16(spc, m);
    const ad = ((mb & 8191) >>> 0);
    const bit = ((Math.floor(mb / 2 ** (13)) & 7) >>> 0);
    const cur = spcRead(m, ad);
    spcWrite(m, ad, ((cur ^ ((1 << bit) >>> 0)) >>> 0));
  } else if (_t2 === 14) {
    const ad = spcFetch16(spc, m);
    const v = spcRead(m, ad);
    spcNZ(spc, ((Math.trunc((spc.a - v)) & 255) >>> 0));
    spcWrite(m, ad, ((v | spc.a) >>> 0));
  } else if (_t2 === 78) {
    const ad = spcFetch16(spc, m);
    const v = spcRead(m, ad);
    spcNZ(spc, ((Math.trunc((spc.a - v)) & 255) >>> 0));
    spcWrite(m, ad, ((v & (~spc.a)) >>> 0));
  } else if (_t2 === 24) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) | imm) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 56) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) & imm) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 88) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) ^ imm) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 120) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcCmp(spc, spcRead(m, ad), imm);
  } else if (_t2 === 152) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = aluAdcVal(spc, spcRead(m, ad), imm);
    spcWrite(m, ad, r);
  } else if (_t2 === 184) {
    const imm = spcFetch(spc, m);
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = aluSbcVal(spc, spcRead(m, ad), imm);
    spcWrite(m, ad, r);
  } else if (_t2 === 9) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) | sv) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 41) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) & sv) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 73) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = ((((spcRead(m, ad) ^ sv) >>> 0) & 255) >>> 0);
    spcWrite(m, ad, r);
    spcNZ(spc, r);
  } else if (_t2 === 105) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcCmp(spc, spcRead(m, ad), sv);
  } else if (_t2 === 137) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = aluAdcVal(spc, spcRead(m, ad), sv);
    spcWrite(m, ad, r);
  } else if (_t2 === 169) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = aluSbcVal(spc, spcRead(m, ad), sv);
    spcWrite(m, ad, r);
  } else if (_t2 === 250) {
    const sv = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const ad = dpAddr(spc, spcFetch(spc, m));
    spcWrite(m, ad, sv);
  } else if (_t2 === 2) {
    setBitMem(spc, m, 0, true);
  } else if (_t2 === 34) {
    setBitMem(spc, m, 1, true);
  } else if (_t2 === 66) {
    setBitMem(spc, m, 2, true);
  } else if (_t2 === 98) {
    setBitMem(spc, m, 3, true);
  } else if (_t2 === 130) {
    setBitMem(spc, m, 4, true);
  } else if (_t2 === 162) {
    setBitMem(spc, m, 5, true);
  } else if (_t2 === 194) {
    setBitMem(spc, m, 6, true);
  } else if (_t2 === 226) {
    setBitMem(spc, m, 7, true);
  } else if (_t2 === 18) {
    setBitMem(spc, m, 0, false);
  } else if (_t2 === 50) {
    setBitMem(spc, m, 1, false);
  } else if (_t2 === 82) {
    setBitMem(spc, m, 2, false);
  } else if (_t2 === 114) {
    setBitMem(spc, m, 3, false);
  } else if (_t2 === 146) {
    setBitMem(spc, m, 4, false);
  } else if (_t2 === 178) {
    setBitMem(spc, m, 5, false);
  } else if (_t2 === 210) {
    setBitMem(spc, m, 6, false);
  } else if (_t2 === 242) {
    setBitMem(spc, m, 7, false);
  } else if (_t2 === 191) {
    spc.a = spcRead(m, dpAddr(spc, spc.x));
    spcNZ(spc, spc.a);
    spc.x = ((Math.trunc((spc.x + 1)) & 255) >>> 0);
  } else if (_t2 === 175) {
    spcWrite(m, dpAddr(spc, spc.x), spc.a);
    spc.x = ((Math.trunc((spc.x + 1)) & 255) >>> 0);
  } else if (_t2 === 6) {
    const v = readIndX(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 38) {
    const v = readIndX(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 70) {
    const v = readIndX(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 102) {
    const v = readIndX(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 134) {
    const v = readIndX(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 166) {
    const v = readIndX(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 7) {
    const v = readIndDpX(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 39) {
    const v = readIndDpX(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 71) {
    const v = readIndDpX(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 103) {
    const v = readIndDpX(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 135) {
    const v = readIndDpX(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 167) {
    const v = readIndDpX(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 23) {
    const v = readIndDpY(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 55) {
    const v = readIndDpY(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 87) {
    const v = readIndDpY(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 119) {
    const v = readIndDpY(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 151) {
    const v = readIndDpY(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 183) {
    const v = readIndDpY(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 207) {
    const r = ((Math.trunc((spc.y * spc.a)) & 65535) >>> 0);
    spc.a = ((r & 255) >>> 0);
    spc.y = ((Math.floor(r / 2 ** (8)) & 255) >>> 0);
    spcNZ(spc, spc.y);
  } else if (_t2 === 122) {
    const d = spcFetch(spc, m);
    spcAddw(spc, readDpWord(spc, m, d));
  } else if (_t2 === 154) {
    const d = spcFetch(spc, m);
    spcSubw(spc, readDpWord(spc, m, d));
  } else if (_t2 === 90) {
    const d = spcFetch(spc, m);
    spcCmpw(spc, readDpWord(spc, m, d));
  } else if (_t2 === 20) {
    const v = readDpX(spc, m);
    spcOr(spc, v);
  } else if (_t2 === 52) {
    const v = readDpX(spc, m);
    spcAnd(spc, v);
  } else if (_t2 === 84) {
    const v = readDpX(spc, m);
    spcEor(spc, v);
  } else if (_t2 === 116) {
    const v = readDpX(spc, m);
    spcCmp(spc, spc.a, v);
  } else if (_t2 === 148) {
    const v = readDpX(spc, m);
    spcAdc(spc, v);
  } else if (_t2 === 180) {
    const v = readDpX(spc, m);
    spcSbc(spc, v);
  } else if (_t2 === 244) {
    const v = readDpX(spc, m);
    spc.a = v;
    spcNZ(spc, v);
  } else if (_t2 === 212) {
    const ad = dpAddr(spc, ((Math.trunc((spcFetch(spc, m) + spc.x)) & 255) >>> 0));
    spcWrite(m, ad, spc.a);
  } else if (_t2 === 28) {
    spc.a = spcAsl(spc, spc.a);
  } else if (_t2 === 11) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = spcAsl(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 12) {
    const ad = spcFetch16(spc, m);
    const r = spcAsl(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 92) {
    spc.a = spcLsr(spc, spc.a);
  } else if (_t2 === 75) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = spcLsr(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 76) {
    const ad = spcFetch16(spc, m);
    const r = spcLsr(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 60) {
    spc.a = spcRol(spc, spc.a);
  } else if (_t2 === 43) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = spcRol(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 44) {
    const ad = spcFetch16(spc, m);
    const r = spcRol(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 124) {
    spc.a = spcRor(spc, spc.a);
  } else if (_t2 === 107) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const r = spcRor(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 108) {
    const ad = spcFetch16(spc, m);
    const r = spcRor(spc, spcRead(m, ad));
    spcWrite(m, ad, r);
  } else if (_t2 === 159) {
    spc.a = ((((Math.floor(spc.a / 2 ** (4)) | ((spc.a << 4) >>> 0)) >>> 0) & 255) >>> 0);
    spcNZ(spc, spc.a);
  } else if (_t2 === 186) {
    const d = spcFetch(spc, m);
    const w = readDpWord(spc, m, d);
    spc.a = ((w & 255) >>> 0);
    spc.y = ((Math.floor(w / 2 ** (8)) & 255) >>> 0);
    spcNZ16(spc, w);
  } else if (_t2 === 218) {
    const d = spcFetch(spc, m);
    writeDpWord(spc, m, d, ((((spc.y << 8) >>> 0) | spc.a) >>> 0));
  } else if (_t2 === 58) {
    const d = spcFetch(spc, m);
    const w = ((Math.trunc((readDpWord(spc, m, d) + 1)) & 65535) >>> 0);
    writeDpWord(spc, m, d, w);
    spcNZ16(spc, w);
  } else if (_t2 === 26) {
    const d = spcFetch(spc, m);
    const w = ((Math.trunc((readDpWord(spc, m, d) - 1)) & 65535) >>> 0);
    writeDpWord(spc, m, d, w);
    spcNZ16(spc, w);
  } else if (_t2 === 254) {
    const off = spcFetch(spc, m);
    spc.y = ((Math.trunc((spc.y - 1)) & 255) >>> 0);
    const soff = (() => {
    if ((off >= 128)) {
      return Math.trunc((off - 256));
    } else {
      return off;
    }
    })();
    if ((spc.y != 0)) {
      spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
    }
  } else if (_t2 === 110) {
    const ad = dpAddr(spc, spcFetch(spc, m));
    const off = spcFetch(spc, m);
    const v = ((Math.trunc((spcRead(m, ad) - 1)) & 255) >>> 0);
    spcWrite(m, ad, v);
    const soff = (() => {
    if ((off >= 128)) {
      return Math.trunc((off - 256));
    } else {
      return off;
    }
    })();
    if ((v != 0)) {
      spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
    }
  } else if (_t2 === 46) {
    const v = spcRead(m, dpAddr(spc, spcFetch(spc, m)));
    const off = spcFetch(spc, m);
    const soff = (() => {
    if ((off >= 128)) {
      return Math.trunc((off - 256));
    } else {
      return off;
    }
    })();
    if ((((spc.a & 255) >>> 0) != v)) {
      spc.pc = ((Math.trunc((spc.pc + soff)) & 65535) >>> 0);
    }
  } else if (_t2 === 95) {
    spc.pc = spcFetch16(spc, m);
  } else if (_t2 === 63) {
    const target = spcFetch16(spc, m);
    spcPush16(spc, m, spc.pc);
    spc.pc = target;
  } else if (_t2 === 111) {
    spc.pc = spcPull16(spc, m);
  } else if (_t2 === 1) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65502);
  } else if (_t2 === 17) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65500);
  } else if (_t2 === 33) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65498);
  } else if (_t2 === 49) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65496);
  } else if (_t2 === 65) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65494);
  } else if (_t2 === 81) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65492);
  } else if (_t2 === 97) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65490);
  } else if (_t2 === 113) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65488);
  } else if (_t2 === 129) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65486);
  } else if (_t2 === 145) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65484);
  } else if (_t2 === 161) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65482);
  } else if (_t2 === 177) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65480);
  } else if (_t2 === 193) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65478);
  } else if (_t2 === 209) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65476);
  } else if (_t2 === 225) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65474);
  } else if (_t2 === 241) {
    spcPush16(spc, m, spc.pc);
    spc.pc = spcRead16(m, 65472);
  } else if (_t2 === 79) {
    const u = spcFetch(spc, m);
    spcPush16(spc, m, spc.pc);
    spc.pc = ((65280 | u) >>> 0);
  } else if (_t2 === 31) {
    const addr = ((Math.trunc((spcFetch16(spc, m) + spc.x)) & 65535) >>> 0);
    spc.pc = spcRead16(m, addr);
  } else if (_t2 === 15) {
    spcPush16(spc, m, spc.pc);
    spcPush(spc, m, spc.psw);
    spcSetBit(spc, PB, true);
    spcSetBit(spc, PI, false);
    spc.pc = spcRead16(m, 65502);
  } else if (_t2 === 127) {
    spc.psw = spcPull(spc, m);
    spc.pc = spcPull16(spc, m);
  } else if (_t2 === 223) {
    spcDaa(spc);
  } else if (_t2 === 190) {
    spcDas(spc);
  } else if (_t2 === 158) {
    spcDiv(spc);
  } else if (_t2 === 62) {
    const v = readDp(spc, m);
    spcCmp(spc, spc.x, v);
  } else if (_t2 === 30) {
    const v = readAbs(spc, m);
    spcCmp(spc, spc.x, v);
  } else if (_t2 === 126) {
    const v = readDp(spc, m);
    spcCmp(spc, spc.y, v);
  } else if (_t2 === 94) {
    const v = readAbs(spc, m);
    spcCmp(spc, spc.y, v);
  } else if (_t2 === 3) {
    bbTest(spc, m, 0, true);
  } else if (_t2 === 35) {
    bbTest(spc, m, 1, true);
  } else if (_t2 === 67) {
    bbTest(spc, m, 2, true);
  } else if (_t2 === 99) {
    bbTest(spc, m, 3, true);
  } else if (_t2 === 131) {
    bbTest(spc, m, 4, true);
  } else if (_t2 === 163) {
    bbTest(spc, m, 5, true);
  } else if (_t2 === 195) {
    bbTest(spc, m, 6, true);
  } else if (_t2 === 227) {
    bbTest(spc, m, 7, true);
  } else if (_t2 === 19) {
    bbTest(spc, m, 0, false);
  } else if (_t2 === 51) {
    bbTest(spc, m, 1, false);
  } else if (_t2 === 83) {
    bbTest(spc, m, 2, false);
  } else if (_t2 === 115) {
    bbTest(spc, m, 3, false);
  } else if (_t2 === 147) {
    bbTest(spc, m, 4, false);
  } else if (_t2 === 179) {
    bbTest(spc, m, 5, false);
  } else if (_t2 === 211) {
    bbTest(spc, m, 6, false);
  } else if (_t2 === 243) {
    bbTest(spc, m, 7, false);
  } else if (_t2 === 25) {
    const a1 = dpAddr(spc, spc.x);
    const r = ((((spcRead(m, a1) | spcRead(m, dpAddr(spc, spc.y))) >>> 0) & 255) >>> 0);
    spcWrite(m, a1, r);
    spcNZ(spc, r);
  } else if (_t2 === 57) {
    const a1 = dpAddr(spc, spc.x);
    const r = ((((spcRead(m, a1) & spcRead(m, dpAddr(spc, spc.y))) >>> 0) & 255) >>> 0);
    spcWrite(m, a1, r);
    spcNZ(spc, r);
  } else if (_t2 === 89) {
    const a1 = dpAddr(spc, spc.x);
    const r = ((((spcRead(m, a1) ^ spcRead(m, dpAddr(spc, spc.y))) >>> 0) & 255) >>> 0);
    spcWrite(m, a1, r);
    spcNZ(spc, r);
  } else if (_t2 === 121) {
    const v1 = spcRead(m, dpAddr(spc, spc.x));
    const v2 = spcRead(m, dpAddr(spc, spc.y));
    spcCmp(spc, v1, v2);
  } else if (_t2 === 153) {
    const a1 = dpAddr(spc, spc.x);
    const r = aluAdcVal(spc, spcRead(m, a1), spcRead(m, dpAddr(spc, spc.y)));
    spcWrite(m, a1, r);
  } else if (_t2 === 185) {
    const a1 = dpAddr(spc, spc.x);
    const r = aluSbcVal(spc, spcRead(m, a1), spcRead(m, dpAddr(spc, spc.y)));
    spcWrite(m, a1, r);
  } else if (_t2 === 239) {
  } else if (_t2 === 255) {
  } else {
  }
}

function ppuZeros(n) {
  let v = [];
  let i = 0;
  while ((i < n)) {
    v.push(0);
    i = Math.trunc((i + 1));
  }
  return v;
}

function ppuZerosI64(n) {
  let v = [];
  let i = 0;
  while ((i < n)) {
    v.push(0);
    i = Math.trunc((i + 1));
  }
  return v;
}

function newPpu() {
  return new Ppu(ppuZeros(65536), ppuZeros(512), ppuZeros(1024), 0, 0, 0, 0, false, 0, 0, 0, 0, 0, 0, 0, ppuZerosI64(4), ppuZerosI64(4), 0, 0, 0, 0, 0, 0, 0, false, 31, 0, 256, 0, 0, 256, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, ppuZerosI64(224), ppuZerosI64(224), ppuZerosI64(224), ppuZerosI64(224), 0, 0, 0, 0, 0, 0, 0, 0, 0, ppuZerosI64(224), ppuZerosI64(224));
}

function vramStep(p) {
  const s = ((p.vmain & 3) >>> 0);
  if ((s == 0)) {
    return 1;
  }
  if ((s == 1)) {
    return 32;
  }
  return 128;
}

function ppuRegWrite(p, reg, val) {
  const v = ((val & 255) >>> 0);
  if ((reg == 0)) {
    p.inidisp = v;
    return;
  }
  if ((reg == 1)) {
    p.obsel = v;
    return;
  }
  if ((reg == 2)) {
    p.oamaddr = ((((p.oamaddr & 256) >>> 0) | v) >>> 0);
    p.oamHi = false;
    return;
  }
  if ((reg == 3)) {
    p.oamaddr = ((((((v & 1) >>> 0) << 8) >>> 0) | ((p.oamaddr & 255) >>> 0)) >>> 0);
    p.oamHi = false;
    return;
  }
  if ((reg == 4)) {
    const a = ((Math.trunc((p.oamaddr * 2)) & 1023) >>> 0);
    if ((!p.oamHi)) {
      p.oamLatch = v;
      p.oam[a] = (v & 0xFF);
      p.oamHi = true;
    } else {
      p.oam[((Math.trunc((a + 1)) & 1023) >>> 0)] = (v & 0xFF);
      p.oamaddr = ((Math.trunc((p.oamaddr + 1)) & 511) >>> 0);
      p.oamHi = false;
    }
    return;
  }
  if ((reg == 5)) {
    p.bgmode = v;
    return;
  }
  if ((reg == 7)) {
    p.bgsc0 = v;
    return;
  }
  if ((reg == 8)) {
    p.bgsc1 = v;
    return;
  }
  if ((reg == 9)) {
    p.bgsc2 = v;
    return;
  }
  if ((reg == 10)) {
    p.bgsc3 = v;
    return;
  }
  if ((reg == 11)) {
    p.bg12nba = v;
    return;
  }
  if ((reg == 12)) {
    p.bg34nba = v;
    return;
  }
  if (((reg >= 13) && (reg <= 20))) {
    const idx = Math.trunc(Math.trunc(Math.trunc((reg - 13)) / 2));
    const isV = (((Math.trunc((reg - 13)) & 1) >>> 0) == 1);
    if (isV) {
      p.bgvofs[idx] = ((((((v << 8) >>> 0) | p.scrollLatch) >>> 0) & 1023) >>> 0);
    } else {
      p.bghofs[idx] = ((((((((v << 8) >>> 0) | ((p.scrollLatch & 248) >>> 0)) >>> 0) | ((p.scrollHi & 7) >>> 0)) >>> 0) & 1023) >>> 0);
      p.scrollHi = v;
    }
    if ((reg == 13)) {
      p.m7hofs = m7Ext13(((((((v << 8) >>> 0) | p.m7Latch) >>> 0) & 8191) >>> 0));
      p.m7Latch = v;
    }
    if ((reg == 14)) {
      p.m7vofs = m7Ext13(((((((v << 8) >>> 0) | p.m7Latch) >>> 0) & 8191) >>> 0));
      p.m7Latch = v;
    }
    p.scrollLatch = v;
    return;
  }
  if ((reg == 21)) {
    p.vmain = v;
    return;
  }
  if ((reg == 22)) {
    p.vmaddr = ((((p.vmaddr & 32512) >>> 0) | v) >>> 0);
    return;
  }
  if ((reg == 23)) {
    p.vmaddr = ((((((v & 127) >>> 0) << 8) >>> 0) | ((p.vmaddr & 255) >>> 0)) >>> 0);
    return;
  }
  if ((reg == 24)) {
    const a = ((Math.trunc((p.vmaddr * 2)) & 65535) >>> 0);
    p.vram[a] = (v & 0xFF);
    if ((((p.vmain & 128) >>> 0) == 0)) {
      p.vmaddr = ((Math.trunc((p.vmaddr + vramStep(p))) & 32767) >>> 0);
    }
    return;
  }
  if ((reg == 25)) {
    const a = ((Math.trunc((Math.trunc((p.vmaddr * 2)) + 1)) & 65535) >>> 0);
    p.vram[a] = (v & 0xFF);
    if ((((p.vmain & 128) >>> 0) != 0)) {
      p.vmaddr = ((Math.trunc((p.vmaddr + vramStep(p))) & 32767) >>> 0);
    }
    return;
  }
  if ((reg == 33)) {
    p.cgaddr = v;
    p.cgHi = false;
    return;
  }
  if ((reg == 34)) {
    if ((!p.cgHi)) {
      p.cgLatch = v;
      p.cgHi = true;
    } else {
      const a = ((Math.trunc((p.cgaddr * 2)) & 511) >>> 0);
      p.cgram[a] = (p.cgLatch & 0xFF);
      p.cgram[((Math.trunc((a + 1)) & 511) >>> 0)] = (v & 0xFF);
      p.cgaddr = ((Math.trunc((p.cgaddr + 1)) & 255) >>> 0);
      p.cgHi = false;
    }
    return;
  }
  if ((reg == 26)) {
    p.m7sel = v;
    return;
  }
  if ((reg == 27)) {
    p.m7a = m7Ext16(((((v << 8) >>> 0) | p.m7Latch) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 28)) {
    p.m7b = m7Ext16(((((v << 8) >>> 0) | p.m7Latch) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 29)) {
    p.m7c = m7Ext16(((((v << 8) >>> 0) | p.m7Latch) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 30)) {
    p.m7d = m7Ext16(((((v << 8) >>> 0) | p.m7Latch) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 31)) {
    p.m7x = m7Ext13(((((((v << 8) >>> 0) | p.m7Latch) >>> 0) & 8191) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 32)) {
    p.m7y = m7Ext13(((((((v << 8) >>> 0) | p.m7Latch) >>> 0) & 8191) >>> 0));
    p.m7Latch = v;
    return;
  }
  if ((reg == 35)) {
    p.w12sel = v;
    return;
  }
  if ((reg == 36)) {
    p.w34sel = v;
    return;
  }
  if ((reg == 38)) {
    p.wh0 = v;
    return;
  }
  if ((reg == 39)) {
    p.wh1 = v;
    return;
  }
  if ((reg == 40)) {
    p.wh2 = v;
    return;
  }
  if ((reg == 41)) {
    p.wh3 = v;
    return;
  }
  if ((reg == 42)) {
    p.wbglog = v;
    return;
  }
  if ((reg == 44)) {
    p.tm = v;
    return;
  }
  if ((reg == 45)) {
    p.ts = v;
    return;
  }
  if ((reg == 46)) {
    p.tmw = v;
    return;
  }
  if ((reg == 47)) {
    p.tsw = v;
    return;
  }
  if ((reg == 49)) {
    p.cgadsub = v;
    return;
  }
  if ((reg == 50)) {
    const inten = ((v & 31) >>> 0);
    if ((((v & 32) >>> 0) != 0)) {
      p.coldR = inten;
    }
    if ((((v & 64) >>> 0) != 0)) {
      p.coldG = inten;
    }
    if ((((v & 128) >>> 0) != 0)) {
      p.coldB = inten;
    }
    return;
  }
}

function ppuRegRead(p, reg) {
  if ((reg == 56)) {
    const a = ((Math.trunc((p.oamaddr * 2)) & 1023) >>> 0);
    const r = Math.trunc(p.oam[a]);
    p.oamaddr = ((Math.trunc((p.oamaddr + 1)) & 511) >>> 0);
    return r;
  }
  if ((reg == 57)) {
    const a = ((Math.trunc((p.vmaddr * 2)) & 65535) >>> 0);
    return Math.trunc(p.vram[a]);
  }
  if ((reg == 58)) {
    const a = ((Math.trunc((Math.trunc((p.vmaddr * 2)) + 1)) & 65535) >>> 0);
    return Math.trunc(p.vram[a]);
  }
  if ((reg == 59)) {
    const a = ((Math.trunc((p.cgaddr * 2)) & 511) >>> 0);
    const r = Math.trunc(p.cgram[a]);
    p.cgaddr = ((Math.trunc((p.cgaddr + 1)) & 255) >>> 0);
    return r;
  }
  return 0;
}

function ppuRegReadPure(p, reg) {
  if ((reg == 56)) {
    return Math.trunc(p.oam[((Math.trunc((p.oamaddr * 2)) & 1023) >>> 0)]);
  }
  if ((reg == 57)) {
    return Math.trunc(p.vram[((Math.trunc((p.vmaddr * 2)) & 65535) >>> 0)]);
  }
  if ((reg == 58)) {
    return Math.trunc(p.vram[((Math.trunc((Math.trunc((p.vmaddr * 2)) + 1)) & 65535) >>> 0)]);
  }
  if ((reg == 59)) {
    return Math.trunc(p.cgram[((Math.trunc((p.cgaddr * 2)) & 511) >>> 0)]);
  }
  return 0;
}

function m7Ext16(v) {
  const x = ((v & 65535) >>> 0);
  return (() => {
  if ((x >= 32768)) {
    return Math.trunc((x - 65536));
  } else {
    return x;
  }
  })();
}

function m7Ext13(v) {
  const x = ((v & 8191) >>> 0);
  return (() => {
  if ((x >= 4096)) {
    return Math.trunc((x - 8192));
  } else {
    return x;
  }
  })();
}

function vramWord(p, waddr) {
  const b = ((Math.trunc((waddr * 2)) & 65535) >>> 0);
  return ((Math.trunc(p.vram[b]) | ((Math.trunc(p.vram[((Math.trunc((b + 1)) & 65535) >>> 0)]) << 8) >>> 0)) >>> 0);
}

function tile4bpp(p, charBase, tileNum, px, py) {
  const tb = ((Math.trunc((Math.trunc((charBase + Math.trunc((tileNum * 16)))) * 2)) & 65535) >>> 0);
  const r0 = ((Math.trunc((tb + Math.trunc((py * 2)))) & 65535) >>> 0);
  const p0 = Math.trunc(p.vram[r0]);
  const p1 = Math.trunc(p.vram[((Math.trunc((r0 + 1)) & 65535) >>> 0)]);
  const p2 = Math.trunc(p.vram[((Math.trunc((r0 + 16)) & 65535) >>> 0)]);
  const p3 = Math.trunc(p.vram[((Math.trunc((r0 + 17)) & 65535) >>> 0)]);
  const bit = Math.trunc((7 - px));
  return ((((((((Math.floor(p0 / 2 ** (bit)) & 1) >>> 0) | ((((Math.floor(p1 / 2 ** (bit)) & 1) >>> 0) << 1) >>> 0)) >>> 0) | ((((Math.floor(p2 / 2 ** (bit)) & 1) >>> 0) << 2) >>> 0)) >>> 0) | ((((Math.floor(p3 / 2 ** (bit)) & 1) >>> 0) << 3) >>> 0)) >>> 0);
}

function tile8bpp(p, charBase, tileNum, px, py) {
  const tb = ((Math.trunc((Math.trunc((charBase + Math.trunc((tileNum * 32)))) * 2)) & 65535) >>> 0);
  const r0 = ((Math.trunc((tb + Math.trunc((py * 2)))) & 65535) >>> 0);
  const bit = Math.trunc((7 - px));
  let ci = 0;
  let plane = 0;
  while ((plane < 4)) {
    const a = ((Math.trunc((r0 + Math.trunc((plane * 16)))) & 65535) >>> 0);
    const lo = Math.trunc(p.vram[a]);
    const hi = Math.trunc(p.vram[((Math.trunc((a + 1)) & 65535) >>> 0)]);
    ci = ((((ci | ((((Math.floor(lo / 2 ** (bit)) & 1) >>> 0) << Math.trunc((plane * 2))) >>> 0)) >>> 0) | ((((Math.floor(hi / 2 ** (bit)) & 1) >>> 0) << Math.trunc((Math.trunc((plane * 2)) + 1))) >>> 0)) >>> 0);
    plane = Math.trunc((plane + 1));
  }
  return ci;
}

function lineBrightAt(p, y, deflt) {
  if (p.hdmaOn) {
    return p.lineBright[y];
  }
  return deflt;
}

function windowMasked(p, layerIdx, screenDisable, x, y) {
  if ((((screenDisable & ((1 << layerIdx) >>> 0)) >>> 0) == 0)) {
    return false;
  }
  const sel = (() => {
  if ((layerIdx < 2)) {
    return p.w12sel;
  } else {
    return p.w34sel;
  }
  })();
  const shift = Math.trunc((((layerIdx & 1) >>> 0) * 4));
  const w1en = (((Math.floor(sel / 2 ** (shift)) & 1) >>> 0) != 0);
  const w1inv = (((Math.floor(sel / 2 ** (Math.trunc((shift + 1)))) & 1) >>> 0) != 0);
  const w2en = (((Math.floor(sel / 2 ** (Math.trunc((shift + 2)))) & 1) >>> 0) != 0);
  const w2inv = (((Math.floor(sel / 2 ** (Math.trunc((shift + 3)))) & 1) >>> 0) != 0);
  if (((!w1en) && (!w2en))) {
    return false;
  }
  const lo1 = (() => {
  if (p.hdmaOn) {
    return p.lineWH0[y];
  } else {
    return p.wh0;
  }
  })();
  const hi1 = (() => {
  if (p.hdmaOn) {
    return p.lineWH1[y];
  } else {
    return p.wh1;
  }
  })();
  let in1 = ((x >= lo1) && (x <= hi1));
  if (w1inv) {
    in1 = (!in1);
  }
  let in2 = ((x >= p.wh2) && (x <= p.wh3));
  if (w2inv) {
    in2 = (!in2);
  }
  if ((w1en && w2en)) {
    const logic = ((Math.floor(p.wbglog / 2 ** (Math.trunc((layerIdx * 2)))) & 3) >>> 0);
    if ((logic == 1)) {
      return (in1 && in2);
    }
    if ((logic == 2)) {
      return (in1 != in2);
    }
    if ((logic == 3)) {
      return (in1 == in2);
    }
    return (in1 || in2);
  }
  if (w1en) {
    return in1;
  }
  return in2;
}

function cgToRgb(p, idx, bright) {
  const a = ((Math.trunc((idx * 2)) & 511) >>> 0);
  const w = ((Math.trunc(p.cgram[a]) | ((Math.trunc(p.cgram[((Math.trunc((a + 1)) & 511) >>> 0)]) << 8) >>> 0)) >>> 0);
  let r = ((((w & 31) >>> 0) << 3) >>> 0);
  let g = ((((Math.floor(w / 2 ** (5)) & 31) >>> 0) << 3) >>> 0);
  let b = ((((Math.floor(w / 2 ** (10)) & 31) >>> 0) << 3) >>> 0);
  r = Math.trunc(Math.trunc(Math.trunc((r * bright)) / 15));
  g = Math.trunc(Math.trunc(Math.trunc((g * bright)) / 15));
  b = Math.trunc(Math.trunc(Math.trunc((b * bright)) / 15));
  return ((((((r << 16) >>> 0) | ((g << 8) >>> 0)) >>> 0) | b) >>> 0);
}

function renderSprites(p, fb, bright, wantPrio) {
  const objBase = ((((p.obsel & 7) >>> 0) << 13) >>> 0);
  let s = 127;
  while ((s >= 0)) {
    const oa = Math.trunc((s * 4));
    const xl = Math.trunc(p.oam[oa]);
    const y = Math.trunc(p.oam[Math.trunc((oa + 1))]);
    const tileL = Math.trunc(p.oam[Math.trunc((oa + 2))]);
    const attr = Math.trunc(p.oam[Math.trunc((oa + 3))]);
    if (((wantPrio >= 0) && (((Math.floor(attr / 2 ** (4)) & 3) >>> 0) != wantPrio))) {
      s = Math.trunc((s - 1));
      continue;
    }
    const ht = Math.trunc(p.oam[Math.trunc((512 + Math.floor(s / 2 ** (2))))]);
    const shift = Math.trunc((((s & 3) >>> 0) * 2));
    const xhi = ((Math.floor(ht / 2 ** (shift)) & 1) >>> 0);
    const large = ((Math.floor(ht / 2 ** (Math.trunc((shift + 1)))) & 1) >>> 0);
    let sx = ((xl | ((xhi << 8) >>> 0)) >>> 0);
    if ((sx >= 256)) {
      sx = Math.trunc((sx - 512));
    }
    const dim = (() => {
    if ((large != 0)) {
      return 16;
    } else {
      return 8;
    }
    })();
    const pal = ((Math.floor(attr / 2 ** (1)) & 7) >>> 0);
    const hflip = ((Math.floor(attr / 2 ** (6)) & 1) >>> 0);
    const vflip = ((Math.floor(attr / 2 ** (7)) & 1) >>> 0);
    const tileNum = ((tileL | ((((attr & 1) >>> 0) << 8) >>> 0)) >>> 0);
    let oy = 0;
    while ((oy < dim)) {
      const scrY = Math.trunc((y + oy));
      if (((scrY >= 0) && (scrY < 224))) {
        let ox = 0;
        while ((ox < dim)) {
          const scrX = Math.trunc((sx + ox));
          if (((scrX >= 0) && (scrX < 256))) {
            let tx = ox;
            let ty = oy;
            if ((hflip != 0)) {
              tx = Math.trunc((Math.trunc((dim - 1)) - ox));
            }
            if ((vflip != 0)) {
              ty = Math.trunc((Math.trunc((dim - 1)) - oy));
            }
            const t = Math.trunc((Math.trunc((tileNum + Math.trunc((Math.floor(ty / 2 ** (3)) * 16)))) + Math.floor(tx / 2 ** (3))));
            const ci = tile4bpp(p, objBase, ((t & 511) >>> 0), ((tx & 7) >>> 0), ((ty & 7) >>> 0));
            if ((ci != 0)) {
              fb[Math.trunc((Math.trunc((scrY * 256)) + scrX))] = cgToRgb(p, Math.trunc((Math.trunc((128 + Math.trunc((pal * 16)))) + ci)), lineBrightAt(p, scrY, bright));
            }
          }
          ox = Math.trunc((ox + 1));
        }
      }
      oy = Math.trunc((oy + 1));
    }
    s = Math.trunc((s - 1));
  }
}

function tile2bpp(p, charBase, tileNum, px, py) {
  const tb = ((Math.trunc((Math.trunc((charBase + Math.trunc((tileNum * 8)))) * 2)) & 65535) >>> 0);
  const r0 = ((Math.trunc((tb + Math.trunc((py * 2)))) & 65535) >>> 0);
  const p0 = Math.trunc(p.vram[r0]);
  const p1 = Math.trunc(p.vram[((Math.trunc((r0 + 1)) & 65535) >>> 0)]);
  const bit = Math.trunc((7 - px));
  return ((((Math.floor(p0 / 2 ** (bit)) & 1) >>> 0) | ((((Math.floor(p1 / 2 ** (bit)) & 1) >>> 0) << 1) >>> 0)) >>> 0);
}

function bgEntryAddr(tmBase, sc, tileX, tileY) {
  const nh = (() => {
  if ((((sc & 1) >>> 0) != 0)) {
    return 2;
  } else {
    return 1;
  }
  })();
  const sx = (() => {
  if ((tileX >= 32)) {
    return 1;
  } else {
    return 0;
  }
  })();
  const sy = (() => {
  if ((tileY >= 32)) {
    return 1;
  } else {
    return 0;
  }
  })();
  const quad = Math.trunc((sx + Math.trunc((sy * nh))));
  return Math.trunc((Math.trunc((Math.trunc((tmBase + Math.trunc((quad * 1024)))) + Math.trunc((((tileY & 31) >>> 0) * 32)))) + ((tileX & 31) >>> 0)));
}

function renderBGLayer(p, fb, bright, sc, chBase, hofs, vofs, bpp, palBase, layerIdx, screenDisable, wantPrio) {
  const palW = (() => {
  if ((bpp == 4)) {
    return 16;
  } else {
    return 4;
  }
  })();
  const tmBase = ((((sc & 252) >>> 0) << 8) >>> 0);
  const maskX = (() => {
  if ((((sc & 1) >>> 0) != 0)) {
    return 511;
  } else {
    return 255;
  }
  })();
  const maskY = (() => {
  if ((((sc & 2) >>> 0) != 0)) {
    return 511;
  } else {
    return 255;
  }
  })();
  let y = 0;
  while ((y < 224)) {
    let x = 0;
    while ((x < 256)) {
      if (windowMasked(p, layerIdx, screenDisable, x, y)) {
        x = Math.trunc((x + 1));
        continue;
      }
      const ex = ((Math.trunc((x + hofs)) & maskX) >>> 0);
      const ey = ((Math.trunc((y + vofs)) & maskY) >>> 0);
      const entry = vramWord(p, bgEntryAddr(tmBase, sc, Math.floor(ex / 2 ** (3)), Math.floor(ey / 2 ** (3))));
      if (((wantPrio >= 0) && (((Math.floor(entry / 2 ** (13)) & 1) >>> 0) != wantPrio))) {
        x = Math.trunc((x + 1));
        continue;
      }
      const tileNum = ((entry & 1023) >>> 0);
      const pal = ((Math.floor(entry / 2 ** (10)) & 7) >>> 0);
      let px = ((ex & 7) >>> 0);
      let py = ((ey & 7) >>> 0);
      if ((((Math.floor(entry / 2 ** (14)) & 1) >>> 0) != 0)) {
        px = Math.trunc((7 - px));
      }
      if ((((Math.floor(entry / 2 ** (15)) & 1) >>> 0) != 0)) {
        py = Math.trunc((7 - py));
      }
      const ci = (() => {
      if ((bpp == 8)) {
        return tile8bpp(p, chBase, tileNum, px, py);
      } else {
        return (() => {
        if ((bpp == 4)) {
          return tile4bpp(p, chBase, tileNum, px, py);
        } else {
          return tile2bpp(p, chBase, tileNum, px, py);
        }
        })();
      }
      })();
      if ((ci != 0)) {
        const colorIdx = (() => {
        if ((bpp == 8)) {
          return ci;
        } else {
          return Math.trunc((Math.trunc((palBase + Math.trunc((pal * palW)))) + ci));
        }
        })();
        fb[Math.trunc((Math.trunc((y * 256)) + x))] = cgToRgb(p, colorIdx, lineBrightAt(p, y, bright));
      }
      x = Math.trunc((x + 1));
    }
    y = Math.trunc((y + 1));
  }
}

function renderMode7(p, fb, bright) {
  const ox = Math.trunc((p.m7hofs - p.m7x));
  const oy = Math.trunc((p.m7vofs - p.m7y));
  let sy = 0;
  while ((sy < 224)) {
    let sx = 0;
    while ((sx < 256)) {
      const dx = Math.trunc((ox + sx));
      const dy = Math.trunc((oy + sy));
      const vx = Math.trunc((Math.floor(Math.trunc((Math.trunc((p.m7a * dx)) + Math.trunc((p.m7b * dy)))) / 2 ** (8)) + p.m7x));
      const vy = Math.trunc((Math.floor(Math.trunc((Math.trunc((p.m7c * dx)) + Math.trunc((p.m7d * dy)))) / 2 ** (8)) + p.m7y));
      const px = ((vx & 1023) >>> 0);
      const py = ((vy & 1023) >>> 0);
      const tileX = Math.floor(px / 2 ** (3));
      const tileY = Math.floor(py / 2 ** (3));
      const mapN = Math.trunc((Math.trunc((tileY * 128)) + tileX));
      const tile = Math.trunc(p.vram[((Math.trunc((mapN * 2)) & 65535) >>> 0)]);
      const gAddr = ((Math.trunc((Math.trunc((Math.trunc((Math.trunc((Math.trunc((tile * 64)) + Math.trunc((((py & 7) >>> 0) * 8)))) + ((px & 7) >>> 0))) * 2)) + 1)) & 65535) >>> 0);
      const ci = Math.trunc(p.vram[gAddr]);
      if ((ci != 0)) {
        fb[Math.trunc((Math.trunc((sy * 256)) + sx))] = cgToRgb(p, ci, lineBrightAt(p, sy, bright));
      }
      sx = Math.trunc((sx + 1));
    }
    sy = Math.trunc((sy + 1));
  }
}

function renderScreenBGs(p, fb, bright, enable, screenDisable) {
  const ch1 = ((((p.bg12nba & 15) >>> 0) << 12) >>> 0);
  const ch2 = ((((Math.floor(p.bg12nba / 2 ** (4)) & 15) >>> 0) << 12) >>> 0);
  const ch3 = ((((p.bg34nba & 15) >>> 0) << 12) >>> 0);
  const ch4 = ((((Math.floor(p.bg34nba / 2 ** (4)) & 15) >>> 0) << 12) >>> 0);
  const mode = ((p.bgmode & 7) >>> 0);
  const en1 = (((enable & 1) >>> 0) != 0);
  const en2 = (((enable & 2) >>> 0) != 0);
  const en3 = (((enable & 4) >>> 0) != 0);
  const en4 = (((enable & 8) >>> 0) != 0);
  if ((mode == 0)) {
    if (en4) {
      renderBGLayer(p, fb, bright, p.bgsc3, ch4, p.bghofs[3], p.bgvofs[3], 2, 96, 3, screenDisable, (-1));
    }
    if (en3) {
      renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 64, 2, screenDisable, (-1));
    }
    if (en2) {
      renderBGLayer(p, fb, bright, p.bgsc1, ch2, p.bghofs[1], p.bgvofs[1], 2, 32, 1, screenDisable, (-1));
    }
    if (en1) {
      renderBGLayer(p, fb, bright, p.bgsc0, ch1, p.bghofs[0], p.bgvofs[0], 2, 0, 0, screenDisable, (-1));
    }
  } else {
    if ((mode == 7)) {
      if (en1) {
        renderMode7(p, fb, bright);
      }
    } else {
      if ((mode == 3)) {
        if (en2) {
          renderBGLayer(p, fb, bright, p.bgsc1, ch2, p.bghofs[1], p.bgvofs[1], 4, 0, 1, screenDisable, (-1));
        }
        if (en1) {
          renderBGLayer(p, fb, bright, p.bgsc0, ch1, p.bghofs[0], p.bgvofs[0], 8, 0, 0, screenDisable, (-1));
        }
      } else {
        if (en3) {
          renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 0, 2, screenDisable, (-1));
        }
        if (en2) {
          renderBGLayer(p, fb, bright, p.bgsc1, ch2, p.bghofs[1], p.bgvofs[1], 4, 0, 1, screenDisable, (-1));
        }
        if (en1) {
          renderBGLayer(p, fb, bright, p.bgsc0, ch1, p.bghofs[0], p.bgvofs[0], 4, 0, 0, screenDisable, (-1));
        }
      }
    }
  }
}

function clamp5(v) {
  if ((v < 0)) {
    return 0;
  }
  if ((v > 31)) {
    return 31;
  }
  return v;
}

function backdropColor(p, bright) {
  const w = ((Math.trunc(p.cgram[0]) | ((Math.trunc(p.cgram[1]) << 8) >>> 0)) >>> 0);
  let r = ((w & 31) >>> 0);
  let g = ((Math.floor(w / 2 ** (5)) & 31) >>> 0);
  let b = ((Math.floor(w / 2 ** (10)) & 31) >>> 0);
  if (((((p.cgadsub & 32) >>> 0) != 0) && (((p.cgadsub & 128) >>> 0) == 0))) {
    r = clamp5(Math.trunc((r + p.coldR)));
    g = clamp5(Math.trunc((g + p.coldG)));
    b = clamp5(Math.trunc((b + p.coldB)));
  }
  const rr = ((Math.trunc(Math.trunc(Math.trunc((((r << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  const gg = ((Math.trunc(Math.trunc(Math.trunc((((g << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  const bb = ((Math.trunc(Math.trunc(Math.trunc((((b << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  return ((((((rr << 16) >>> 0) | ((gg << 8) >>> 0)) >>> 0) | bb) >>> 0);
}

function backdropColorLine(p, y, deflt) {
  const bright = lineBrightAt(p, y, deflt);
  const w = ((Math.trunc(p.cgram[0]) | ((Math.trunc(p.cgram[1]) << 8) >>> 0)) >>> 0);
  let r = ((w & 31) >>> 0);
  let g = ((Math.floor(w / 2 ** (5)) & 31) >>> 0);
  let b = ((Math.floor(w / 2 ** (10)) & 31) >>> 0);
  if (((((p.cgadsub & 32) >>> 0) != 0) && (((p.cgadsub & 128) >>> 0) == 0))) {
    r = clamp5(Math.trunc((r + p.lineColdR[y])));
    g = clamp5(Math.trunc((g + p.lineColdG[y])));
    b = clamp5(Math.trunc((b + p.lineColdB[y])));
  }
  const rr = ((Math.trunc(Math.trunc(Math.trunc((((r << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  const gg = ((Math.trunc(Math.trunc(Math.trunc((((g << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  const bb = ((Math.trunc(Math.trunc(Math.trunc((((b << 3) >>> 0) * bright)) / 15)) & 255) >>> 0);
  return ((((((rr << 16) >>> 0) | ((gg << 8) >>> 0)) >>> 0) | bb) >>> 0);
}

function renderMode1Main(p, fb, bright) {
  const ch1 = ((((p.bg12nba & 15) >>> 0) << 12) >>> 0);
  const ch2 = ((((Math.floor(p.bg12nba / 2 ** (4)) & 15) >>> 0) << 12) >>> 0);
  const ch3 = ((((p.bg34nba & 15) >>> 0) << 12) >>> 0);
  const en1 = (((p.tm & 1) >>> 0) != 0);
  const en2 = (((p.tm & 2) >>> 0) != 0);
  const en3 = (((p.tm & 4) >>> 0) != 0);
  const enObj = (((p.tm & 16) >>> 0) != 0);
  const d = p.tmw;
  const bg3High = (((p.bgmode & 8) >>> 0) != 0);
  if ((en3 && (!bg3High))) {
    renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 0, 2, d, 0);
  }
  if (enObj) {
    renderSprites(p, fb, bright, 0);
  }
  if (en3) {
    if ((!bg3High)) {
      renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 0, 2, d, 1);
    } else {
      renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 0, 2, d, 0);
    }
  }
  if (enObj) {
    renderSprites(p, fb, bright, 1);
  }
  if (en2) {
    renderBGLayer(p, fb, bright, p.bgsc1, ch2, p.bghofs[1], p.bgvofs[1], 4, 0, 1, d, 0);
  }
  if (en1) {
    renderBGLayer(p, fb, bright, p.bgsc0, ch1, p.bghofs[0], p.bgvofs[0], 4, 0, 0, d, 0);
  }
  if (enObj) {
    renderSprites(p, fb, bright, 2);
  }
  if (en2) {
    renderBGLayer(p, fb, bright, p.bgsc1, ch2, p.bghofs[1], p.bgvofs[1], 4, 0, 1, d, 1);
  }
  if (en1) {
    renderBGLayer(p, fb, bright, p.bgsc0, ch1, p.bghofs[0], p.bgvofs[0], 4, 0, 0, d, 1);
  }
  if (enObj) {
    renderSprites(p, fb, bright, 3);
  }
  if ((en3 && bg3High)) {
    renderBGLayer(p, fb, bright, p.bgsc2, ch3, p.bghofs[2], p.bgvofs[2], 2, 0, 2, d, 1);
  }
}

function renderFrame(p, fb) {
  const bright = ((p.inidisp & 15) >>> 0);
  const forceBlank = (((p.inidisp & 128) >>> 0) != 0);
  const constBackdrop = (() => {
  if (forceBlank) {
    return 0;
  } else {
    return backdropColor(p, bright);
  }
  })();
  let y = 0;
  while ((y < 224)) {
    const bd = (() => {
    if (((!forceBlank) && p.hdmaOn)) {
      return backdropColorLine(p, y, bright);
    } else {
      return constBackdrop;
    }
    })();
    let x = 0;
    while ((x < 256)) {
      fb[Math.trunc((Math.trunc((y * 256)) + x))] = bd;
      x = Math.trunc((x + 1));
    }
    y = Math.trunc((y + 1));
  }
  if (forceBlank) {
    return;
  }
  if ((p.ts != 0)) {
    renderScreenBGs(p, fb, bright, p.ts, p.tsw);
  }
  if ((((p.bgmode & 7) >>> 0) == 1)) {
    renderMode1Main(p, fb, bright);
  } else {
    renderScreenBGs(p, fb, bright, p.tm, p.tmw);
    if ((((((p.tm | p.ts) >>> 0) & 16) >>> 0) != 0)) {
      renderSprites(p, fb, bright, (-1));
    }
  }
}

function ppuVram(p, a) {
  return Math.trunc(p.vram[((a & 65535) >>> 0)]);
}

function ppuCgram(p, a) {
  return Math.trunc(p.cgram[((a & 511) >>> 0)]);
}

function u16At(data, i) {
  return ((Math.trunc(data[i]) | ((Math.trunc(data[Math.trunc((i + 1))]) << 8) >>> 0)) >>> 0);
}

function scoreHeader(data, base, wantHi) {
  if ((Math.trunc((base + 32)) > data.length)) {
    return (-1);
  }
  let score = 0;
  const comp = u16At(data, Math.trunc((base + 28)));
  const chk = u16At(data, Math.trunc((base + 30)));
  if (((((Math.trunc((comp + chk)) & 65535) >>> 0) == 65535) && (chk != 0))) {
    score = Math.trunc((score + 8));
  }
  const mode = Math.trunc(data[Math.trunc((base + 21))]);
  const modeHi = (((mode & 1) >>> 0) == 1);
  if ((modeHi == wantHi)) {
    score = Math.trunc((score + 4));
  }
  const reset = u16At(data, Math.trunc((base + 60)));
  if ((reset >= 32768)) {
    score = Math.trunc((score + 1));
  }
  return score;
}

function parseCart(raw) {
  let start = 0;
  if (((raw.length % 32768) == 512)) {
    start = 512;
  }
  let data = [];
  let i = start;
  while ((i < raw.length)) {
    data.push(raw[i]);
    i = Math.trunc((i + 1));
  }
  if ((data.length < 32768)) {
    return Result_Cart_string.Err("ROM too small");
  }
  const loScore = scoreHeader(data, 32704, false);
  const hiScore = scoreHeader(data, 65472, true);
  let mapMode = 0;
  if ((hiScore > loScore)) {
    mapMode = 1;
  }
  return Result_Cart_string.Ok(new Cart(data, mapMode));
}

function Cpu$Eq$eq(self, other) {
  return ((((((((((self.a == other.a) && (self.x == other.x)) && (self.y == other.y)) && (self.s == other.s)) && (self.d == other.d)) && (self.pc == other.pc)) && (self.p == other.p)) && (self.dbr == other.dbr)) && (self.pbr == other.pbr)) && (self.e == other.e));
}

function Spc$Eq$eq(self, other) {
  return ((((((self.a == other.a) && (self.x == other.x)) && (self.y == other.y)) && (self.sp == other.sp)) && (self.pc == other.pc)) && (self.psw == other.psw));
}

main();
__flush();
