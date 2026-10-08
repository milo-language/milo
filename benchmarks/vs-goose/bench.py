"""Builds and measures Goose, C++, Rust and Milo rows of five Goose-suite benchmarks.

Build lines reproduce bench/run_bench.py's non-Windows clang path exactly (goose -O2
--standalone then clang -O2 -DGS_STACK_RESERVE, clang++ -O2 -std=c++20 -DBENCH_N
-DVARIANT, rustc -O -C codegen-units=1); every row, Milo included, is then timed the
same way: 2 warm-ups, best of 3 whole-process wall times, each run under
/usr/bin/time -l for max RSS. Exits 1 if any row's stdout differs from the others.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

G = Path(os.environ["G"])
HERE = Path(__file__).resolve().parent
GEN = HERE / "gen"
MILODIR = HERE / "milo"
CLANG = os.environ["CLANG"]
CLANGXX = os.environ["CLANGXX"]
RUSTC = os.environ["RUSTC"]
GOOSE = os.environ["GOOSE"]
MILO = os.environ["MILO"]
REPS, WARM = 3, 2
STACK_RESERVE = "GS_STACK_RESERVE=2147483648ull"
GOOSE_N = r"^(\s*let\s+\w+\s*=\s*)(\d+)(\s*;.*//\s*BENCH_N.*)$"
RUST_N = r"^(\s*const\s+\w+\s*:\s*\w+\s*=\s*)(\d+)(\s*;.*//\s*BENCH_N.*)$"
MILO_N = r"^(\s*let\s+\w+\s*:\s*\w+\s*=\s*)(\d+)(\s*//\s*BENCH_N.*)$"

# Rows mirror run_bench.py's manifest for these five; milo rows are ours.
BENCHES = [
    ("records", "N", [500000, 4000000, 16000000],
     [("goose variable enum", "goose", "records_var.goose", None),
      ("goose fixed enum", "goose", "records_fixed.goose", None),
      ("cpp virtual + unique_ptr", "cpp", "records.cpp", 0),
      ("cpp variant + string", "cpp", "records.cpp", 1),
      ("cpp variant + buffer", "cpp", "records.cpp", 2),
      ("rust enum + String", "rust", "records.rs", None),
      ("milo enum + string", "milo", "records.milo", None)]),
    ("interp", "depth", [16, 20, 24],
     [("goose case functions + relative refs", "goose", "interp.goose", None),
      ("cpp virtual + unique_ptr", "cpp", "interp.cpp", 0),
      ("cpp variant + arena", "cpp", "interp.cpp", 1),
      ("cpp tagged union + arena", "cpp", "interp.cpp", 2),
      ("rust enum + Box", "rust", "interp_box.rs", None),
      ("rust enum + arena indices", "rust", "interp_arena.rs", None),
      ("milo enum + Vec pool, NodeId", "milo", "interp.milo", None)]),
    ("graph", "V", [100000, 500000, 2000000],
     [("goose one-pass, typed relative refs", "goose", "graph.goose", None),
      ("goose CSR two-pass", "goose", "graph_csr.goose", None),
      ("cpp vector<vector>", "cpp", "graph.cpp", 0),
      ("cpp CSR two-pass", "cpp", "graph.cpp", 1),
      ("cpp arena + indices", "cpp", "graph.cpp", 2),
      ("rust Vec<Vec>", "rust", "graph_nested.rs", None),
      ("rust CSR two-pass", "rust", "graph_csr.rs", None),
      ("rust arena + indices", "rust", "graph_arena.rs", None),
      ("milo edge pool, Option<EdgeId>", "milo", "graph.milo", None),
      ("milo Vec<Vec>", "milo", "graph_nested.milo", None),
      ("milo CSR two-pass", "milo", "graph_csr.milo", None)]),
    ("blur", "W", [1024, 2048, 8192],
     [("goose flat indexing", "goose", "blur.goose", None),
      ("goose row slices", "goose", "blur_rows.goose", None),
      ("cpp flat indexing", "cpp", "blur.cpp", 0),
      ("cpp row pointers", "cpp", "blur.cpp", 1),
      ("rust flat indexing", "rust", "blur_index.rs", None),
      ("rust row slices", "rust", "blur_windows.rs", None),
      ("milo flat indexing", "milo", "blur.milo", None)]),
    ("respond", "N", [100000, 400000, 1600000],
     [("goose inline DTO", "goose", "respond.goose", None),
      ("goose streaming", "goose", "respond_stream.goose", None),
      ("cpp DTO + string", "cpp", "respond.cpp", 0),
      ("cpp streaming", "cpp", "respond.cpp", 1),
      ("rust DTO + String", "rust", "respond_dto.rs", None),
      ("rust streaming", "rust", "respond_stream.rs", None),
      ("milo DTO + string", "milo", "respond.milo", None),
      ("milo DTO + pushDec (no toString)", "milo", "respond_fastint.milo", None),
      ("milo streaming", "milo", "respond_stream.milo", None)]),
]
SIZE_NAMES = ["small", "medium", "large"]


def sized(src, dst, n, pat):
    text, k = re.subn(pat, lambda m: m.group(1) + str(n) + m.group(3),
                      src.read_text(), count=1, flags=re.M)
    if k != 1:
        sys.exit(f"no BENCH_N line in {src}")
    dst.write_text(text)


def run(argv, log):
    r = subprocess.run([str(a) for a in argv], capture_output=True, text=True)
    log.write_text(r.stdout + r.stderr)
    if r.returncode != 0:
        sys.exit(f"build failed: {' '.join(map(str, argv))}\n{r.stdout}{r.stderr}")


def build(lang, file, variant, n, tag):
    exe = GEN / tag
    log = GEN / f"{tag}.log"
    if lang == "goose":
        src = GEN / f"{tag}.goose"
        sized(G / "bench/goose" / file, src, n, GOOSE_N)
        (GEN / "rng.goose").write_text((G / "bench/goose/rng.goose").read_text())
        run([GOOSE, "-O2", "--standalone", "-o", GEN / f"{tag}.c", src], log)
        run([CLANG, "-O2", f"-D{STACK_RESERVE}", GEN / f"{tag}.c", "-o", exe, "-pthread", "-lm"], log)
    elif lang == "cpp":
        run([CLANGXX, "-O2", "-std=c++20", f"-DBENCH_N={n}", f"-DVARIANT={variant}",
             G / "bench/cpp" / file, "-o", exe, "-pthread", "-lm"], log)
    elif lang == "rust":
        src = GEN / f"{tag}.rs"
        sized(G / "bench/rust" / file, src, n, RUST_N)
        (GEN / "bench.rs").write_text((G / "bench/rust/bench.rs").read_text())
        run([RUSTC, "-O", "-C", "codegen-units=1", "-o", exe, src], log)
    else:
        src = GEN / f"{tag}.milo"
        sized(MILODIR / file, src, n, MILO_N)
        (GEN / "bench.milo").write_text((MILODIR / "bench.milo").read_text())
        run([MILO, "build", "--release", src, "-o", exe], log)
    return exe


def once(exe):
    t = time.perf_counter()
    r = subprocess.run(["/usr/bin/time", "-l", str(exe)], capture_output=True, text=True)
    ms = (time.perf_counter() - t) * 1000
    m = re.search(r"(\d+)\s+maximum resident set size", r.stderr)
    return r.returncode, ms, int(m.group(1)) if m else 0, r.stdout


def measure(exe):
    for _ in range(WARM):
        once(exe)
    best, peak, out, code = None, 0, None, 0
    for _ in range(REPS):
        code, ms, rss, out = once(exe)
        if code != 0:
            return dict(ok=False, note=f"exit {code}", out=out)
        best = ms if best is None else min(best, ms)
        peak = max(peak, rss)
    return dict(ok=True, ms=best, peak=peak, out=out)


def main():
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 and sys.argv[1] else None
    GEN.mkdir(exist_ok=True)
    resfile = HERE / "measurements.json"
    res = json.loads(resfile.read_text()) if resfile.exists() and only else {}
    bad = []
    for name, param, sizes, rows in BENCHES:
        if only and name not in only:
            continue
        res[name] = {}
        for si, n in enumerate(sizes):
            for label, lang, file, variant in rows:
                tag = re.sub(r"\W+", "_", f"{name}_{SIZE_NAMES[si]}_{label}").strip("_")
                m = measure(build(lang, file, variant, n, tag))
                res[name].setdefault(label, {})[SIZE_NAMES[si]] = m
                print(f"  {name:8} {SIZE_NAMES[si]:6} {label:38} "
                      f"{m.get('ms', 0):9.1f} ms {m.get('peak', 0) / 2**20:8.1f} MB", flush=True)
            outs = {lbl: res[name][lbl][SIZE_NAMES[si]] for lbl, *_ in rows}
            # The reference is the first C++ row: a plain, unsurprising implementation.
            ref = next(m["out"] for lbl, lang, *_ in rows if lang == "cpp"
                       for m in [outs[lbl]])
            for lbl, m in outs.items():
                m["match"] = m["ok"] and m["out"] == ref
                if not m["match"]:
                    bad.append(f"{name} {SIZE_NAMES[si]} {lbl}: got {m['out']!r} want {ref!r}")
    resfile.write_text(json.dumps(res, indent=1))
    report(res)
    for b in bad:
        print("CHECKSUM MISMATCH:", b)
    sys.exit(1 if bad else 0)


def fmt(m, key):
    if not m or not m.get("ok"):
        return "--"
    v = m["ms"] if key == "ms" else m["peak"] / 2**20
    s = f"{v:,.1f}"
    return s if m.get("match") else s + " (mismatch)"


def report(res):
    lines = ["# Milo vs Goose, C++, Rust on the Goose suite (macOS)", "",
             f"Machine: {subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True, text=True).stdout.strip()}. "
             f"Toolchains: {first_line([CLANG, '--version'])}; {first_line([RUSTC, '--version'])}; "
             f"Milo `milo build --release` (-O3, overflow checks on, its default).", "",
             "Wall time in ms: best of 3 whole-process runs after 2 warm-ups. Peak MB: max RSS "
             "from `/usr/bin/time -l` at the largest size. A row whose stdout differs from the "
             "first C++ row is marked (mismatch).", ""]
    summary = []
    for name, param, sizes, rows in BENCHES:
        if name not in res:
            continue
        lines += [f"## {name}", "", "| row | " + " | ".join(
            f"{s} ({param}={n:,})" for s, n in zip(SIZE_NAMES, sizes)) + " | peak MB (large) |",
            "|---|" + "---:|" * 4]
        for label, *_ in rows:
            r = res[name].get(label, {})
            lines.append(f"| {label} | " + " | ".join(fmt(r.get(s), "ms") for s in SIZE_NAMES)
                         + f" | {fmt(r.get('large'), 'mb')} |")
        lines.append("")
        # Only rows that ran and matched the reference compete for "best".
        def good(lang, s):
            return [m for lbl, lg, *_ in rows if lg == lang
                    for m in [res[name].get(lbl, {}).get(s)] if m and m.get("match")]

        def ratio(key, s, other):
            a = [m[key] for m in good("milo", s)]
            b = [m[key] for m in good(other, s)]
            return f"{min(a) / min(b):.2f}" if a and b else "--"

        summary.append(f"| {name} | " + " | ".join(
            [ratio("ms", s, "goose") for s in SIZE_NAMES] + [ratio("peak", "large", "goose")]
            + [ratio("ms", s, "rust") for s in SIZE_NAMES] + [ratio("peak", "large", "rust")]) + " |")
    lines += ["## Summary: Milo time (and memory) as a ratio, below 1.00 means Milo is faster (smaller)",
              "", "Best Milo row against the best Goose row and the best Rust row at each size; memory is the smallest peak of each language's rows at the large size.", "",
              "| bench | vs goose small | medium | large | mem vs goose | vs rust small | medium | large | mem vs rust |",
              "|---|" + "---:|" * 8] + summary + [""]
    (HERE / "results.md").write_text("\n".join(lines))
    print("\n".join(lines[-len(summary) - 3:]))


def first_line(argv):
    return subprocess.run(argv, capture_output=True, text=True).stdout.splitlines()[0]


if __name__ == "__main__":
    main()
