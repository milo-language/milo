#!/usr/bin/env bun
// Crash fuzzer for std/jpeg's decoder: mutated and truncated JPEGs must come back as Ok or Err, never a trap, a hang or a runaway allocation.
//
// Seeds are the cjpeg-written files in tests/fixtures/lib/jpeg (every sampling layout,
// progressive, restarts, EXIF). One compiled Milo harness runs all iterations in
// process: each picks a seed and applies 1-6 mutations (bit flips, random bytes, 0xFF/
// marker bytes, 16-bit length/dimension fields set to extremes, chunk duplication and
// deletion, truncation), then calls Jpeg.decode and Jpeg.orientation. A trap aborts the
// harness, so the last "case N" line it printed names the input; --keep keeps it on
// disk. The harness runs under scripts/guard.ts with a memory cap and a timeout, which
// is what turns "bounded memory, no hangs" into a failure instead of a frozen machine.
//
// Usage: bun scripts/fuzz-jpeg.ts [--cases N] [--seed N] [--mem-mb N] [--timeout-s N]
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const argOf = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? parseInt(process.argv[i + 1]!, 10) : d; };
const CASES = argOf("--cases", 20000);
const SEED = argOf("--seed", 1);
const MEM = argOf("--mem-mb", 512);
const TIMEOUT = argOf("--timeout-s", 300);
const KEEP = process.argv.includes("--keep");

const seedDir = join(ROOT, "tests", "fixtures", "lib", "jpeg");
const seeds = readdirSync(seedDir).filter(f => f.endsWith(".jpg")).map(f => join(seedDir, f));

const HARNESS = `
from "std/jpeg" import { Jpeg }
from "std/fs" import { readFile, writeFile }
from "std/args" import { args }
from "std/rng" import { Rng }

fn main(): i32 {
    let a = args()
    let cases = a[1].parseInt()!
    let seed = a[2].parseInt()!
    let keep = a[3].clone()
    var seeds: Vec<string> = Vec.new()
    for i in 4..a.len {
        seeds.push(readFile(a[i])!)
    }
    var rng = Rng.new(seed)
    var ok: i64 = 0
    var err: i64 = 0
    for n in 0..cases {
        var s = seeds[rng.int(seeds.len)].clone()
        let muts = 1 + rng.int(6)
        for _m in 0..muts {
            let kind = rng.int(8)
            let len = s.len
            if len < 4 {
                break
            }
            let p = rng.int(len)
            if kind == 0 {
                s.setByte(p, ((s[p] as i64) ^ (1 << rng.int(8))) as u8)
            } else if kind == 1 {
                s.setByte(p, rng.int(256) as u8)
            } else if kind == 2 {
                s.setByte(p, 0xFF)
                if p + 1 < len {
                    s.setByte(p + 1, (0xC0 + rng.int(64)) as u8)
                }
            } else if kind == 3 && p + 1 < len {
                // A 16-bit big-endian field (segment length, dimension, restart
                // interval) pushed to an extreme.
                let v = [0, 1, 2, 0xFF, 0x7F, 0xFFFF, 0x8000, 0x100][rng.int(8)]
                s.setByte(p, ((v >> 8) & 255) as u8)
                s.setByte(p + 1, (v & 255) as u8)
            } else if kind == 4 {
                s = s.substr(0, p)
            } else if kind == 5 {
                let q = p + rng.int(64)
                let e = if q > len { len } else { q }
                var t = s.substr(0, e)
                t.pushStr(s.slice(p, len))
                s = t
            } else if kind == 6 {
                let q = p + rng.int(64)
                let e = if q > len { len } else { q }
                var t = s.substr(0, p)
                t.pushStr(s.slice(e, len))
                s = t
            } else {
                // Duplicate a marker-sized chunk elsewhere (repeated SOF/SOS/DHT).
                let q = rng.int(len)
                let e = if p + 40 > len { len } else { p + 40 }
                var t = s.substr(0, q)
                t.pushStr(s.slice(p, e))
                t.pushStr(s.slice(q, len))
                s = t
            }
        }
        if keep.len > 0 {
            writeFile(keep, s)!
        }
        print($"case {n}")
        match Jpeg.decode(s) {
            Ok(img) => {
                if img.pixels.len != img.width * img.height * img.channels {
                    print("BAD: pixel buffer does not match dimensions")
                    return 2
                }
                ok += 1
            }
            Err(_e) => {
                err += 1
            }
        }
        let o = Jpeg.orientation(s)
        if o < 1 || o > 8 {
            print("BAD: orientation out of range")
            return 2
        }
    }
    print($"{cases} ran: {ok} decoded, {err} rejected")
    return 0
}
`;

const dir = mkdtempSync(join(tmpdir(), "fuzz-jpeg-"));
try {
  const src = join(dir, "fuzz.milo");
  const bin = join(dir, "fuzz");
  writeFileSync(src, HARNESS);
  execFileSync("bun", ["run", join(ROOT, "src", "main.ts"), "build", src, "-o", bin, "--release"], { stdio: ["ignore", "ignore", "inherit"] });
  const keepPath = KEEP ? join(dir, "last.jpg") : "";
  const r = spawnSync("bun", [join(ROOT, "scripts", "guard.ts"), "--mem-mb", `${MEM}`, "--timeout-s", `${TIMEOUT}`, "--",
    bin, `${CASES}`, `${SEED}`, keepPath, ...seeds], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const lines = out.trimEnd().split("\n");
  const summary = lines.find(l => / ran: /.test(l));
  if (r.status === 0 && summary) {
    console.log(`fuzz-jpeg: seed ${SEED}: ${summary}`);
  } else {
    const last = [...lines].reverse().find(l => l.startsWith("case ")) ?? "(none)";
    console.log(`fuzz-jpeg: seed ${SEED}: FAILED (exit ${r.status}) after ${last}${KEEP ? `; input kept at ${keepPath}` : ""}`);
    console.log(lines.filter(l => !l.startsWith("case ")).slice(-15).join("\n"));
    process.exit(1);
  }
} finally {
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}
