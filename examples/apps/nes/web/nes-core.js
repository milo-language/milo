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

class NesHandle {
  constructor(cpu, bus) {
    this.cpu = cpu;
    this.bus = bus;
  }
}

class Bus {
  constructor(ram, wram, prg, prgMask, ppu, apu, ctrl1, strobe, buttons, mapper, prgBanks, prgBank, mmc2Prg, m227Lo, m227Hi, mmcSelect, mmcR0, mmcR1, mmcR2, mmcR3, mmcR4, mmcR5, mmcR6, mmcR7, irqLatch, irqCounter, irqReload, irqEnabled, irqPending) {
    this.ram = ram;
    this.wram = wram;
    this.prg = prg;
    this.prgMask = prgMask;
    this.ppu = ppu;
    this.apu = apu;
    this.ctrl1 = ctrl1;
    this.strobe = strobe;
    this.buttons = buttons;
    this.mapper = mapper;
    this.prgBanks = prgBanks;
    this.prgBank = prgBank;
    this.mmc2Prg = mmc2Prg;
    this.m227Lo = m227Lo;
    this.m227Hi = m227Hi;
    this.mmcSelect = mmcSelect;
    this.mmcR0 = mmcR0;
    this.mmcR1 = mmcR1;
    this.mmcR2 = mmcR2;
    this.mmcR3 = mmcR3;
    this.mmcR4 = mmcR4;
    this.mmcR5 = mmcR5;
    this.mmcR6 = mmcR6;
    this.mmcR7 = mmcR7;
    this.irqLatch = irqLatch;
    this.irqCounter = irqCounter;
    this.irqReload = irqReload;
    this.irqEnabled = irqEnabled;
    this.irqPending = irqPending;
  }
}

class Cpu {
  constructor(a, x, y, sp, p, pc, cyc, extraCycles, unknownSeen) {
    this.a = a;
    this.x = x;
    this.y = y;
    this.sp = sp;
    this.p = p;
    this.pc = pc;
    this.cyc = cyc;
    this.extraCycles = extraCycles;
    this.unknownSeen = unknownSeen;
  }
}

class Cartridge {
  constructor(prg, chr, mapper, mirrorVertical, hasBattery, prg16kBanks, chr8kBanks) {
    this.prg = prg;
    this.chr = chr;
    this.mapper = mapper;
    this.mirrorVertical = mirrorVertical;
    this.hasBattery = hasBattery;
    this.prg16kBanks = prg16kBanks;
    this.chr8kBanks = chr8kBanks;
  }
}

class Ppu {
  constructor(chr, chrBankOffset, vram, palette, oam, mirrorVertical, ctrl, mask, status, oamAddr, v, t, fineX, w, readBuffer, scanline, dot, frame, nmiPending, scrollX, scrollY, mmc2, mmc2Latch0, mmc2Latch1, mmc2ChrFD0, mmc2ChrFE0, mmc2ChrFD1, mmc2ChrFE1, fb) {
    this.chr = chr;
    this.chrBankOffset = chrBankOffset;
    this.vram = vram;
    this.palette = palette;
    this.oam = oam;
    this.mirrorVertical = mirrorVertical;
    this.ctrl = ctrl;
    this.mask = mask;
    this.status = status;
    this.oamAddr = oamAddr;
    this.v = v;
    this.t = t;
    this.fineX = fineX;
    this.w = w;
    this.readBuffer = readBuffer;
    this.scanline = scanline;
    this.dot = dot;
    this.frame = frame;
    this.nmiPending = nmiPending;
    this.scrollX = scrollX;
    this.scrollY = scrollY;
    this.mmc2 = mmc2;
    this.mmc2Latch0 = mmc2Latch0;
    this.mmc2Latch1 = mmc2Latch1;
    this.mmc2ChrFD0 = mmc2ChrFD0;
    this.mmc2ChrFE0 = mmc2ChrFE0;
    this.mmc2ChrFD1 = mmc2ChrFD1;
    this.mmc2ChrFE1 = mmc2ChrFE1;
    this.fb = fb;
  }
}

class Pulse {
  constructor(enabled, duty, dutyPos, lengthHalt, constant, volume, timerPeriod, timerVal, length, envStart, envDivider, envDecay, sweepEnabled, sweepPeriod, sweepNegate, sweepShift, sweepReload, sweepDivider, isPulse2) {
    this.enabled = enabled;
    this.duty = duty;
    this.dutyPos = dutyPos;
    this.lengthHalt = lengthHalt;
    this.constant = constant;
    this.volume = volume;
    this.timerPeriod = timerPeriod;
    this.timerVal = timerVal;
    this.length = length;
    this.envStart = envStart;
    this.envDivider = envDivider;
    this.envDecay = envDecay;
    this.sweepEnabled = sweepEnabled;
    this.sweepPeriod = sweepPeriod;
    this.sweepNegate = sweepNegate;
    this.sweepShift = sweepShift;
    this.sweepReload = sweepReload;
    this.sweepDivider = sweepDivider;
    this.isPulse2 = isPulse2;
  }
}

class Triangle {
  constructor(enabled, control, length, linearReload, linearCounter, linearReloadFlag, timerPeriod, timerVal, seqPos) {
    this.enabled = enabled;
    this.control = control;
    this.length = length;
    this.linearReload = linearReload;
    this.linearCounter = linearCounter;
    this.linearReloadFlag = linearReloadFlag;
    this.timerPeriod = timerPeriod;
    this.timerVal = timerVal;
    this.seqPos = seqPos;
  }
}

class Noise {
  constructor(enabled, lengthHalt, constant, volume, length, envStart, envDivider, envDecay, mode, timerPeriod, timerVal, shift) {
    this.enabled = enabled;
    this.lengthHalt = lengthHalt;
    this.constant = constant;
    this.volume = volume;
    this.length = length;
    this.envStart = envStart;
    this.envDivider = envDivider;
    this.envDecay = envDecay;
    this.mode = mode;
    this.timerPeriod = timerPeriod;
    this.timerVal = timerVal;
    this.shift = shift;
  }
}

class Dmc {
  constructor(enabled, irqEnabled, loopFlag, rate, timer, output, sampleAddr, sampleLen, curAddr, bytesRemaining, shiftReg, bitsRemaining, bufferByte, bufferEmpty, silence, needsFetch, irqFlag) {
    this.enabled = enabled;
    this.irqEnabled = irqEnabled;
    this.loopFlag = loopFlag;
    this.rate = rate;
    this.timer = timer;
    this.output = output;
    this.sampleAddr = sampleAddr;
    this.sampleLen = sampleLen;
    this.curAddr = curAddr;
    this.bytesRemaining = bytesRemaining;
    this.shiftReg = shiftReg;
    this.bitsRemaining = bitsRemaining;
    this.bufferByte = bufferByte;
    this.bufferEmpty = bufferEmpty;
    this.silence = silence;
    this.needsFetch = needsFetch;
    this.irqFlag = irqFlag;
  }
}

class Apu {
  constructor(pulse1, pulse2, triangle, noise, dmc, frameMode, frameInhibit, frameIrq, frameCycle, cpuParity, sampleAccum, samples, pulseTable, tndTable, hpPrevIn, hpPrevOut) {
    this.pulse1 = pulse1;
    this.pulse2 = pulse2;
    this.triangle = triangle;
    this.noise = noise;
    this.dmc = dmc;
    this.frameMode = frameMode;
    this.frameInhibit = frameInhibit;
    this.frameIrq = frameIrq;
    this.frameCycle = frameCycle;
    this.cpuParity = cpuParity;
    this.sampleAccum = sampleAccum;
    this.samples = samples;
    this.pulseTable = pulseTable;
    this.tndTable = tndTable;
    this.hpPrevIn = hpPrevIn;
    this.hpPrevOut = hpPrevOut;
  }
}

const Result_Cartridge_string = {
  Ok(_0) { return { tag: 0, data: [_0] }; },
  Err(_0) { return { tag: 1, data: [_0] }; },
};

const __enumMeta = {
  "Result_Cartridge_string": [["Ok", 1], ["Err", 1]],
  "Option": [["Some", 1], ["None", 0]],
  "Result": [["Ok", 1], ["Err", 1]]
};

const FC = 1;
const FZ = 2;
const FI = 4;
const FD = 8;
const FB = 16;
const FU = 32;
const FV = 64;
const FN = 128;
const PRG_BANK = 16384;
const CHR_BANK = 8192;
const HEADER = 16;
const TRAINER = 512;
const NESPAL = [5526612, 7796, 528528, 3145864, 4456548, 6029360, 5506048, 3938304, 2107904, 539136, 16384, 15360, 12860, 0, 0, 0, 10000024, 543940, 3158764, 6037220, 8918192, 10490980, 9970208, 7879680, 5528064, 2650624, 556032, 30248, 26232, 0, 0, 0, 15527660, 5020396, 7896300, 11559660, 14963948, 15489204, 15493732, 13928480, 10529280, 7652352, 5034016, 3722348, 3716300, 3947580, 0, 0, 15527660, 11062508, 12369132, 13939436, 15511276, 15511252, 15512752, 14992528, 13423224, 11853432, 11068048, 10019508, 10540772, 10527392, 0, 0];
const CYCLES_PER_SAMPLE = 40.58442176870748;
const LENGTH_TABLE = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const TRIANGLE_SEQ = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const DUTY_TABLE = [0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1];

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

function fallbackCart() {
  let prg = [];
  let i = 0;
  while ((i < 16384)) {
    if ((i == 16380)) {
      prg.push((0 & 0xFF));
    } else {
      if ((i == 16381)) {
        prg.push((128 & 0xFF));
      } else {
        prg.push((234 & 0xFF));
      }
    }
    i = Math.trunc((i + 1));
  }
  let chr = [];
  i = 0;
  while ((i < 8192)) {
    chr.push((0 & 0xFF));
    i = Math.trunc((i + 1));
  }
  return new Cartridge(prg, chr, 0, false, false, 1, 1);
}

function createNes(rom) {
  let cart = fallbackCart();
  const _t0 = parseCartridge(rom);
  if (_t0.tag === 0) {
    const c = _t0.data[0];
    cart = c;
  } else if (_t0.tag === 1) {
    const e = _t0.data[0];
    __print(("ROM parse failed: " + e) + "\n");
  }
  let bus = newBus(cart);
  let cpu = newCpuReset(bus);
  return new NesHandle(cpu, bus);
}

function setButtons(h, b) {
  h.bus.buttons = b;
}

function stepFrame(h) {
  const startFrame = h.bus.ppu.frame;
  while ((h.bus.ppu.frame == startFrame)) {
    const before = h.cpu.cyc;
    step(h.cpu, h.bus);
    const used = Math.trunc((h.cpu.cyc - before));
    let k = 0;
    while ((k < Math.trunc((used * 3)))) {
      clockPpu(h.bus);
      k = Math.trunc((k + 1));
    }
    clockApu(h.bus, used);
    if (h.bus.ppu.nmiPending) {
      h.bus.ppu.nmiPending = false;
      nmi(h.cpu, h.bus);
    }
    if ((((h.bus.irqPending || h.bus.apu.frameIrq) || h.bus.apu.dmc.irqFlag) && (!cpuFlag(h.cpu, 4)))) {
      h.bus.irqPending = false;
      irq(h.cpu, h.bus);
    }
  }
  renderFrame(h.bus.ppu);
}

function stepOne(h) {
  const before = h.cpu.cyc;
  step(h.cpu, h.bus);
  const used = Math.trunc((h.cpu.cyc - before));
  let k = 0;
  while ((k < Math.trunc((used * 3)))) {
    clockPpu(h.bus);
    k = Math.trunc((k + 1));
  }
  clockApu(h.bus, used);
  if (h.bus.ppu.nmiPending) {
    h.bus.ppu.nmiPending = false;
    nmi(h.cpu, h.bus);
  }
  if ((((h.bus.irqPending || h.bus.apu.frameIrq) || h.bus.apu.dmc.irqFlag) && (!cpuFlag(h.cpu, 4)))) {
    h.bus.irqPending = false;
    irq(h.cpu, h.bus);
  }
}

function main() {
  return 0;
}

function newBus(cart) {
  const n = cart.prg.length;
  const mask = (() => {
  if ((n == 16384)) {
    return Math.trunc(16383);
  } else {
    return Math.trunc(32767);
  }
  })();
  const ppu = newPpu(cart.chr, cart.mirrorVertical);
  const banks = Math.trunc(cart.prg16kBanks);
  let bus = new Bus(Array.from({length: 2048}, () => __clone(0)), Array.from({length: 8192}, () => __clone(0)), cart.prg, mask, ppu, newApu(), 0, 0, 0, Math.trunc(cart.mapper), banks, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false, false);
  if ((bus.mapper == 4)) {
    mmc3UpdateChr(bus);
  }
  if ((bus.mapper == 9)) {
    mmc2InitMapper(bus.ppu);
  }
  if ((bus.mapper == 227)) {
    bus.m227Hi = 0;
  }
  return bus;
}

function busRead(bus, addr) {
  const a = Math.trunc(addr);
  if ((a < 8192)) {
    return bus.ram[Math.trunc((a & 2047))];
  }
  if ((a < 16384)) {
    return ppuRegRead(bus.ppu, Math.trunc((a & 7)));
  }
  if ((a == 16406)) {
    if ((((bus.strobe & 1) & 0xFF) == 1)) {
      bus.ctrl1 = bus.buttons;
    }
    const bit = ((bus.ctrl1 & 1) & 0xFF);
    bus.ctrl1 = ((((bus.ctrl1 >> 1) & 0xFF) | 128) & 0xFF);
    return ((bit | 64) & 0xFF);
  }
  if ((a == 16405)) {
    return apuReadStatus(bus.apu);
  }
  if (((a >= 24576) && (a < 32768))) {
    return bus.wram[Math.trunc((a - 24576))];
  }
  if ((a >= 32768)) {
    if ((bus.mapper == 4)) {
      return bus.prg[mmc3PrgOffset(bus, a)];
    }
    if ((bus.mapper == 9)) {
      const n8k = Math.trunc(Math.trunc(bus.prg.length / 8192));
      if ((a < 40960)) {
        return bus.prg[Math.trunc((Math.trunc((bus.mmc2Prg * 8192)) + Math.trunc((a - 32768))))];
      }
      if ((a < 49152)) {
        return bus.prg[Math.trunc((Math.trunc((Math.trunc((n8k - 3)) * 8192)) + Math.trunc((a - 40960))))];
      }
      if ((a < 57344)) {
        return bus.prg[Math.trunc((Math.trunc((Math.trunc((n8k - 2)) * 8192)) + Math.trunc((a - 49152))))];
      }
      return bus.prg[Math.trunc((Math.trunc((Math.trunc((n8k - 1)) * 8192)) + Math.trunc((a - 57344))))];
    }
    if ((bus.mapper == 227)) {
      const n16 = Math.trunc(Math.trunc(bus.prg.length / 16384));
      if ((a < 49152)) {
        return bus.prg[Math.trunc((Math.trunc((Math.trunc((bus.m227Lo % n16)) * 16384)) + Math.trunc((a - 32768))))];
      }
      return bus.prg[Math.trunc((Math.trunc((Math.trunc((bus.m227Hi % n16)) * 16384)) + Math.trunc((a - 49152))))];
    }
    if ((bus.mapper == 2)) {
      if ((a < 49152)) {
        return bus.prg[Math.trunc((Math.trunc((bus.prgBank * 16384)) + Math.trunc((a - 32768))))];
      }
      return bus.prg[Math.trunc((Math.trunc((Math.trunc((bus.prgBanks - 1)) * 16384)) + Math.trunc((a - 49152))))];
    }
    return bus.prg[Math.trunc((Math.trunc((a - 32768)) & bus.prgMask))];
  }
  return 0;
}

function busWrite(bus, addr, val) {
  const a = Math.trunc(addr);
  if ((a < 8192)) {
    bus.ram[Math.trunc((a & 2047))] = val;
    return;
  }
  if ((a < 16384)) {
    ppuRegWrite(bus.ppu, Math.trunc((a & 7)), val);
    return;
  }
  if ((a == 16404)) {
    const page = Math.trunc((Math.trunc(val) << 8));
    let i = 0;
    while ((i < 256)) {
      const b = busRead(bus, (Math.trunc((page + i)) & 0xFFFF));
      ppuRegWrite(bus.ppu, 4, b);
      i = Math.trunc((i + 1));
    }
    return;
  }
  if ((a == 16406)) {
    bus.strobe = ((val & 1) & 0xFF);
    if ((bus.strobe == 1)) {
      bus.ctrl1 = bus.buttons;
    }
    return;
  }
  if (((a >= 16384) && (a <= 16407))) {
    apuWrite(bus.apu, Math.trunc((a - 16384)), val);
    return;
  }
  if (((a >= 24576) && (a < 32768))) {
    bus.wram[Math.trunc((a - 24576))] = val;
    return;
  }
  if ((a >= 32768)) {
    if ((bus.mapper == 2)) {
      bus.prgBank = Math.trunc((Math.trunc(val) & Math.trunc((bus.prgBanks - 1))));
      return;
    }
    if ((bus.mapper == 4)) {
      mmc3Write(bus, a, val);
      return;
    }
    if ((bus.mapper == 9)) {
      if ((a < 40960)) {
        return;
      }
      if ((a < 45056)) {
        bus.mmc2Prg = Math.trunc((Math.trunc(val) & 15));
      } else {
        if ((a < 49152)) {
          mmc2SetChr(bus.ppu, 0, Math.trunc((Math.trunc(val) & 31)));
        } else {
          if ((a < 53248)) {
            mmc2SetChr(bus.ppu, 1, Math.trunc((Math.trunc(val) & 31)));
          } else {
            if ((a < 57344)) {
              mmc2SetChr(bus.ppu, 2, Math.trunc((Math.trunc(val) & 31)));
            } else {
              if ((a < 61440)) {
                mmc2SetChr(bus.ppu, 3, Math.trunc((Math.trunc(val) & 31)));
              } else {
                bus.ppu.mirrorVertical = (((val & 1) & 0xFF) == 0);
              }
            }
          }
        }
      }
      return;
    }
    if ((bus.mapper == 227)) {
      mapper227Write(bus, a);
      return;
    }
    return;
  }
}

function mapper227Write(bus, a) {
  const bank = Math.trunc((Math.trunc((a >> 2)) & 31));
  const l = Math.trunc((Math.trunc((a >> 7)) & 1));
  const s = Math.trunc((a & 1));
  const mirror = Math.trunc((Math.trunc((a >> 1)) & 1));
  if ((l == 1)) {
    if ((s == 0)) {
      bus.m227Lo = Math.trunc((bank & 30));
      bus.m227Hi = Math.trunc((Math.trunc((bank & 30)) | 1));
    } else {
      bus.m227Lo = bank;
      bus.m227Hi = bank;
    }
  } else {
    bus.m227Lo = bank;
    bus.m227Hi = Math.trunc((Math.trunc((bank & 24)) | (() => {
    if ((s == 1)) {
      return 7;
    } else {
      return 0;
    }
    })()));
  }
  bus.ppu.mirrorVertical = (mirror == 0);
}

function mmc3Write(bus, a, val) {
  const even = (Math.trunc((a & 1)) == 0);
  const v = Math.trunc(val);
  if ((a < 40960)) {
    if (even) {
      bus.mmcSelect = v;
    } else {
      const r = Math.trunc((bus.mmcSelect & 7));
      if ((r == 0)) {
        bus.mmcR0 = v;
      }
      if ((r == 1)) {
        bus.mmcR1 = v;
      }
      if ((r == 2)) {
        bus.mmcR2 = v;
      }
      if ((r == 3)) {
        bus.mmcR3 = v;
      }
      if ((r == 4)) {
        bus.mmcR4 = v;
      }
      if ((r == 5)) {
        bus.mmcR5 = v;
      }
      if ((r == 6)) {
        bus.mmcR6 = v;
      }
      if ((r == 7)) {
        bus.mmcR7 = v;
      }
      mmc3UpdateChr(bus);
    }
  } else {
    if ((a < 49152)) {
      if (even) {
        bus.ppu.mirrorVertical = (Math.trunc((v & 1)) == 0);
      }
    } else {
      if ((a < 57344)) {
        if (even) {
          bus.irqLatch = v;
        } else {
          bus.irqReload = true;
        }
      } else {
        if (even) {
          bus.irqEnabled = false;
          bus.irqPending = false;
        } else {
          bus.irqEnabled = true;
        }
      }
    }
  }
}

function newCpuNestest() {
  return new Cpu(0, 0, 0, 253, 36, 49152, 7, 0, Array.from({length: 256}, () => __clone(false)));
}

function newCpuReset(bus) {
  const lo = Math.trunc(busRead(bus, 65532));
  const hi = Math.trunc(busRead(bus, 65533));
  return new Cpu(0, 0, 0, 253, 36, wrap16(Math.trunc((lo | Math.trunc((hi << 8))))), 0, 0, Array.from({length: 256}, () => __clone(false)));
}

function nmi(cpu, bus) {
  push16(cpu, bus, cpu.pc);
  push8(cpu, bus, ((((cpu.p & (~FB)) & 0xFF) | FU) & 0xFF));
  setFlag(cpu, FI, true);
  const lo = Math.trunc(busRead(bus, 65530));
  const hi = Math.trunc(busRead(bus, 65531));
  cpu.pc = wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
  cpu.cyc = Math.trunc((cpu.cyc + 7));
}

function irq(cpu, bus) {
  push16(cpu, bus, cpu.pc);
  push8(cpu, bus, ((((cpu.p & (~FB)) & 0xFF) | FU) & 0xFF));
  setFlag(cpu, FI, true);
  const lo = Math.trunc(busRead(bus, 65534));
  const hi = Math.trunc(busRead(bus, 65535));
  cpu.pc = wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
  cpu.cyc = Math.trunc((cpu.cyc + 7));
}

function mmc3UpdateChr(bus) {
  const num1k = Math.trunc(Math.trunc(bus.ppu.chr.length / 1024));
  const mode = Math.trunc((Math.trunc((bus.mmcSelect >> 7)) & 1));
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  let w4 = 0;
  let w5 = 0;
  let w6 = 0;
  let w7 = 0;
  if ((mode == 0)) {
    w0 = Math.trunc((bus.mmcR0 & 254));
    w1 = Math.trunc((Math.trunc((bus.mmcR0 & 254)) + 1));
    w2 = Math.trunc((bus.mmcR1 & 254));
    w3 = Math.trunc((Math.trunc((bus.mmcR1 & 254)) + 1));
    w4 = bus.mmcR2;
    w5 = bus.mmcR3;
    w6 = bus.mmcR4;
    w7 = bus.mmcR5;
  } else {
    w0 = bus.mmcR2;
    w1 = bus.mmcR3;
    w2 = bus.mmcR4;
    w3 = bus.mmcR5;
    w4 = Math.trunc((bus.mmcR0 & 254));
    w5 = Math.trunc((Math.trunc((bus.mmcR0 & 254)) + 1));
    w6 = Math.trunc((bus.mmcR1 & 254));
    w7 = Math.trunc((Math.trunc((bus.mmcR1 & 254)) + 1));
  }
  bus.ppu.chrBankOffset[0] = Math.trunc((Math.trunc((w0 % num1k)) * 1024));
  bus.ppu.chrBankOffset[1] = Math.trunc((Math.trunc((w1 % num1k)) * 1024));
  bus.ppu.chrBankOffset[2] = Math.trunc((Math.trunc((w2 % num1k)) * 1024));
  bus.ppu.chrBankOffset[3] = Math.trunc((Math.trunc((w3 % num1k)) * 1024));
  bus.ppu.chrBankOffset[4] = Math.trunc((Math.trunc((w4 % num1k)) * 1024));
  bus.ppu.chrBankOffset[5] = Math.trunc((Math.trunc((w5 % num1k)) * 1024));
  bus.ppu.chrBankOffset[6] = Math.trunc((Math.trunc((w6 % num1k)) * 1024));
  bus.ppu.chrBankOffset[7] = Math.trunc((Math.trunc((w7 % num1k)) * 1024));
}

function mmc3PrgOffset(bus, a) {
  const num8k = Math.trunc(Math.trunc(bus.prg.length / 8192));
  const last = Math.trunc((num8k - 1));
  const mode = Math.trunc((Math.trunc((bus.mmcSelect >> 6)) & 1));
  let bank = 0;
  if ((a < 40960)) {
    bank = (() => {
    if ((mode == 0)) {
      return bus.mmcR6;
    } else {
      return Math.trunc((last - 1));
    }
    })();
  } else {
    if ((a < 49152)) {
      bank = bus.mmcR7;
    } else {
      if ((a < 57344)) {
        bank = (() => {
        if ((mode == 0)) {
          return Math.trunc((last - 1));
        } else {
          return bus.mmcR6;
        }
        })();
      } else {
        bank = last;
      }
    }
  }
  return Math.trunc((Math.trunc((Math.trunc((bank % num8k)) * 8192)) + Math.trunc((a & 8191))));
}

function mmc3ClockIrq(bus) {
  if (((bus.irqCounter == 0) || bus.irqReload)) {
    bus.irqCounter = bus.irqLatch;
    bus.irqReload = false;
  } else {
    bus.irqCounter = Math.trunc((bus.irqCounter - 1));
  }
  if (((bus.irqCounter == 0) && bus.irqEnabled)) {
    bus.irqPending = true;
  }
}

function clockApu(bus, cycles) {
  apuStep(bus.apu, cycles);
  if (bus.apu.dmc.needsFetch) {
    const addr = bus.apu.dmc.curAddr;
    const b = busRead(bus, (addr & 0xFFFF));
    dmcFill(bus.apu.dmc, Math.trunc(b));
  }
}

function clockPpu(bus) {
  ppuStep(bus.ppu);
  if (((((bus.mapper == 4) && (bus.ppu.dot == 260)) && (bus.ppu.scanline < 240)) && (((bus.ppu.mask & 24) & 0xFF) != 0))) {
    mmc3ClockIrq(bus);
  }
}

function cpuFlag(cpu, mask) {
  return (((cpu.p & mask) & 0xFF) != 0);
}

function setFlag(cpu, mask, on) {
  if (on) {
    cpu.p = ((cpu.p | mask) & 0xFF);
  } else {
    cpu.p = ((cpu.p & (~mask)) & 0xFF);
  }
}

function setZN(cpu, v) {
  setFlag(cpu, FZ, (v == 0));
  setFlag(cpu, FN, (((v & 128) & 0xFF) != 0));
}

function wrap16(v) {
  return (Math.trunc((v & 65535)) & 0xFFFF);
}

function read16(bus, addr) {
  const lo = Math.trunc(busRead(bus, addr));
  const hi = Math.trunc(busRead(bus, wrap16(Math.trunc((Math.trunc(addr) + 1)))));
  return wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
}

function read16Bug(bus, addr) {
  const a = Math.trunc(addr);
  const lo = Math.trunc(busRead(bus, addr));
  const hiAddr = Math.trunc((Math.trunc((a & 65280)) | Math.trunc((Math.trunc((a + 1)) & 255))));
  const hi = Math.trunc(busRead(bus, wrap16(hiAddr)));
  return wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
}

function fetch8(cpu, bus) {
  const v = busRead(bus, cpu.pc);
  cpu.pc = wrap16(Math.trunc((Math.trunc(cpu.pc) + 1)));
  return v;
}

function fetch16(cpu, bus) {
  const v = read16(bus, cpu.pc);
  cpu.pc = wrap16(Math.trunc((Math.trunc(cpu.pc) + 2)));
  return v;
}

function push8(cpu, bus, v) {
  busWrite(bus, wrap16(Math.trunc((256 | Math.trunc(cpu.sp)))), v);
  cpu.sp = ((cpu.sp - 1) & 0xFF);
}

function pop8(cpu, bus) {
  cpu.sp = ((cpu.sp + 1) & 0xFF);
  return busRead(bus, wrap16(Math.trunc((256 | Math.trunc(cpu.sp)))));
}

function push16(cpu, bus, v) {
  push8(cpu, bus, (((v >> 8) & 0xFFFF) & 0xFF));
  push8(cpu, bus, (v & 0xFF));
}

function pop16(cpu, bus) {
  const lo = Math.trunc(pop8(cpu, bus));
  const hi = Math.trunc(pop8(cpu, bus));
  return wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
}

function pageCrossed(base, eff) {
  return (Math.trunc((Math.trunc(base) & 65280)) != Math.trunc((Math.trunc(eff) & 65280)));
}

function read16ZP(bus, z) {
  const lo = Math.trunc(busRead(bus, (Math.trunc((z & 255)) & 0xFFFF)));
  const hi = Math.trunc(busRead(bus, (Math.trunc((Math.trunc((z + 1)) & 255)) & 0xFFFF)));
  return wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
}

function aImm(cpu) {
  const a = cpu.pc;
  cpu.pc = wrap16(Math.trunc((Math.trunc(cpu.pc) + 1)));
  return a;
}

function aZp(cpu, bus) {
  return (fetch8(cpu, bus) & 0xFFFF);
}

function aZpX(cpu, bus) {
  return (Math.trunc((Math.trunc((Math.trunc(fetch8(cpu, bus)) + Math.trunc(cpu.x))) & 255)) & 0xFFFF);
}

function aZpY(cpu, bus) {
  return (Math.trunc((Math.trunc((Math.trunc(fetch8(cpu, bus)) + Math.trunc(cpu.y))) & 255)) & 0xFFFF);
}

function aAbs(cpu, bus) {
  return fetch16(cpu, bus);
}

function aAbsX(cpu, bus) {
  const base = fetch16(cpu, bus);
  const eff = wrap16(Math.trunc((Math.trunc(base) + Math.trunc(cpu.x))));
  if (pageCrossed(base, eff)) {
    cpu.extraCycles = 1;
  }
  return eff;
}

function aAbsY(cpu, bus) {
  const base = fetch16(cpu, bus);
  const eff = wrap16(Math.trunc((Math.trunc(base) + Math.trunc(cpu.y))));
  if (pageCrossed(base, eff)) {
    cpu.extraCycles = 1;
  }
  return eff;
}

function aIndX(cpu, bus) {
  const z = Math.trunc((Math.trunc((Math.trunc(fetch8(cpu, bus)) + Math.trunc(cpu.x))) & 255));
  return read16ZP(bus, z);
}

function aIndY(cpu, bus) {
  const z = Math.trunc(fetch8(cpu, bus));
  const base = read16ZP(bus, z);
  const eff = wrap16(Math.trunc((Math.trunc(base) + Math.trunc(cpu.y))));
  if (pageCrossed(base, eff)) {
    cpu.extraCycles = 1;
  }
  return eff;
}

function adc(cpu, m) {
  const a = Math.trunc(cpu.a);
  const carry = (() => {
  if (cpuFlag(cpu, FC)) {
    return Math.trunc(1);
  } else {
    return Math.trunc(0);
  }
  })();
  const sum = Math.trunc((Math.trunc((a + Math.trunc(m))) + carry));
  const r = (Math.trunc((sum & 255)) & 0xFF);
  setFlag(cpu, FC, (sum > 255));
  setFlag(cpu, FV, (Math.trunc((Math.trunc(((~Math.trunc((a ^ Math.trunc(m)))) & Math.trunc((a ^ Math.trunc(r))))) & 128)) != 0));
  cpu.a = r;
  setZN(cpu, r);
}

function sbc(cpu, m) {
  adc(cpu, (Math.trunc((Math.trunc(m) ^ 255)) & 0xFF));
}

function compare(cpu, reg, m) {
  setFlag(cpu, FC, (reg >= m));
  setZN(cpu, ((reg - m) & 0xFF));
}

function bitTest(cpu, m) {
  setFlag(cpu, FZ, (Math.trunc((Math.trunc(cpu.a) & Math.trunc(m))) == 0));
  setFlag(cpu, FN, (((m & 128) & 0xFF) != 0));
  setFlag(cpu, FV, (((m & 64) & 0xFF) != 0));
}

function aslV(cpu, m) {
  setFlag(cpu, FC, (((m & 128) & 0xFF) != 0));
  const r = ((m << 1) & 0xFF);
  setZN(cpu, r);
  return r;
}

function lsrV(cpu, m) {
  setFlag(cpu, FC, (((m & 1) & 0xFF) != 0));
  const r = ((m >> 1) & 0xFF);
  setZN(cpu, r);
  return r;
}

function rolV(cpu, m) {
  const cin = (() => {
  if (cpuFlag(cpu, FC)) {
    return 1;
  } else {
    return 0;
  }
  })();
  setFlag(cpu, FC, (((m & 128) & 0xFF) != 0));
  const r = ((((m << 1) & 0xFF) | cin) & 0xFF);
  setZN(cpu, r);
  return r;
}

function rorV(cpu, m) {
  const cin = (() => {
  if (cpuFlag(cpu, FC)) {
    return 128;
  } else {
    return 0;
  }
  })();
  setFlag(cpu, FC, (((m & 1) & 0xFF) != 0));
  const r = ((((m >> 1) & 0xFF) | cin) & 0xFF);
  setZN(cpu, r);
  return r;
}

function branch(cpu, bus, cond) {
  let off = Math.trunc(fetch8(cpu, bus));
  if ((off >= 128)) {
    off = Math.trunc((off - 256));
  }
  if (cond) {
    const pcNow = cpu.pc;
    const target = wrap16(Math.trunc((Math.trunc(cpu.pc) + off)));
    cpu.cyc = Math.trunc((cpu.cyc + 1));
    if (pageCrossed(pcNow, target)) {
      cpu.cyc = Math.trunc((cpu.cyc + 1));
    }
    cpu.pc = target;
  }
}

function appendStr(dst, src) {
  const _t1 = src;
  for (let _t2 = 0; _t2 < _t1.length; _t2++) {
    const b = _t1.charCodeAt(_t2);
    (dst.v += String.fromCharCode(b));
  }
}

function hex2(v) {
  const d = "0123456789ABCDEF";
  let s = "";
  (s += String.fromCharCode(d.charCodeAt(Math.trunc((Math.trunc((v >> 4)) & 15)))));
  (s += String.fromCharCode(d.charCodeAt(Math.trunc((v & 15)))));
  return s;
}

function hex4(v) {
  const s = {v: hex2(Math.trunc((Math.trunc((v >> 8)) & 255)))};
  const lo = hex2(Math.trunc((v & 255)));
  appendStr(s, lo);
  return s.v;
}

function decStr(n) {
  if ((n == 0)) {
    return "0";
  }
  let v = n;
  let buf = "";
  while ((v > 0)) {
    (buf += String.fromCharCode((Math.trunc((Math.trunc((v % 10)) + 48)) & 0xFF)));
    v = Math.trunc(Math.trunc(v / 10));
  }
  let out = "";
  let i = Math.trunc((buf.length - 1));
  while ((i >= 0)) {
    (out += String.fromCharCode(buf.charCodeAt(i)));
    i = Math.trunc((i - 1));
  }
  return out;
}

function formatState(cpu) {
  const s = {v: hex4(Math.trunc(cpu.pc))};
  const a = hex2(Math.trunc(cpu.a));
  appendStr(s, " A:");
  appendStr(s, a);
  const x = hex2(Math.trunc(cpu.x));
  appendStr(s, " X:");
  appendStr(s, x);
  const y = hex2(Math.trunc(cpu.y));
  appendStr(s, " Y:");
  appendStr(s, y);
  const p = hex2(Math.trunc(cpu.p));
  appendStr(s, " P:");
  appendStr(s, p);
  const sp = hex2(Math.trunc(cpu.sp));
  appendStr(s, " SP:");
  appendStr(s, sp);
  const c = decStr(cpu.cyc);
  appendStr(s, " CYC:");
  appendStr(s, c);
  return s.v;
}

function lax(cpu, bus, addr) {
  const v = busRead(bus, addr);
  cpu.a = v;
  cpu.x = v;
  setZN(cpu, v);
}

function sax(cpu, bus, addr) {
  busWrite(bus, addr, ((cpu.a & cpu.x) & 0xFF));
}

function dcp(cpu, bus, addr) {
  const m = ((busRead(bus, addr) - 1) & 0xFF);
  busWrite(bus, addr, m);
  compare(cpu, cpu.a, m);
}

function isb(cpu, bus, addr) {
  const m = ((busRead(bus, addr) + 1) & 0xFF);
  busWrite(bus, addr, m);
  sbc(cpu, m);
}

function slo(cpu, bus, addr) {
  const m = aslV(cpu, busRead(bus, addr));
  busWrite(bus, addr, m);
  cpu.a = ((cpu.a | m) & 0xFF);
  setZN(cpu, cpu.a);
}

function rla(cpu, bus, addr) {
  const m = rolV(cpu, busRead(bus, addr));
  busWrite(bus, addr, m);
  cpu.a = ((cpu.a & m) & 0xFF);
  setZN(cpu, cpu.a);
}

function sre(cpu, bus, addr) {
  const m = lsrV(cpu, busRead(bus, addr));
  busWrite(bus, addr, m);
  cpu.a = ((cpu.a ^ m) & 0xFF);
  setZN(cpu, cpu.a);
}

function rra(cpu, bus, addr) {
  const m = rorV(cpu, busRead(bus, addr));
  busWrite(bus, addr, m);
  adc(cpu, m);
}

function step(cpu, bus) {
  cpu.extraCycles = 0;
  const op = fetch8(cpu, bus);
  const _t3 = op;
  if (_t3 === 0) {
    push16(cpu, bus, wrap16(Math.trunc((Math.trunc(cpu.pc) + 1))));
    push8(cpu, bus, ((((cpu.p | FB) & 0xFF) | FU) & 0xFF));
    setFlag(cpu, FI, true);
    const lo = Math.trunc(busRead(bus, 65534));
    const hi = Math.trunc(busRead(bus, 65535));
    cpu.pc = wrap16(Math.trunc((lo | Math.trunc((hi << 8)))));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 169) {
    const v = busRead(bus, aImm(cpu));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 165) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 181) {
    const v = busRead(bus, aZpX(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 173) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 189) {
    const v = busRead(bus, aAbsX(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 185) {
    const v = busRead(bus, aAbsY(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 161) {
    const v = busRead(bus, aIndX(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 177) {
    const v = busRead(bus, aIndY(cpu, bus));
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 162) {
    const v = busRead(bus, aImm(cpu));
    cpu.x = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 166) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.x = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 182) {
    const v = busRead(bus, aZpY(cpu, bus));
    cpu.x = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 174) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.x = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 190) {
    const v = busRead(bus, aAbsY(cpu, bus));
    cpu.x = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 160) {
    const v = busRead(bus, aImm(cpu));
    cpu.y = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 164) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.y = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 180) {
    const v = busRead(bus, aZpX(cpu, bus));
    cpu.y = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 172) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.y = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 188) {
    const v = busRead(bus, aAbsX(cpu, bus));
    cpu.y = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 133) {
    busWrite(bus, aZp(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 149) {
    busWrite(bus, aZpX(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 141) {
    busWrite(bus, aAbs(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 157) {
    busWrite(bus, aAbsX(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 153) {
    busWrite(bus, aAbsY(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 129) {
    busWrite(bus, aIndX(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 145) {
    busWrite(bus, aIndY(cpu, bus), cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 134) {
    busWrite(bus, aZp(cpu, bus), cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 150) {
    busWrite(bus, aZpY(cpu, bus), cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 142) {
    busWrite(bus, aAbs(cpu, bus), cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 132) {
    busWrite(bus, aZp(cpu, bus), cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 148) {
    busWrite(bus, aZpX(cpu, bus), cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 140) {
    busWrite(bus, aAbs(cpu, bus), cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 170) {
    cpu.x = cpu.a;
    setZN(cpu, cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 168) {
    cpu.y = cpu.a;
    setZN(cpu, cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 138) {
    cpu.a = cpu.x;
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 152) {
    cpu.a = cpu.y;
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 186) {
    cpu.x = cpu.sp;
    setZN(cpu, cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 154) {
    cpu.sp = cpu.x;
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 72) {
    push8(cpu, bus, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 104) {
    const v = pop8(cpu, bus);
    cpu.a = v;
    setZN(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 8) {
    push8(cpu, bus, ((((cpu.p | FB) & 0xFF) | FU) & 0xFF));
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 40) {
    const v = pop8(cpu, bus);
    cpu.p = ((((v & (~FB)) & 0xFF) | FU) & 0xFF);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 41) {
    const v = busRead(bus, aImm(cpu));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 37) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 53) {
    const v = busRead(bus, aZpX(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 45) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 61) {
    const v = busRead(bus, aAbsX(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 57) {
    const v = busRead(bus, aAbsY(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 33) {
    const v = busRead(bus, aIndX(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 49) {
    const v = busRead(bus, aIndY(cpu, bus));
    cpu.a = ((cpu.a & v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 9) {
    const v = busRead(bus, aImm(cpu));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 5) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 21) {
    const v = busRead(bus, aZpX(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 13) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 29) {
    const v = busRead(bus, aAbsX(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 25) {
    const v = busRead(bus, aAbsY(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 1) {
    const v = busRead(bus, aIndX(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 17) {
    const v = busRead(bus, aIndY(cpu, bus));
    cpu.a = ((cpu.a | v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 73) {
    const v = busRead(bus, aImm(cpu));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 69) {
    const v = busRead(bus, aZp(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 85) {
    const v = busRead(bus, aZpX(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 77) {
    const v = busRead(bus, aAbs(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 93) {
    const v = busRead(bus, aAbsX(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 89) {
    const v = busRead(bus, aAbsY(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 65) {
    const v = busRead(bus, aIndX(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 81) {
    const v = busRead(bus, aIndY(cpu, bus));
    cpu.a = ((cpu.a ^ v) & 0xFF);
    setZN(cpu, cpu.a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 105) {
    const v = busRead(bus, aImm(cpu));
    adc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 101) {
    const v = busRead(bus, aZp(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 117) {
    const v = busRead(bus, aZpX(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 109) {
    const v = busRead(bus, aAbs(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 125) {
    const v = busRead(bus, aAbsX(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 121) {
    const v = busRead(bus, aAbsY(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 97) {
    const v = busRead(bus, aIndX(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 113) {
    const v = busRead(bus, aIndY(cpu, bus));
    adc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 233) {
    const v = busRead(bus, aImm(cpu));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 229) {
    const v = busRead(bus, aZp(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 245) {
    const v = busRead(bus, aZpX(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 237) {
    const v = busRead(bus, aAbs(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 253) {
    const v = busRead(bus, aAbsX(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 249) {
    const v = busRead(bus, aAbsY(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 225) {
    const v = busRead(bus, aIndX(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 241) {
    const v = busRead(bus, aIndY(cpu, bus));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 201) {
    const v = busRead(bus, aImm(cpu));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 197) {
    const v = busRead(bus, aZp(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 213) {
    const v = busRead(bus, aZpX(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 205) {
    const v = busRead(bus, aAbs(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 221) {
    const v = busRead(bus, aAbsX(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 217) {
    const v = busRead(bus, aAbsY(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 193) {
    const v = busRead(bus, aIndX(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 209) {
    const v = busRead(bus, aIndY(cpu, bus));
    compare(cpu, cpu.a, v);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 224) {
    const v = busRead(bus, aImm(cpu));
    compare(cpu, cpu.x, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 228) {
    const v = busRead(bus, aZp(cpu, bus));
    compare(cpu, cpu.x, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 236) {
    const v = busRead(bus, aAbs(cpu, bus));
    compare(cpu, cpu.x, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 192) {
    const v = busRead(bus, aImm(cpu));
    compare(cpu, cpu.y, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 196) {
    const v = busRead(bus, aZp(cpu, bus));
    compare(cpu, cpu.y, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 204) {
    const v = busRead(bus, aAbs(cpu, bus));
    compare(cpu, cpu.y, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 36) {
    const v = busRead(bus, aZp(cpu, bus));
    bitTest(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 44) {
    const v = busRead(bus, aAbs(cpu, bus));
    bitTest(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 230) {
    const a = aZp(cpu, bus);
    const r = ((busRead(bus, a) + 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 246) {
    const a = aZpX(cpu, bus);
    const r = ((busRead(bus, a) + 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 238) {
    const a = aAbs(cpu, bus);
    const r = ((busRead(bus, a) + 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 254) {
    const a = aAbsX(cpu, bus);
    const r = ((busRead(bus, a) + 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 198) {
    const a = aZp(cpu, bus);
    const r = ((busRead(bus, a) - 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 214) {
    const a = aZpX(cpu, bus);
    const r = ((busRead(bus, a) - 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 206) {
    const a = aAbs(cpu, bus);
    const r = ((busRead(bus, a) - 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 222) {
    const a = aAbsX(cpu, bus);
    const r = ((busRead(bus, a) - 1) & 0xFF);
    busWrite(bus, a, r);
    setZN(cpu, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 232) {
    cpu.x = ((cpu.x + 1) & 0xFF);
    setZN(cpu, cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 200) {
    cpu.y = ((cpu.y + 1) & 0xFF);
    setZN(cpu, cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 202) {
    cpu.x = ((cpu.x - 1) & 0xFF);
    setZN(cpu, cpu.x);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 136) {
    cpu.y = ((cpu.y - 1) & 0xFF);
    setZN(cpu, cpu.y);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 10) {
    cpu.a = aslV(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 74) {
    cpu.a = lsrV(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 42) {
    cpu.a = rolV(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 106) {
    cpu.a = rorV(cpu, cpu.a);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 6) {
    const a = aZp(cpu, bus);
    const r = aslV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 22) {
    const a = aZpX(cpu, bus);
    const r = aslV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 14) {
    const a = aAbs(cpu, bus);
    const r = aslV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 30) {
    const a = aAbsX(cpu, bus);
    const r = aslV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 70) {
    const a = aZp(cpu, bus);
    const r = lsrV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 86) {
    const a = aZpX(cpu, bus);
    const r = lsrV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 78) {
    const a = aAbs(cpu, bus);
    const r = lsrV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 94) {
    const a = aAbsX(cpu, bus);
    const r = lsrV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 38) {
    const a = aZp(cpu, bus);
    const r = rolV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 54) {
    const a = aZpX(cpu, bus);
    const r = rolV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 46) {
    const a = aAbs(cpu, bus);
    const r = rolV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 62) {
    const a = aAbsX(cpu, bus);
    const r = rolV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 102) {
    const a = aZp(cpu, bus);
    const r = rorV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 118) {
    const a = aZpX(cpu, bus);
    const r = rorV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 110) {
    const a = aAbs(cpu, bus);
    const r = rorV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 126) {
    const a = aAbsX(cpu, bus);
    const r = rorV(cpu, busRead(bus, a));
    busWrite(bus, a, r);
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 76) {
    cpu.pc = aAbs(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 108) {
    const a = fetch16(cpu, bus);
    cpu.pc = read16Bug(bus, a);
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 32) {
    const target = fetch16(cpu, bus);
    push16(cpu, bus, wrap16(Math.trunc((Math.trunc(cpu.pc) - 1))));
    cpu.pc = target;
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 96) {
    cpu.pc = wrap16(Math.trunc((Math.trunc(pop16(cpu, bus)) + 1)));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 64) {
    const v = pop8(cpu, bus);
    cpu.p = ((((v & (~FB)) & 0xFF) | FU) & 0xFF);
    cpu.pc = pop16(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 144) {
    branch(cpu, bus, (!cpuFlag(cpu, FC)));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 176) {
    branch(cpu, bus, cpuFlag(cpu, FC));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 208) {
    branch(cpu, bus, (!cpuFlag(cpu, FZ)));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 240) {
    branch(cpu, bus, cpuFlag(cpu, FZ));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 16) {
    branch(cpu, bus, (!cpuFlag(cpu, FN)));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 48) {
    branch(cpu, bus, cpuFlag(cpu, FN));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 80) {
    branch(cpu, bus, (!cpuFlag(cpu, FV)));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 112) {
    branch(cpu, bus, cpuFlag(cpu, FV));
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 24) {
    setFlag(cpu, FC, false);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 56) {
    setFlag(cpu, FC, true);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 88) {
    setFlag(cpu, FI, false);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 120) {
    setFlag(cpu, FI, true);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 184) {
    setFlag(cpu, FV, false);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 216) {
    setFlag(cpu, FD, false);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 248) {
    setFlag(cpu, FD, true);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 234) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 26) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 58) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 90) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 122) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 218) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 250) {
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 128) {
    const a = aImm(cpu);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 130) {
    const a = aImm(cpu);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 137) {
    const a = aImm(cpu);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 194) {
    const a = aImm(cpu);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 226) {
    const a = aImm(cpu);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 4) {
    const a = aZp(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 68) {
    const a = aZp(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 100) {
    const a = aZp(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 20) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 52) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 84) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 116) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 212) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 244) {
    const a = aZpX(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 12) {
    const a = aAbs(cpu, bus);
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 28) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 60) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 92) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 124) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 220) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 252) {
    const a = aAbsX(cpu, bus);
    const v = busRead(bus, a);
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 167) {
    lax(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 183) {
    lax(cpu, bus, aZpY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 175) {
    lax(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 191) {
    lax(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 4)) + cpu.extraCycles));
  } else if (_t3 === 163) {
    lax(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 179) {
    lax(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((Math.trunc((cpu.cyc + 5)) + cpu.extraCycles));
  } else if (_t3 === 135) {
    sax(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 3));
  } else if (_t3 === 151) {
    sax(cpu, bus, aZpY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 143) {
    sax(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 4));
  } else if (_t3 === 131) {
    sax(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 235) {
    const v = busRead(bus, aImm(cpu));
    sbc(cpu, v);
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  } else if (_t3 === 199) {
    dcp(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 215) {
    dcp(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 207) {
    dcp(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 223) {
    dcp(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 219) {
    dcp(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 195) {
    dcp(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 211) {
    dcp(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 231) {
    isb(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 247) {
    isb(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 239) {
    isb(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 255) {
    isb(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 251) {
    isb(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 227) {
    isb(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 243) {
    isb(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 7) {
    slo(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 23) {
    slo(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 15) {
    slo(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 31) {
    slo(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 27) {
    slo(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 3) {
    slo(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 19) {
    slo(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 39) {
    rla(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 55) {
    rla(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 47) {
    rla(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 63) {
    rla(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 59) {
    rla(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 35) {
    rla(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 51) {
    rla(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 71) {
    sre(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 87) {
    sre(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 79) {
    sre(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 95) {
    sre(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 91) {
    sre(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 67) {
    sre(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 83) {
    sre(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 103) {
    rra(cpu, bus, aZp(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 5));
  } else if (_t3 === 119) {
    rra(cpu, bus, aZpX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 111) {
    rra(cpu, bus, aAbs(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 6));
  } else if (_t3 === 127) {
    rra(cpu, bus, aAbsX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 123) {
    rra(cpu, bus, aAbsY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 7));
  } else if (_t3 === 99) {
    rra(cpu, bus, aIndX(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else if (_t3 === 115) {
    rra(cpu, bus, aIndY(cpu, bus));
    cpu.cyc = Math.trunc((cpu.cyc + 8));
  } else {
    if ((!cpu.unknownSeen[Math.trunc(op)])) {
      cpu.unknownSeen[Math.trunc(op)] = true;
      __eprint(((("unimplemented opcode 0x" + hex2(Math.trunc(op))) + " at pc=0x") + hex4(Math.trunc((Math.trunc((Math.trunc(cpu.pc) - 1)) & 65535)))));
    }
    cpu.cyc = Math.trunc((cpu.cyc + 2));
  }
}

function sliceBytes(src, off, len) {
  let out = [];
  let i = 0;
  while ((i < len)) {
    out.push(src[Math.trunc((off + i))]);
    i = Math.trunc((i + 1));
  }
  return out;
}

function parseCartridge(raw) {
  if ((raw.length < HEADER)) {
    return Result_Cartridge_string.Err("file too small for iNES header");
  }
  if (((((raw[0] != 78) || (raw[1] != 69)) || (raw[2] != 83)) || (raw[3] != 26))) {
    return Result_Cartridge_string.Err("bad iNES magic");
  }
  const prg16k = raw[4];
  const chr8k = raw[5];
  const flags6 = raw[6];
  const flags7 = raw[7];
  const mapper = ((((flags7 & 240) & 0xFF) | ((((flags6 >> 4) & 0xFF) & 15) & 0xFF)) & 0xFF);
  const mirrorVertical = (((flags6 & 1) & 0xFF) != 0);
  const hasBattery = (((flags6 & 2) & 0xFF) != 0);
  const hasTrainer = (((flags6 & 4) & 0xFF) != 0);
  let prgOff = HEADER;
  if (hasTrainer) {
    prgOff = Math.trunc((prgOff + TRAINER));
  }
  const prgLen = Math.trunc((Math.trunc(prg16k) * PRG_BANK));
  const chrOff = Math.trunc((prgOff + prgLen));
  const chrLen = Math.trunc((Math.trunc(chr8k) * CHR_BANK));
  if ((raw.length < Math.trunc((chrOff + chrLen)))) {
    return Result_Cartridge_string.Err("file truncated: PRG/CHR banks exceed file size");
  }
  return Result_Cartridge_string.Ok(new Cartridge(sliceBytes(raw, prgOff, prgLen), sliceBytes(raw, chrOff, chrLen), mapper, mirrorVertical, hasBattery, prg16k, chr8k));
}

function newPpu(chr, mirrorVertical) {
  let c = chr;
  if ((c.length == 0)) {
    let i = 0;
    while ((i < 8192)) {
      c.push(0);
      i = Math.trunc((i + 1));
    }
  }
  return new Ppu(c, [0, 1024, 2048, 3072, 4096, 5120, 6144, 7168], Array.from({length: 2048}, () => __clone(0)), Array.from({length: 32}, () => __clone(0)), Array.from({length: 256}, () => __clone(0)), mirrorVertical, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0, false, 0, 0, 0, 0, 0, 0, Array.from({length: 61440}, () => __clone(0)));
}

function mmc2UpdateChr(ppu) {
  const n4k = Math.trunc(Math.trunc(ppu.chr.length / 4096));
  const b0 = (() => {
  if ((ppu.mmc2Latch0 == 0)) {
    return ppu.mmc2ChrFD0;
  } else {
    return ppu.mmc2ChrFE0;
  }
  })();
  const b1 = (() => {
  if ((ppu.mmc2Latch1 == 0)) {
    return ppu.mmc2ChrFD1;
  } else {
    return ppu.mmc2ChrFE1;
  }
  })();
  let w = 0;
  while ((w < 4)) {
    ppu.chrBankOffset[w] = Math.trunc((Math.trunc((Math.trunc((b0 % n4k)) * 4096)) + Math.trunc((w * 1024))));
    w = Math.trunc((w + 1));
  }
  while ((w < 8)) {
    ppu.chrBankOffset[w] = Math.trunc((Math.trunc((Math.trunc((b1 % n4k)) * 4096)) + Math.trunc((Math.trunc((w - 4)) * 1024))));
    w = Math.trunc((w + 1));
  }
}

function mmc2InitMapper(ppu) {
  ppu.mmc2 = true;
  mmc2UpdateChr(ppu);
}

function mmc2SetChr(ppu, which, bank) {
  if ((which == 0)) {
    ppu.mmc2ChrFD0 = bank;
  } else {
    if ((which == 1)) {
      ppu.mmc2ChrFE0 = bank;
    } else {
      if ((which == 2)) {
        ppu.mmc2ChrFD1 = bank;
      } else {
        ppu.mmc2ChrFE1 = bank;
      }
    }
  }
  mmc2UpdateChr(ppu);
}

function mmc2Latch(ppu, a) {
  let changed = false;
  if (((a >= 4056) && (a <= 4063))) {
    if ((ppu.mmc2Latch0 != 0)) {
      ppu.mmc2Latch0 = 0;
      changed = true;
    }
  } else {
    if (((a >= 4072) && (a <= 4079))) {
      if ((ppu.mmc2Latch0 != 1)) {
        ppu.mmc2Latch0 = 1;
        changed = true;
      }
    } else {
      if (((a >= 8152) && (a <= 8159))) {
        if ((ppu.mmc2Latch1 != 0)) {
          ppu.mmc2Latch1 = 0;
          changed = true;
        }
      } else {
        if (((a >= 8168) && (a <= 8175))) {
          if ((ppu.mmc2Latch1 != 1)) {
            ppu.mmc2Latch1 = 1;
            changed = true;
          }
        }
      }
    }
  }
  if (changed) {
    mmc2UpdateChr(ppu);
  }
}

function mirrorNT(ppu, addr) {
  const a = Math.trunc((addr & 4095));
  const table = Math.trunc(Math.trunc(a / 1024));
  const off = Math.trunc((a & 1023));
  let phys = 0;
  if (ppu.mirrorVertical) {
    phys = Math.trunc((Math.trunc((Math.trunc((table & 1)) * 1024)) + off));
  } else {
    phys = Math.trunc((Math.trunc((Math.trunc(Math.trunc(table / 2)) * 1024)) + off));
  }
  return phys;
}

function chrPhys(ppu, a) {
  return Math.trunc((Math.trunc((ppu.chrBankOffset[Math.trunc(Math.trunc(a / 1024))] + Math.trunc((a & 1023)))) % ppu.chr.length));
}

function ppuMemRead(ppu, addr) {
  const a = Math.trunc((Math.trunc(addr) & 16383));
  if ((a < 8192)) {
    return ppu.chr[chrPhys(ppu, a)];
  }
  if ((a < 16128)) {
    return ppu.vram[mirrorNT(ppu, a)];
  }
  let p = Math.trunc((a & 31));
  if ((p == 16)) {
    p = 0;
  }
  if ((p == 20)) {
    p = 4;
  }
  if ((p == 24)) {
    p = 8;
  }
  if ((p == 28)) {
    p = 12;
  }
  return ppu.palette[p];
}

function ppuMemWrite(ppu, addr, val) {
  const a = Math.trunc((Math.trunc(addr) & 16383));
  if ((a < 8192)) {
    ppu.chr[chrPhys(ppu, a)] = val;
    return;
  }
  if ((a < 16128)) {
    ppu.vram[mirrorNT(ppu, a)] = val;
    return;
  }
  let p = Math.trunc((a & 31));
  if ((p == 16)) {
    p = 0;
  }
  if ((p == 20)) {
    p = 4;
  }
  if ((p == 24)) {
    p = 8;
  }
  if ((p == 28)) {
    p = 12;
  }
  ppu.palette[p] = val;
}

function ppuRegRead(ppu, reg) {
  if ((reg == 2)) {
    const r = ((((ppu.status & 224) & 0xFF) | ((ppu.readBuffer & 31) & 0xFF)) & 0xFF);
    ppu.status = ((ppu.status & 127) & 0xFF);
    ppu.w = 0;
    return r;
  }
  if ((reg == 4)) {
    return ppu.oam[Math.trunc(ppu.oamAddr)];
  }
  if ((reg == 7)) {
    const a = ppu.v;
    let result = ppu.readBuffer;
    ppu.readBuffer = ppuMemRead(ppu, a);
    if ((Math.trunc((Math.trunc(a) & 16383)) >= 16128)) {
      result = ppu.readBuffer;
    }
    const inc = (() => {
    if ((((ppu.ctrl & 4) & 0xFF) != 0)) {
      return 32;
    } else {
      return 1;
    }
    })();
    ppu.v = (Math.trunc((Math.trunc((Math.trunc(ppu.v) + inc)) & 32767)) & 0xFFFF);
    return result;
  }
  return 0;
}

function ppuRegWrite(ppu, reg, val) {
  if ((reg == 0)) {
    ppu.ctrl = val;
    ppu.t = (Math.trunc((Math.trunc((Math.trunc(ppu.t) & 29695)) | Math.trunc((Math.trunc((Math.trunc(val) & 3)) << 10)))) & 0xFFFF);
    return;
  }
  if ((reg == 1)) {
    ppu.mask = val;
    return;
  }
  if ((reg == 3)) {
    ppu.oamAddr = val;
    return;
  }
  if ((reg == 4)) {
    ppu.oam[Math.trunc(ppu.oamAddr)] = val;
    ppu.oamAddr = (Math.trunc((Math.trunc((Math.trunc(ppu.oamAddr) + 1)) & 255)) & 0xFF);
    return;
  }
  if ((reg == 5)) {
    if ((ppu.w == 0)) {
      ppu.fineX = ((val & 7) & 0xFF);
      ppu.t = (Math.trunc((Math.trunc((Math.trunc(ppu.t) & 32736)) | Math.trunc((Math.trunc(val) >> 3)))) & 0xFFFF);
      ppu.w = 1;
    } else {
      const hi = Math.trunc((Math.trunc((Math.trunc(val) & 7)) << 12));
      const lo = Math.trunc((Math.trunc((Math.trunc(val) & 248)) << 2));
      ppu.t = (Math.trunc((Math.trunc((Math.trunc((Math.trunc(ppu.t) & 3103)) | hi)) | lo)) & 0xFFFF);
      ppu.w = 0;
    }
    return;
  }
  if ((reg == 6)) {
    if ((ppu.w == 0)) {
      ppu.t = (Math.trunc((Math.trunc((Math.trunc(ppu.t) & 255)) | Math.trunc((Math.trunc((Math.trunc(val) & 63)) << 8)))) & 0xFFFF);
      ppu.w = 1;
    } else {
      ppu.t = (Math.trunc((Math.trunc((Math.trunc(ppu.t) & 32512)) | Math.trunc(val))) & 0xFFFF);
      ppu.v = ppu.t;
      ppu.w = 0;
    }
    return;
  }
  if ((reg == 7)) {
    ppuMemWrite(ppu, ppu.v, val);
    const inc = (() => {
    if ((((ppu.ctrl & 4) & 0xFF) != 0)) {
      return 32;
    } else {
      return 1;
    }
    })();
    ppu.v = (Math.trunc((Math.trunc((Math.trunc(ppu.v) + inc)) & 32767)) & 0xFFFF);
    return;
  }
}

function incrementY(ppu) {
  let v = Math.trunc(ppu.v);
  if ((Math.trunc((v & 28672)) != 28672)) {
    v = Math.trunc((v + 4096));
  } else {
    v = Math.trunc((v & (~28672)));
    let y = Math.trunc((Math.trunc((v >> 5)) & 31));
    if ((y == 29)) {
      y = 0;
      v = Math.trunc((v ^ 2048));
    } else {
      if ((y == 31)) {
        y = 0;
      } else {
        y = Math.trunc((y + 1));
      }
    }
    v = Math.trunc((Math.trunc((v & (~992))) | Math.trunc((y << 5))));
  }
  ppu.v = (Math.trunc((v & 32767)) & 0xFFFF);
}

function ppuStep(ppu) {
  ppu.dot = Math.trunc((ppu.dot + 1));
  if ((ppu.dot > 340)) {
    ppu.dot = 0;
    ppu.scanline = Math.trunc((ppu.scanline + 1));
    if ((ppu.scanline > 261)) {
      ppu.scanline = 0;
      ppu.frame = Math.trunc((ppu.frame + 1));
    }
  }
  const rendering = (((ppu.mask & 24) & 0xFF) != 0);
  if (((ppu.dot == 256) && (ppu.scanline < 240))) {
    renderScanline(ppu, ppu.scanline);
    if (rendering) {
      incrementY(ppu);
    }
  }
  if ((((ppu.scanline == 261) && (ppu.dot == 280)) && rendering)) {
    const keepHoriz = Math.trunc((Math.trunc(ppu.v) & 1055));
    const vert = Math.trunc((Math.trunc(ppu.t) & 31712));
    ppu.v = (Math.trunc((keepHoriz | vert)) & 0xFFFF);
  }
  if (((ppu.scanline == 241) && (ppu.dot == 1))) {
    ppu.status = ((ppu.status | 128) & 0xFF);
    if ((((ppu.ctrl & 128) & 0xFF) != 0)) {
      ppu.nmiPending = true;
    }
  }
  if (((ppu.scanline == 261) && (ppu.dot == 1))) {
    ppu.status = ((ppu.status & 31) & 0xFF);
  }
}

function nesColor(idx) {
  const c = Math.trunc(NESPAL[Math.trunc((idx & 63))]);
  const r = Math.trunc((Math.trunc((c >> 16)) & 255));
  const g = Math.trunc((Math.trunc((c >> 8)) & 255));
  const b = Math.trunc((c & 255));
  return (Math.trunc((Math.trunc((Math.trunc((r | Math.trunc((g << 8)))) | Math.trunc((b << 16)))) | 4278190080)) >>> 0);
}

function renderScanline(ppu, sl) {
  let bgOpaque = Array.from({length: 256}, () => __clone(0));
  const universal = Math.trunc(ppuMemRead(ppu, 16128));
  if ((((ppu.mask & 8) & 0xFF) != 0)) {
    const t = Math.trunc(ppu.t);
    const v = Math.trunc(ppu.v);
    ppu.scrollX = Math.trunc((Math.trunc((Math.trunc((Math.trunc((Math.trunc((t >> 10)) & 1)) * 256)) + Math.trunc((Math.trunc((t & 31)) * 8)))) + Math.trunc(ppu.fineX)));
    ppu.scrollY = Math.trunc((Math.trunc((Math.trunc((Math.trunc((Math.trunc((v >> 11)) & 1)) * 240)) + Math.trunc((Math.trunc((Math.trunc((v >> 5)) & 31)) * 8)))) + Math.trunc((Math.trunc((v >> 12)) & 7))));
    const bgTable = (() => {
    if ((((ppu.ctrl & 16) & 0xFF) != 0)) {
      return 4096;
    } else {
      return 0;
    }
    })();
    let lo = 0;
    let hi = 0;
    let palGroup = 0;
    let x = 0;
    while ((x < 256)) {
      const wx = Math.trunc((Math.trunc((ppu.scrollX + x)) & 511));
      if (((Math.trunc((wx & 7)) == 0) || (x == 0))) {
        let wy = ppu.scrollY;
        while ((wy >= 480)) {
          wy = Math.trunc((wy - 480));
        }
        const ntX = Math.trunc(Math.trunc(wx / 256));
        const ntY = Math.trunc(Math.trunc(wy / 240));
        const ntBase = Math.trunc((8192 + Math.trunc((Math.trunc((Math.trunc((ntY * 2)) + ntX)) * 1024))));
        const lx = Math.trunc((wx & 255));
        const ly = Math.trunc((wy - Math.trunc((ntY * 240))));
        const col = Math.trunc(Math.trunc(lx / 8));
        const row = Math.trunc(Math.trunc(ly / 8));
        const tile = Math.trunc(ppuMemRead(ppu, (Math.trunc((Math.trunc((ntBase + Math.trunc((row * 32)))) + col)) & 0xFFFF)));
        const atAddr = Math.trunc((Math.trunc((Math.trunc((ntBase + 960)) + Math.trunc((Math.trunc(Math.trunc(row / 4)) * 8)))) + Math.trunc(Math.trunc(col / 4))));
        const at = Math.trunc(ppuMemRead(ppu, (atAddr & 0xFFFF)));
        const shift = Math.trunc((Math.trunc((Math.trunc((row & 2)) * 2)) + Math.trunc((col & 2))));
        palGroup = Math.trunc((Math.trunc((at >> shift)) & 3));
        const fy = Math.trunc((ly & 7));
        const patAddr = Math.trunc((Math.trunc((bgTable + Math.trunc((tile * 16)))) + fy));
        lo = Math.trunc(ppuMemRead(ppu, (patAddr & 0xFFFF)));
        hi = Math.trunc(ppuMemRead(ppu, (Math.trunc((patAddr + 8)) & 0xFFFF)));
        if (ppu.mmc2) {
          mmc2Latch(ppu, Math.trunc((patAddr + 8)));
        }
      }
      const bit = Math.trunc((7 - Math.trunc((wx & 7))));
      const px = Math.trunc((Math.trunc((Math.trunc((lo >> bit)) & 1)) | Math.trunc((Math.trunc((Math.trunc((hi >> bit)) & 1)) << 1))));
      let colorIdx = universal;
      if ((px != 0)) {
        colorIdx = Math.trunc(ppuMemRead(ppu, (Math.trunc((Math.trunc((16128 + Math.trunc((palGroup * 4)))) + px)) & 0xFFFF)));
        bgOpaque[x] = 1;
      }
      ppu.fb[Math.trunc((Math.trunc((sl * 256)) + x))] = nesColor(colorIdx);
      x = Math.trunc((x + 1));
    }
  } else {
    let x = 0;
    while ((x < 256)) {
      ppu.fb[Math.trunc((Math.trunc((sl * 256)) + x))] = nesColor(universal);
      x = Math.trunc((x + 1));
    }
  }
  renderSpriteLine(ppu, sl, bgOpaque);
}

function renderSpriteLine(ppu, sl, bgOpaque) {
  if ((((ppu.mask & 16) & 0xFF) == 0)) {
    return;
  }
  const tall = (((ppu.ctrl & 32) & 0xFF) != 0);
  const h = (() => {
  if (tall) {
    return 16;
  } else {
    return 8;
  }
  })();
  let i = 63;
  while ((i >= 0)) {
    const base = Math.trunc((i * 4));
    const row = Math.trunc((sl - Math.trunc((Math.trunc(ppu.oam[base]) + 1))));
    if (((row >= 0) && (row < h))) {
      const rawTile = Math.trunc(ppu.oam[Math.trunc((base + 1))]);
      const attr = Math.trunc(ppu.oam[Math.trunc((base + 2))]);
      const sx = Math.trunc(ppu.oam[Math.trunc((base + 3))]);
      const palGroup = Math.trunc((attr & 3));
      const flipH = (Math.trunc((attr & 64)) != 0);
      const flipV = (Math.trunc((attr & 128)) != 0);
      const behind = (Math.trunc((attr & 32)) != 0);
      const ry = (() => {
      if (flipV) {
        return Math.trunc((Math.trunc((h - 1)) - row));
      } else {
        return row;
      }
      })();
      let patAddr = 0;
      if (tall) {
        patAddr = Math.trunc((Math.trunc((Math.trunc((Math.trunc((rawTile & 1)) * 4096)) + Math.trunc((Math.trunc((Math.trunc((rawTile & 254)) + Math.trunc(Math.trunc(ry / 8)))) * 16)))) + Math.trunc((ry & 7))));
      } else {
        const sprTable = (() => {
        if ((((ppu.ctrl & 8) & 0xFF) != 0)) {
          return 4096;
        } else {
          return 0;
        }
        })();
        patAddr = Math.trunc((Math.trunc((sprTable + Math.trunc((rawTile * 16)))) + ry));
      }
      const lo = Math.trunc(ppuMemRead(ppu, (patAddr & 0xFFFF)));
      const hi = Math.trunc(ppuMemRead(ppu, (Math.trunc((patAddr + 8)) & 0xFFFF)));
      if (ppu.mmc2) {
        mmc2Latch(ppu, Math.trunc((patAddr + 8)));
      }
      let fx = 0;
      while ((fx < 8)) {
        const rx = (() => {
        if (flipH) {
          return fx;
        } else {
          return Math.trunc((7 - fx));
        }
        })();
        const px = Math.trunc((Math.trunc((Math.trunc((lo >> rx)) & 1)) | Math.trunc((Math.trunc((Math.trunc((hi >> rx)) & 1)) << 1))));
        if ((px != 0)) {
          const x = Math.trunc((sx + fx));
          if ((x < 256)) {
            const bgHere = (bgOpaque[x] != 0);
            if ((((i == 0) && bgHere) && (x < 255))) {
              ppu.status = ((ppu.status | 64) & 0xFF);
            }
            if ((!(behind && bgHere))) {
              const colorIdx = Math.trunc(ppuMemRead(ppu, (Math.trunc((Math.trunc((16144 + Math.trunc((palGroup * 4)))) + px)) & 0xFFFF)));
              ppu.fb[Math.trunc((Math.trunc((sl * 256)) + x))] = nesColor(colorIdx);
            }
          }
        }
        fx = Math.trunc((fx + 1));
      }
    }
    i = Math.trunc((i - 1));
  }
}

function renderFrame(_ppu) {
}

function newDmc() {
  return new Dmc(false, false, false, DMC_RATE[0], DMC_RATE[0], 0, 49152, 1, 49152, 0, 0, 8, 0, true, true, false, false);
}

function newPulse(isPulse2) {
  return new Pulse(false, 0, 0, false, false, 0, 0, 0, 0, false, 0, 0, false, 0, false, 0, false, 0, isPulse2);
}

function newTriangle() {
  return new Triangle(false, false, 0, 0, 0, false, 0, 0, 0);
}

function newNoise() {
  return new Noise(false, false, false, 0, 0, false, 0, 0, false, 0, 0, 1);
}

function newApu() {
  let pt = Array.from({length: 31}, () => __clone(0));
  let i = 1;
  while ((i < 31)) {
    pt[i] = (95.52 / ((8128 / (+i)) + 100));
    i = Math.trunc((i + 1));
  }
  let tt = Array.from({length: 203}, () => __clone(0));
  i = 1;
  while ((i < 203)) {
    tt[i] = (163.67 / ((24329 / (+i)) + 100));
    i = Math.trunc((i + 1));
  }
  let samples = [];
  return new Apu(newPulse(false), newPulse(true), newTriangle(), newNoise(), newDmc(), 0, false, false, 0, 0, 0, samples, pt, tt, 0, 0);
}

function apuWrite(apu, reg, val) {
  const v = Math.trunc(val);
  if ((reg <= 3)) {
    writePulse(apu.pulse1, reg, v);
  } else {
    if ((reg <= 7)) {
      writePulse(apu.pulse2, Math.trunc((reg - 4)), v);
    } else {
      if ((reg <= 11)) {
        writeTriangle(apu.triangle, Math.trunc((reg - 8)), v);
      } else {
        if ((reg <= 15)) {
          writeNoise(apu.noise, Math.trunc((reg - 12)), v);
        } else {
          if ((reg <= 19)) {
            writeDmc(apu.dmc, Math.trunc((reg - 16)), v);
          } else {
            if ((reg == 21)) {
              writeStatus(apu, v);
            } else {
              if ((reg == 23)) {
                writeFrameCounter(apu, v);
              }
            }
          }
        }
      }
    }
  }
}

function writePulse(p, idx, v) {
  if ((idx == 0)) {
    p.duty = Math.trunc((Math.trunc((v >> 6)) & 3));
    p.lengthHalt = (Math.trunc((v & 32)) != 0);
    p.constant = (Math.trunc((v & 16)) != 0);
    p.volume = Math.trunc((v & 15));
  } else {
    if ((idx == 1)) {
      p.sweepEnabled = (Math.trunc((v & 128)) != 0);
      p.sweepPeriod = Math.trunc((Math.trunc((v >> 4)) & 7));
      p.sweepNegate = (Math.trunc((v & 8)) != 0);
      p.sweepShift = Math.trunc((v & 7));
      p.sweepReload = true;
    } else {
      if ((idx == 2)) {
        p.timerPeriod = Math.trunc((Math.trunc((p.timerPeriod & 1792)) | v));
      } else {
        p.timerPeriod = Math.trunc((Math.trunc((p.timerPeriod & 255)) | Math.trunc((Math.trunc((v & 7)) << 8))));
        if (p.enabled) {
          p.length = LENGTH_TABLE[Math.trunc((Math.trunc((v >> 3)) & 31))];
        }
        p.dutyPos = 0;
        p.envStart = true;
      }
    }
  }
}

function writeTriangle(t, idx, v) {
  if ((idx == 0)) {
    t.control = (Math.trunc((v & 128)) != 0);
    t.linearReload = Math.trunc((v & 127));
  } else {
    if ((idx == 2)) {
      t.timerPeriod = Math.trunc((Math.trunc((t.timerPeriod & 1792)) | v));
    } else {
      if ((idx == 3)) {
        t.timerPeriod = Math.trunc((Math.trunc((t.timerPeriod & 255)) | Math.trunc((Math.trunc((v & 7)) << 8))));
        if (t.enabled) {
          t.length = LENGTH_TABLE[Math.trunc((Math.trunc((v >> 3)) & 31))];
        }
        t.linearReloadFlag = true;
      }
    }
  }
}

function writeNoise(n, idx, v) {
  if ((idx == 0)) {
    n.lengthHalt = (Math.trunc((v & 32)) != 0);
    n.constant = (Math.trunc((v & 16)) != 0);
    n.volume = Math.trunc((v & 15));
  } else {
    if ((idx == 2)) {
      n.mode = (Math.trunc((v & 128)) != 0);
      n.timerPeriod = NOISE_PERIOD[Math.trunc((v & 15))];
    } else {
      if ((idx == 3)) {
        if (n.enabled) {
          n.length = LENGTH_TABLE[Math.trunc((Math.trunc((v >> 3)) & 31))];
        }
        n.envStart = true;
      }
    }
  }
}

function writeDmc(d, idx, v) {
  if ((idx == 0)) {
    d.irqEnabled = (Math.trunc((v & 128)) != 0);
    d.loopFlag = (Math.trunc((v & 64)) != 0);
    d.rate = DMC_RATE[Math.trunc((v & 15))];
    if ((!d.irqEnabled)) {
      d.irqFlag = false;
    }
  } else {
    if ((idx == 1)) {
      d.output = Math.trunc((v & 127));
    } else {
      if ((idx == 2)) {
        d.sampleAddr = Math.trunc((49152 + Math.trunc((v * 64))));
      } else {
        d.sampleLen = Math.trunc((Math.trunc((v * 16)) + 1));
      }
    }
  }
}

function writeStatus(apu, v) {
  apu.pulse1.enabled = (Math.trunc((v & 1)) != 0);
  if ((!apu.pulse1.enabled)) {
    apu.pulse1.length = 0;
  }
  apu.pulse2.enabled = (Math.trunc((v & 2)) != 0);
  if ((!apu.pulse2.enabled)) {
    apu.pulse2.length = 0;
  }
  apu.triangle.enabled = (Math.trunc((v & 4)) != 0);
  if ((!apu.triangle.enabled)) {
    apu.triangle.length = 0;
  }
  apu.noise.enabled = (Math.trunc((v & 8)) != 0);
  if ((!apu.noise.enabled)) {
    apu.noise.length = 0;
  }
  apu.dmc.irqFlag = false;
  apu.dmc.enabled = (Math.trunc((v & 16)) != 0);
  if ((!apu.dmc.enabled)) {
    apu.dmc.bytesRemaining = 0;
  } else {
    if ((apu.dmc.bytesRemaining == 0)) {
      apu.dmc.curAddr = apu.dmc.sampleAddr;
      apu.dmc.bytesRemaining = apu.dmc.sampleLen;
      if (apu.dmc.bufferEmpty) {
        apu.dmc.needsFetch = true;
      }
    }
  }
}

function writeFrameCounter(apu, v) {
  apu.frameMode = Math.trunc((Math.trunc((v >> 7)) & 1));
  apu.frameInhibit = (Math.trunc((v & 64)) != 0);
  if (apu.frameInhibit) {
    apu.frameIrq = false;
  }
  apu.frameCycle = 0;
  if ((apu.frameMode == 1)) {
    quarterFrame(apu);
    halfFrame(apu);
  }
}

function apuReadStatus(apu) {
  let r = 0;
  if ((apu.pulse1.length > 0)) {
    r = Math.trunc((r | 1));
  }
  if ((apu.pulse2.length > 0)) {
    r = Math.trunc((r | 2));
  }
  if ((apu.triangle.length > 0)) {
    r = Math.trunc((r | 4));
  }
  if ((apu.noise.length > 0)) {
    r = Math.trunc((r | 8));
  }
  if ((apu.dmc.bytesRemaining > 0)) {
    r = Math.trunc((r | 16));
  }
  if (apu.frameIrq) {
    r = Math.trunc((r | 64));
  }
  if (apu.dmc.irqFlag) {
    r = Math.trunc((r | 128));
  }
  apu.frameIrq = false;
  return (r & 0xFF);
}

function apuStep(apu, cycles) {
  let c = 0;
  while ((c < cycles)) {
    clockTriangleTimer(apu.triangle);
    clockDmc(apu.dmc);
    if ((apu.cpuParity == 0)) {
      clockPulseTimer(apu.pulse1);
      clockPulseTimer(apu.pulse2);
      clockNoiseTimer(apu.noise);
    }
    apu.cpuParity = Math.trunc((apu.cpuParity ^ 1));
    stepFrameCounter(apu);
    apu.sampleAccum = (apu.sampleAccum + 1);
    if ((apu.sampleAccum >= CYCLES_PER_SAMPLE)) {
      apu.sampleAccum = (apu.sampleAccum - CYCLES_PER_SAMPLE);
      emitSample(apu);
    }
    c = Math.trunc((c + 1));
  }
}

function stepFrameCounter(apu) {
  apu.frameCycle = Math.trunc((apu.frameCycle + 1));
  const fc = apu.frameCycle;
  if ((apu.frameMode == 0)) {
    if ((fc == 7457)) {
      quarterFrame(apu);
    } else {
      if ((fc == 14913)) {
        quarterFrame(apu);
        halfFrame(apu);
      } else {
        if ((fc == 22371)) {
          quarterFrame(apu);
        } else {
          if ((fc == 29829)) {
            quarterFrame(apu);
            halfFrame(apu);
            if ((!apu.frameInhibit)) {
              apu.frameIrq = true;
            }
          } else {
            if ((fc >= 29830)) {
              apu.frameCycle = 0;
            }
          }
        }
      }
    }
  } else {
    if ((fc == 7457)) {
      quarterFrame(apu);
    } else {
      if ((fc == 14913)) {
        quarterFrame(apu);
        halfFrame(apu);
      } else {
        if ((fc == 22371)) {
          quarterFrame(apu);
        } else {
          if ((fc == 37281)) {
            quarterFrame(apu);
            halfFrame(apu);
          } else {
            if ((fc >= 37282)) {
              apu.frameCycle = 0;
            }
          }
        }
      }
    }
  }
}

function quarterFrame(apu) {
  clockPulseEnvelope(apu.pulse1);
  clockPulseEnvelope(apu.pulse2);
  clockNoiseEnvelope(apu.noise);
  clockTriangleLinear(apu.triangle);
}

function halfFrame(apu) {
  clockPulseLength(apu.pulse1);
  clockPulseLength(apu.pulse2);
  clockPulseSweep(apu.pulse1);
  clockPulseSweep(apu.pulse2);
  if (((!apu.triangle.control) && (apu.triangle.length > 0))) {
    apu.triangle.length = Math.trunc((apu.triangle.length - 1));
  }
  if (((!apu.noise.lengthHalt) && (apu.noise.length > 0))) {
    apu.noise.length = Math.trunc((apu.noise.length - 1));
  }
}

function clockPulseTimer(p) {
  if ((p.timerVal == 0)) {
    p.timerVal = p.timerPeriod;
    p.dutyPos = Math.trunc((Math.trunc((p.dutyPos + 1)) & 7));
  } else {
    p.timerVal = Math.trunc((p.timerVal - 1));
  }
}

function clockDmc(d) {
  d.timer = Math.trunc((d.timer - 1));
  if ((d.timer > 0)) {
    return;
  }
  d.timer = d.rate;
  if ((!d.silence)) {
    if ((Math.trunc((d.shiftReg & 1)) == 1)) {
      if ((d.output <= 125)) {
        d.output = Math.trunc((d.output + 2));
      }
    } else {
      if ((d.output >= 2)) {
        d.output = Math.trunc((d.output - 2));
      }
    }
  }
  d.shiftReg = Math.trunc((d.shiftReg >> 1));
  d.bitsRemaining = Math.trunc((d.bitsRemaining - 1));
  if ((d.bitsRemaining <= 0)) {
    d.bitsRemaining = 8;
    if (d.bufferEmpty) {
      d.silence = true;
    } else {
      d.silence = false;
      d.shiftReg = d.bufferByte;
      d.bufferEmpty = true;
      if ((d.bytesRemaining > 0)) {
        d.needsFetch = true;
      }
    }
  }
}

function dmcFill(d, byte) {
  d.bufferByte = byte;
  d.bufferEmpty = false;
  d.needsFetch = false;
  d.curAddr = Math.trunc((d.curAddr + 1));
  if ((d.curAddr > 65535)) {
    d.curAddr = 32768;
  }
  d.bytesRemaining = Math.trunc((d.bytesRemaining - 1));
  if ((d.bytesRemaining <= 0)) {
    if (d.loopFlag) {
      d.curAddr = d.sampleAddr;
      d.bytesRemaining = d.sampleLen;
    } else {
      if (d.irqEnabled) {
        d.irqFlag = true;
      }
    }
  }
}

function clockTriangleTimer(t) {
  if ((t.timerVal == 0)) {
    t.timerVal = t.timerPeriod;
    if (((t.length > 0) && (t.linearCounter > 0))) {
      t.seqPos = Math.trunc((Math.trunc((t.seqPos + 1)) & 31));
    }
  } else {
    t.timerVal = Math.trunc((t.timerVal - 1));
  }
}

function clockNoiseTimer(n) {
  if ((n.timerVal == 0)) {
    n.timerVal = n.timerPeriod;
    const bit0 = Math.trunc((n.shift & 1));
    const tap = (() => {
    if (n.mode) {
      return Math.trunc((Math.trunc((n.shift >> 6)) & 1));
    } else {
      return Math.trunc((Math.trunc((n.shift >> 1)) & 1));
    }
    })();
    const fb = Math.trunc((bit0 ^ tap));
    n.shift = Math.trunc((Math.trunc((n.shift >> 1)) | Math.trunc((fb << 14))));
  } else {
    n.timerVal = Math.trunc((n.timerVal - 1));
  }
}

function clockPulseEnvelope(p) {
  if (p.envStart) {
    p.envStart = false;
    p.envDecay = 15;
    p.envDivider = p.volume;
  } else {
    if ((p.envDivider == 0)) {
      p.envDivider = p.volume;
      if ((p.envDecay > 0)) {
        p.envDecay = Math.trunc((p.envDecay - 1));
      } else {
        if (p.lengthHalt) {
          p.envDecay = 15;
        }
      }
    } else {
      p.envDivider = Math.trunc((p.envDivider - 1));
    }
  }
}

function clockNoiseEnvelope(n) {
  if (n.envStart) {
    n.envStart = false;
    n.envDecay = 15;
    n.envDivider = n.volume;
  } else {
    if ((n.envDivider == 0)) {
      n.envDivider = n.volume;
      if ((n.envDecay > 0)) {
        n.envDecay = Math.trunc((n.envDecay - 1));
      } else {
        if (n.lengthHalt) {
          n.envDecay = 15;
        }
      }
    } else {
      n.envDivider = Math.trunc((n.envDivider - 1));
    }
  }
}

function clockPulseLength(p) {
  if (((!p.lengthHalt) && (p.length > 0))) {
    p.length = Math.trunc((p.length - 1));
  }
}

function clockTriangleLinear(t) {
  if (t.linearReloadFlag) {
    t.linearCounter = t.linearReload;
  } else {
    if ((t.linearCounter > 0)) {
      t.linearCounter = Math.trunc((t.linearCounter - 1));
    }
  }
  if ((!t.control)) {
    t.linearReloadFlag = false;
  }
}

function clockPulseSweep(p) {
  if (p.sweepReload) {
    p.sweepDivider = p.sweepPeriod;
    p.sweepReload = false;
    return;
  }
  if ((p.sweepDivider > 0)) {
    p.sweepDivider = Math.trunc((p.sweepDivider - 1));
    return;
  }
  p.sweepDivider = p.sweepPeriod;
  if (((p.sweepEnabled && (p.sweepShift > 0)) && (!pulseMuted(p)))) {
    const change = Math.trunc((p.timerPeriod >> p.sweepShift));
    if (p.sweepNegate) {
      let d = change;
      if ((!p.isPulse2)) {
        d = Math.trunc((d + 1));
      }
      p.timerPeriod = Math.trunc((p.timerPeriod - d));
    } else {
      p.timerPeriod = Math.trunc((p.timerPeriod + change));
    }
  }
}

function pulseMuted(p) {
  return ((p.timerPeriod < 8) || (p.timerPeriod > 2047));
}

function pulseOutput(p) {
  if ((((!p.enabled) || (p.length == 0)) || pulseMuted(p))) {
    return 0;
  }
  if ((DUTY_TABLE[Math.trunc((Math.trunc((p.duty * 8)) + p.dutyPos))] == 0)) {
    return 0;
  }
  if (p.constant) {
    return p.volume;
  }
  return p.envDecay;
}

function triangleOutput(t) {
  return TRIANGLE_SEQ[t.seqPos];
}

function noiseOutput(n) {
  if ((((!n.enabled) || (n.length == 0)) || (Math.trunc((n.shift & 1)) == 1))) {
    return 0;
  }
  if (n.constant) {
    return n.volume;
  }
  return n.envDecay;
}

function emitSample(apu) {
  const p1 = pulseOutput(apu.pulse1);
  const p2 = pulseOutput(apu.pulse2);
  const tri = triangleOutput(apu.triangle);
  const noi = noiseOutput(apu.noise);
  const mixed = (apu.pulseTable[Math.trunc((p1 + p2))] + apu.tndTable[Math.trunc((Math.trunc((Math.trunc((3 * tri)) + Math.trunc((2 * noi)))) + apu.dmc.output))]);
  const hp = ((mixed - apu.hpPrevIn) + (0.9995 * apu.hpPrevOut));
  apu.hpPrevIn = mixed;
  apu.hpPrevOut = hp;
  let v = (hp * 28000);
  if ((v > 32000)) {
    v = 32000;
  }
  if ((v < (-32000))) {
    v = (-32000);
  }
  apu.samples.push(((Math.trunc(v) << 16) >> 16));
}

function Pulse$Eq$eq(self, other) {
  return (((((((((((((((((((self.enabled == other.enabled) && (self.duty == other.duty)) && (self.dutyPos == other.dutyPos)) && (self.lengthHalt == other.lengthHalt)) && (self.constant == other.constant)) && (self.volume == other.volume)) && (self.timerPeriod == other.timerPeriod)) && (self.timerVal == other.timerVal)) && (self.length == other.length)) && (self.envStart == other.envStart)) && (self.envDivider == other.envDivider)) && (self.envDecay == other.envDecay)) && (self.sweepEnabled == other.sweepEnabled)) && (self.sweepPeriod == other.sweepPeriod)) && (self.sweepNegate == other.sweepNegate)) && (self.sweepShift == other.sweepShift)) && (self.sweepReload == other.sweepReload)) && (self.sweepDivider == other.sweepDivider)) && (self.isPulse2 == other.isPulse2));
}

function Triangle$Eq$eq(self, other) {
  return (((((((((self.enabled == other.enabled) && (self.control == other.control)) && (self.length == other.length)) && (self.linearReload == other.linearReload)) && (self.linearCounter == other.linearCounter)) && (self.linearReloadFlag == other.linearReloadFlag)) && (self.timerPeriod == other.timerPeriod)) && (self.timerVal == other.timerVal)) && (self.seqPos == other.seqPos));
}

function Noise$Eq$eq(self, other) {
  return ((((((((((((self.enabled == other.enabled) && (self.lengthHalt == other.lengthHalt)) && (self.constant == other.constant)) && (self.volume == other.volume)) && (self.length == other.length)) && (self.envStart == other.envStart)) && (self.envDivider == other.envDivider)) && (self.envDecay == other.envDecay)) && (self.mode == other.mode)) && (self.timerPeriod == other.timerPeriod)) && (self.timerVal == other.timerVal)) && (self.shift == other.shift));
}

function Dmc$Eq$eq(self, other) {
  return (((((((((((((((((self.enabled == other.enabled) && (self.irqEnabled == other.irqEnabled)) && (self.loopFlag == other.loopFlag)) && (self.rate == other.rate)) && (self.timer == other.timer)) && (self.output == other.output)) && (self.sampleAddr == other.sampleAddr)) && (self.sampleLen == other.sampleLen)) && (self.curAddr == other.curAddr)) && (self.bytesRemaining == other.bytesRemaining)) && (self.shiftReg == other.shiftReg)) && (self.bitsRemaining == other.bitsRemaining)) && (self.bufferByte == other.bufferByte)) && (self.bufferEmpty == other.bufferEmpty)) && (self.silence == other.silence)) && (self.needsFetch == other.needsFetch)) && (self.irqFlag == other.irqFlag));
}

main();
__flush();
