#!/usr/bin/env bun
// Grades std/jpeg against libjpeg-turbo: decoder pixels vs djpeg, encoder bytes vs cjpeg, and decode/encode speed.
//
// The decoder reproduces djpeg's default arithmetic (islow IDCT, fancy upsampling,
// jdcolor tables) and the encoder reproduces `cjpeg -baseline` (islow FDCT, reciprocal
// quantization, h2v2 downsampling, standard tables), so the bar is bit-exactness, and the
// report counts exact cases rather than only a tolerance. A case that is not exact still
// passes when its max per-channel difference is <= 2 (IDCT-rounding territory); anything
// worse, a decode failure, or an encoder output djpeg cannot read is a failure (exit 1).
//
// Sources are synthetic (gradients, hard edges and noise at awkward sizes, so MCU padding
// and the 1- and 2-sample-wide upsampling edge rules are hit) plus every .jpg/.ppm under
// --photos DIR. Each source is compressed with cjpeg in every sampling/progressive/restart/
// quality variant below, then decoded by both decoders.
//
//   bun scripts/jpeg-grade.ts                      # conformance on synthetic sources
//   bun scripts/jpeg-grade.ts --photos DIR         # ... plus real photos
//   bun scripts/jpeg-grade.ts --perf FILE.jpg      # also time decode/encode vs libjpeg-turbo
//   bun scripts/jpeg-grade.ts --write-fixtures     # regenerate tests/fixtures/lib/jpeg/*.jpg
//
// Needs libjpeg-turbo's cjpeg, djpeg and jpegtran on PATH (tjbench for --perf); without
// them it prints "skipped" and exits 0.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
if (flag("--help")) {
  console.log(readFileSync(import.meta.path, "utf-8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
  process.exit(0);
}

const have = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
if (!["cjpeg", "djpeg", "jpegtran"].every(have)) {
  console.log("jpeg-grade: skipped (libjpeg-turbo cjpeg/djpeg/jpegtran not on PATH)");
  process.exit(0);
}

const TMP = mkdtempSync(join(tmpdir(), "jpeg-grade-"));
process.on("exit", () => { if (!flag("--keep")) rmSync(TMP, { recursive: true, force: true }); });

// ── the Milo side ────────────────────────────────────────────────────────────

const HARNESS = `
from "std/jpeg" import { Jpeg, JpegSubsampling }
from "std/image" import { Image }
from "std/fs" import { readFile, writeFile }
from "std/args" import { args }
from "std/time" import { now, since }

fn readPnm(src: &string): Image {
    var fields: Vec<i64> = Vec.new()
    var p: i64 = 2
    var cur: i64 = -1
    while fields.len < 3 {
        let c = src[p] as i64
        if c >= 48 && c <= 57 {
            if cur < 0 { cur = 0 }
            cur = cur * 10 + c - 48
        } else if cur >= 0 {
            fields.push(cur)
            cur = -1
        }
        p += 1
    }
    let ch = if src[1] == '5' { 1 } else { 3 }
    return Image { width: fields[0], height: fields[1], channels: ch, pixels: src.substr(p, src.len) }
}

fn main(): i32 {
    let a = args()
    let mode = a[1].clone()
    let src = readFile(a[2])!
    if mode == "dec" {
        match Jpeg.decode(src) {
            Ok(img) => {
                var out = if img.channels == 1 { "P5\\n" } else { "P6\\n" }
                out.pushStr($"{img.width} {img.height}\\n255\\n")
                out.pushStr(img.pixels)
                writeFile(a[3], out)!
            }
            Err(e) => {
                print(e)
                return 1
            }
        }
    } else if mode == "enc" {
        let img = readPnm(src)
        let q = a[4].parseInt() ?? 75
        let sub = if a[5] == "444" { JpegSubsampling.Chroma444 } else { JpegSubsampling.Chroma420 }
        writeFile(a[3], Jpeg.encode(img, q, sub)!)!
    } else if mode == "bench-dec" {
        let reps = a[3].parseInt() ?? 5
        var best: i64 = 9223372036854775807
        for _r in 0..reps {
            let t = now()
            let _img = Jpeg.decode(src)!
            let us = since(t).toMicros()
            if us < best { best = us }
        }
        print(best)
    } else if mode == "bench-enc" {
        let img = Jpeg.decode(src)!
        let reps = a[3].parseInt() ?? 5
        var best: i64 = 9223372036854775807
        for _r in 0..reps {
            let t = now()
            let _out = Jpeg.encode(img, 85, JpegSubsampling.Chroma420)!
            let us = since(t).toMicros()
            if us < best { best = us }
        }
        print(best)
    }
    return 0
}
`;

const harnessSrc = join(TMP, "harness.milo");
const harness = join(TMP, "harness");
writeFileSync(harnessSrc, HARNESS);
execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", harnessSrc, "-o", harness, "--release"], { stdio: ["ignore", "ignore", "inherit"] });

// Every run of the compiled harness goes through the guard (docs/scripts.md).
function milo(...a: string[]): { code: number; out: string } {
  const r = spawnSync("bun", [join(ROOT, "scripts", "guard.ts"), "--mem-mb", "2048", "--timeout-s", "120", "--", harness, ...a], { encoding: "utf-8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

// ── sources ──────────────────────────────────────────────────────────────────

// Integer-only so tests/fixtures/jpegEncode.milo can rebuild the same pixels exactly:
// horizontal/vertical ramps, a checkerboard of hard edges, and 4 bits of hash noise.
export function synth(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const noise = Number((BigInt(x) * 73856093n ^ BigInt(y) * 19349663n) & 15n);
      const edge = ((x >> 3) + (y >> 3)) % 5 === 0 ? 96 : 0;
      const i = (y * w + x) * 3;
      px[i] = (Math.floor((x * 255) / Math.max(1, w - 1)) + edge + noise) & 255;
      px[i + 1] = (Math.floor((y * 255) / Math.max(1, h - 1)) + noise) & 255;
      px[i + 2] = ((x + y) * 2 + edge) & 255;
    }
  }
  return px;
}

function writePpm(path: string, w: number, h: number, px: Uint8Array) {
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), Buffer.from(px)]));
}

function readPnm(path: string): { w: number; h: number; ch: number; px: Buffer } {
  const d = readFileSync(path);
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(d[i]!))) i++;
    if (d[i] === 35) { while (d[i] !== 10) i++; continue; }
    let j = i;
    while (!/\s/.test(String.fromCharCode(d[j]!))) j++;
    fields.push(d.subarray(i, j).toString());
    i = j;
  }
  return { w: +fields[1]!, h: +fields[2]!, ch: fields[0] === "P5" ? 1 : 3, px: d.subarray(i + 1) };
}

const sources: { name: string; ppm: string; photo?: boolean }[] = [];
for (const [w, h] of [[1, 1], [2, 3], [3, 2], [17, 9], [61, 45], [256, 256], [333, 217]] as const) {
  const p = join(TMP, `syn${w}x${h}.ppm`);
  writePpm(p, w, h, synth(w, h));
  sources.push({ name: `syn${w}x${h}`, ppm: p });
}
const photos = opt("--photos");
if (photos) {
  for (const f of readdirSync(photos)) {
    const full = join(photos, f);
    if (/\.jpe?g$/i.test(f)) {
      const p = join(TMP, `${f}.ppm`);
      execFileSync("djpeg", ["-ppm", "-outfile", p, full]);
      sources.push({ name: f, ppm: p, photo: true });
    } else if (/\.ppm$/i.test(f)) sources.push({ name: f, ppm: full, photo: true });
  }
}

// ── decoder conformance ──────────────────────────────────────────────────────

export const VARIANTS: Record<string, string[]> = {
  q75: ["-quality", "75"], q95: ["-quality", "95"], q20: ["-quality", "20"], q100: ["-quality", "100"],
  s444: ["-sample", "1x1"], s422: ["-sample", "2x1"], s440: ["-sample", "1x2"], s420: ["-sample", "2x2"], s411: ["-sample", "4x1"],
  gray: ["-grayscale"], rgb: ["-rgb"], opt: ["-optimize"],
  prog: ["-progressive"], prog444: ["-progressive", "-sample", "1x1"], proggray: ["-progressive", "-grayscale"],
  progq90: ["-progressive", "-quality", "90"],
  rst1: ["-restart", "1B"], rst3: ["-restart", "3B"], rstprog: ["-restart", "2B", "-progressive"],
};

let decCases = 0, decExact = 0, decWorst = 0;
const failures: string[] = [];
for (const s of sources) {
  for (const [v, o] of Object.entries(VARIANTS)) {
    const jpg = join(TMP, `${s.name}_${v}.jpg`);
    execFileSync("cjpeg", [...o, "-outfile", jpg, s.ppm], { stdio: ["ignore", "ignore", "ignore"] });
    const ref = join(TMP, "ref.pnm"), mine = join(TMP, "mine.pnm");
    execFileSync("djpeg", ["-outfile", ref, jpg]);
    decCases++;
    const r = milo("dec", jpg, mine);
    if (r.code !== 0) { failures.push(`decode ${s.name}_${v}: ${r.out.trim()}`); continue; }
    const a = readPnm(ref), b = readPnm(mine);
    if (a.w !== b.w || a.h !== b.h || a.ch !== b.ch || a.px.length !== b.px.length) {
      failures.push(`decode ${s.name}_${v}: shape ${a.w}x${a.h}x${a.ch} vs ${b.w}x${b.h}x${b.ch}`);
      continue;
    }
    let md = 0;
    for (let i = 0; i < a.px.length; i++) md = Math.max(md, Math.abs(a.px[i]! - b.px[i]!));
    if (md === 0) decExact++;
    else if (md > 2) failures.push(`decode ${s.name}_${v}: max diff ${md}`);
    decWorst = Math.max(decWorst, md);
  }
}
console.log(`decode: ${decCases} cases, ${decExact} bit-exact vs djpeg, worst max diff ${decWorst}`);

// ── encoder conformance ──────────────────────────────────────────────────────

function psnr(a: Buffer, b: Buffer): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; se += d * d; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / se);
}

// PSNR is averaged over the photos when there are any (the synthetic sources are
// adversarial noise and hard edges, and say little about real quality), else over the
// synthetic sources big enough for it to mean something.
let encCases = 0, encSame = 0;
const psnrSum = new Map<string, { sum: number; n: number }>();
for (const s of sources) {
  for (const q of [10, 25, 50, 75, 90, 100]) {
    for (const sub of ["420", "444"]) {
      const ref = join(TMP, "ref.jpg"), mine = join(TMP, "mine.jpg");
      execFileSync("cjpeg", ["-baseline", "-quality", `${q}`, "-sample", sub === "420" ? "2x2" : "1x1", "-outfile", ref, s.ppm], { stdio: ["ignore", "ignore", "ignore"] });
      encCases++;
      const r = milo("enc", s.ppm, mine, `${q}`, sub);
      if (r.code !== 0) { failures.push(`encode ${s.name} q${q} ${sub}: ${r.out.trim()}`); continue; }
      if (readFileSync(ref).equals(readFileSync(mine))) encSame++;
      const back = join(TMP, "back.ppm");
      const d = spawnSync("djpeg", ["-outfile", back, mine]);
      if (d.status !== 0) { failures.push(`encode ${s.name} q${q} ${sub}: djpeg rejects our file`); continue; }
      const orig = readPnm(s.ppm);
      if (photos ? !s.photo : orig.w * orig.h < 4096) continue;
      const key = `${sub} q${q}`;
      const acc = psnrSum.get(key) ?? { sum: 0, n: 0 };
      acc.sum += Math.min(psnr(orig.px, readPnm(back).px), 99);
      acc.n++;
      psnrSum.set(key, acc);
    }
  }
}
const psnrLine = [...psnrSum].map(([k, a]) => `${k} ${(a.sum / a.n).toFixed(1)}dB`).join(", ");
console.log(`encode: ${encCases} cases, ${encSame} byte-identical to cjpeg -baseline`);
console.log(`encode: mean PSNR of our file decoded by djpeg (${photos ? "photos" : "synthetic"}): ${psnrLine}`);

// ── performance ──────────────────────────────────────────────────────────────

const perf = opt("--perf");
if (perf) {
  const sof = (() => { const r = readPnm((execFileSync("djpeg", ["-outfile", join(TMP, "p.pnm"), perf]), join(TMP, "p.pnm"))); return r; })();
  const mp = (sof.w * sof.h) / 1e6;
  const dec = +milo("bench-dec", perf, "7").out.trim();
  const enc = +milo("bench-enc", perf, "7").out.trim();
  let tj = "";
  if (have("tjbench")) {
    const t = spawnSync("tjbench", [perf, "-benchtime", "2", "-warmup", "1"], { encoding: "utf-8" }).stdout ?? "";
    const m = /Decompress[^\n]*\n[^\n]*Throughput:\s*([\d.]+)/.exec(t);
    if (m) tj = `, libjpeg-turbo (tjbench, SIMD) ${(+m[1]!).toFixed(0)} MP/s`;
  }
  console.log(`perf: ${sof.w}x${sof.h} (${mp.toFixed(1)} MP): std/jpeg decode ${(mp / (dec / 1e6)).toFixed(1)} MP/s (${(dec / 1000).toFixed(1)} ms)${tj}; encode q85 4:2:0 ${(mp / (enc / 1e6)).toFixed(1)} MP/s (${(enc / 1000).toFixed(1)} ms)`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

// tests/fixtures/jpegDecode.milo embeds these files and checks their decoded pixels'
// sha256 against djpeg's; --write-fixtures rebuilds them and prints the expectations.
export const FIXTURES: Record<string, string[]> = {
  b420: ["-quality", "75"], b444: ["-sample", "1x1"], b422: ["-sample", "2x1"], b440: ["-sample", "1x2"],
  b411: ["-sample", "4x1"], gray: ["-grayscale"], rgb: ["-rgb"], opt: ["-optimize", "-quality", "90"],
  prog420: ["-progressive"], prog444rst: ["-progressive", "-sample", "1x1", "-restart", "2B"],
  rst1: ["-restart", "1B"], q100: ["-quality", "100"],
};
if (flag("--write-fixtures")) {
  const dir = join(ROOT, "tests", "fixtures", "lib", "jpeg");
  mkdirSync(dir, { recursive: true });
  const src = join(TMP, "fix.ppm");
  writePpm(src, 37, 29, synth(37, 29));
  const narrow = join(TMP, "narrow.ppm");
  writePpm(narrow, 3, 2, synth(3, 2));
  for (const [name, o] of Object.entries(FIXTURES)) {
    const out = join(dir, `${name}.jpg`);
    execFileSync("cjpeg", [...o, "-outfile", out, name === "q100" ? narrow : src], { stdio: ["ignore", "ignore", "ignore"] });
    const ref = join(TMP, "ref.pnm");
    execFileSync("djpeg", ["-outfile", ref, out]);
    const r = readPnm(ref);
    const sha = new Bun.CryptoHasher("sha256").update(r.px).digest("hex");
    console.log(`// @expect: ${name} ${r.w}x${r.h}x${r.ch} ${sha}`);
  }
  for (const [name, o] of [["arith", ["-arithmetic"]], ["lossless", ["-lossless", "1"]], ["p12", ["-precision", "12"]]] as const) {
    execFileSync("cjpeg", [...o, "-outfile", join(dir, `${name}.jpg`), narrow], { stdio: ["ignore", "ignore", "ignore"] });
  }
  // tests/fixtures/jpegEncode.milo rebuilds synth(37, 29) in Milo, encodes it, and
  // expects the sha256 of what `cjpeg -baseline` writes for the same pixels; the gray
  // case encodes synth's green channel.
  const gray = synth(37, 29).filter((_, i) => i % 3 === 1);
  const pgm = join(TMP, "fix.pgm");
  writeFileSync(pgm, Buffer.concat([Buffer.from("P5\n37 29\n255\n"), Buffer.from(gray)]));
  for (const [q, sub, input] of [[50, "2x2", src], [90, "1x1", src], [10, "2x2", src], [100, "1x1", src], [75, "2x2", pgm]] as const) {
    const out = join(TMP, "enc.jpg");
    // No -sample for gray: cjpeg would write the lone component as 2x2, which is legal
    // but pointless, and Jpeg.encode writes 1x1.
    const sample = input === pgm ? [] : ["-sample", sub];
    execFileSync("cjpeg", ["-baseline", "-quality", `${q}`, ...sample, "-outfile", out, input], { stdio: ["ignore", "ignore", "ignore"] });
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(out)).digest("hex");
    console.log(`// @expect: ${input === pgm ? "gray" : "rgb"} q${q} ${sub === "2x2" ? "420" : "444"} ${sha}`);
  }
  // EXIF orientation fixtures: b420 with an APP1 whose IFD0 carries tag 0x0112, one
  // little-endian (II) and one big-endian (MM) TIFF header, behind an unrelated tag.
  const b420 = readFileSync(join(dir, "b420.jpg"));
  for (const [name, orient, le] of [["exif6le", 6, true], ["exif8be", 8, false]] as const) {
    const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
    const u16 = (v: number, o: number) => le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o);
    const u32 = (v: number, o: number) => le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o);
    tiff.write(le ? "II" : "MM", 0, "latin1");
    u16(42, 2); u32(8, 4); u16(2, 8);
    u16(0x010f, 10); u16(2, 12); u32(4, 14); tiff.write("cam\0", 18, "latin1"); // Make
    u16(0x0112, 22); u16(3, 24); u32(1, 26); u16(orient, 30);                   // Orientation
    const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
    writeFileSync(join(dir, `${name}.jpg`), Buffer.concat([b420.subarray(0, 2), seg, b420.subarray(2)]));
  }
  console.log(`wrote ${dir} (sizes: ${readdirSync(dir).map(f => `${f} ${statSync(join(dir, f)).size}`).join(", ")})`);
}

for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
