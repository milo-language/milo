"""Builds and measures Goose, C++, Rust and Milo rows of sixteen Goose-suite benchmarks.

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
from concurrent.futures import ThreadPoolExecutor
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
# BENCH_REPS / BENCH_WARM / BENCH_SIZES (e.g. "medium") trade rigor for a quick pass.
REPS = int(os.environ.get("BENCH_REPS", 3))
WARM = int(os.environ.get("BENCH_WARM", 2))
ONLY_SIZES = set(os.environ["BENCH_SIZES"].split(",")) if os.environ.get("BENCH_SIZES") else None
STACK_RESERVE = "GS_STACK_RESERVE=2147483648ull"
GOOSE_N = r"^(\s*let\s+\w+\s*=\s*)(\d+)(\s*;.*//\s*BENCH_N.*)$"
RUST_N = r"^(\s*const\s+\w+\s*:\s*\w+\s*=\s*)(\d+)(\s*;.*//\s*BENCH_N.*)$"
MILO_N = r"^(\s*let\s+\w+\s*:\s*\w+\s*=\s*)(\d+)(\s*//\s*BENCH_N.*)$"

# Rows mirror run_bench.py's manifest order and rows; milo rows are ours.
BENCHES = [
    ("sum", "N", [1000000, 16000000, 128000000],
     [("goose grow-only array", "goose", "sum.goose", None),
      ("cpp vector", "cpp", "sum.cpp", 0),
      ("cpp vector+reserve", "cpp", "sum.cpp", 1),
      ("rust Vec, collect", "rust", "sum.rs", None),
      ("milo Vec, withCapacity", "milo", "sum.milo", None)]),
    ("push", "N", [1000000, 16000000, 64000000],
     [("goose array, typed references", "goose", "push.goose", None),
      ("cpp vector, indices", "cpp", "push.cpp", 0),
      ("cpp vector+reserve, indices", "cpp", "push.cpp", 1),
      ("cpp deque, pointers", "cpp", "push.cpp", 2),
      ("rust Vec+reserve, indices", "rust", "push.rs", None),
      ("milo Vec+reserve, indices", "milo", "push.milo", None)]),
    ("strlist", "N", [200000, 2000000, 8000000],
     [("goose inline strings, owned", "goose", "strlist.goose", None),
      ("cpp vector<string>", "cpp", "strlist.cpp", 0),
      ("cpp vector<string_view>", "cpp", "strlist.cpp", 1),
      ("cpp flat offsets", "cpp", "strlist.cpp", 2),
      ("rust Vec<String>", "rust", "strlist_owned.rs", None),
      ("rust Vec<&str>", "rust", "strlist_borrowed.rs", None),
      ("milo Vec of offset spans", "milo", "strlist.milo", None),
      ("milo Vec<string>", "milo", "strlist_owned.milo", None)]),
    ("records", "N", [500000, 4000000, 16000000],
     [("goose variable enum", "goose", "records_var.goose", None),
      ("cpp virtual + unique_ptr", "cpp", "records.cpp", 0),
      ("cpp variant + string", "cpp", "records.cpp", 1),
      ("cpp variant + buffer", "cpp", "records.cpp", 2),
      ("rust enum + String", "rust", "records.rs", None),
      ("milo enum + string", "milo", "records.milo", None)]),
    ("tree", "depth", [16, 20, 24],
     [("goose pool + typed relative refs", "goose", "tree.goose", None),
      ("cpp unique_ptr", "cpp", "tree.cpp", 0),
      ("cpp new/delete", "cpp", "tree.cpp", 1),
      ("cpp arena + indices", "cpp", "tree.cpp", 2),
      ("rust Box nodes", "rust", "tree_box.rs", None),
      ("rust arena + indices", "rust", "tree_arena.rs", None),
      ("milo Vec pool, Option<NodeId>", "milo", "tree.milo", None)]),
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
    ("words", "N", [500000, 4000000, 16000000],
     [("goose slices + open addressing", "goose", "words.goose", None),
      ("goose std dictionary", "goose", "words_dictionary.goose", None),
      ("cpp unordered_map<string>", "cpp", "words.cpp", 0),
      ("cpp unordered_map<string_view>", "cpp", "words.cpp", 1),
      ("cpp open addressing", "cpp", "words.cpp", 2),
      ("rust HashMap<&str>", "rust", "words_hashmap.rs", None),
      ("rust open addressing", "rust", "words_open.rs", None),
      ("milo open addressing, spans", "milo", "words.milo", None),
      ("milo HashMap<string>", "milo", "words_hashmap.milo", None)]),
    ("particles", "N", [100000, 1000000, 4000000],
     [("goose AoS, elementwise", "goose", "particles.goose", None),
      ("goose AoS, per component", "goose", "particles_scalar.goose", None),
      ("cpp AoS, per component", "cpp", "particles.cpp", 0),
      ("cpp AoS, elementwise", "cpp", "particles.cpp", 2),
      ("cpp SoA", "cpp", "particles.cpp", 1),
      ("rust AoS, elementwise", "rust", "particles.rs", None),
      ("rust AoS, per component", "rust", "particles_scalar.rs", None),
      ("milo AoS, per component", "milo", "particles.milo", None)]),
    ("sexp", "N", [20000, 100000, 300000],
     [("goose pool + refs, inline text", "goose", "sexp.goose", None),
      ("cpp unique_ptr + string", "cpp", "sexp.cpp", 0),
      ("cpp arena + string_view", "cpp", "sexp.cpp", 1),
      ("rust enum + Box + String", "rust", "sexp_box.rs", None),
      ("rust arena + &str", "rust", "sexp_arena.rs", None),
      ("milo Vec pool + spans", "milo", "sexp.milo", None)]),
    ("lru", "N", [2000000, 8000000, 32000000],
     [("goose reusable pool + pool-relative refs", "goose", "lru.goose", None),
      ("cpp list + unordered_map", "cpp", "lru.cpp", 0),
      ("cpp arena + open addressing", "cpp", "lru.cpp", 1),
      ("rust HashMap + arena", "rust", "lru_hashmap.rs", None),
      ("rust open addressing + arena", "rust", "lru_open.rs", None),
      ("milo open addressing + Vec pool", "milo", "lru.milo", None)]),
    ("scene", "depth", [12, 14, 16],
     [("goose pool + inline child refs", "goose", "scene.goose", None),
      ("cpp unique_ptr children", "cpp", "scene.cpp", 0),
      ("cpp arena + child indices", "cpp", "scene.cpp", 1),
      ("rust Box children", "rust", "scene_box.rs", None),
      ("rust arena + child indices", "rust", "scene_arena.rs", None),
      ("milo Vec pool + child NodeIds", "milo", "scene.milo", None)]),
    ("calc", "N", [100000, 400000, 1600000],
     [("goose local pool + return from", "goose", "calc.goose", None),
      ("cpp unique_ptr + exceptions", "cpp", "calc.cpp", 0),
      ("cpp arena + error codes", "cpp", "calc.cpp", 1),
      ("rust Box + Result", "rust", "calc_box.rs", None),
      ("rust arena + Result", "rust", "calc_arena.rs", None),
      ("milo Vec pool + Result", "milo", "calc.milo", None)]),
    ("bintrees", "depth", [15, 17, 19],
     [("goose local pool per tree", "goose", "bintrees.goose", None),
      ("cpp new/delete", "cpp", "bintrees.cpp", 0),
      ("cpp vector arena", "cpp", "bintrees.cpp", 1),
      ("rust Box", "rust", "bintrees_box.rs", None),
      ("rust Vec arena", "rust", "bintrees_arena.rs", None),
      ("milo Vec pool, cleared per tree", "milo", "bintrees.milo", None)]),
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
    ("blur", "W", [1024, 2048, 8192],
     [("goose flat indexing", "goose", "blur.goose", None),
      ("goose row slices", "goose", "blur_rows.goose", None),
      ("cpp flat indexing", "cpp", "blur.cpp", 0),
      ("cpp row pointers", "cpp", "blur.cpp", 1),
      ("rust flat indexing", "rust", "blur_index.rs", None),
      ("rust row slices", "rust", "blur_windows.rs", None),
      ("milo flat indexing", "milo", "blur.milo", None)]),
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
        run([GOOSE, "-O2", "--standalone", "-o", GEN / f"{tag}.c", src], log)
        run([CLANG, "-O2", f"-D{STACK_RESERVE}", GEN / f"{tag}.c", "-o", exe, "-pthread", "-lm"], log)
    elif lang == "cpp":
        run([CLANGXX, "-O2", "-std=c++20", f"-DBENCH_N={n}", f"-DVARIANT={variant}",
             G / "bench/cpp" / file, "-o", exe, "-pthread", "-lm"], log)
    elif lang == "rust":
        src = GEN / f"{tag}.rs"
        sized(G / "bench/rust" / file, src, n, RUST_N)
        run([RUSTC, "-O", "-C", "codegen-units=1", "-o", exe, src], log)
    else:
        src = GEN / f"{tag}.milo"
        sized(MILODIR / file, src, n, MILO_N)
        run([MILO, "build", "--release", *os.environ.get("MILO_FLAGS", "").split(), src, "-o", exe], log)
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
    # Shared helpers are written once, so the parallel builds below never race on them.
    (GEN / "rng.goose").write_text((G / "bench/goose/rng.goose").read_text())
    (GEN / "bench.rs").write_text((G / "bench/rust/bench.rs").read_text())
    (GEN / "bench.milo").write_text((MILODIR / "bench.milo").read_text())
    jobs = {}
    for name, param, sizes, rows in BENCHES:
        if only and name not in only:
            continue
        for si, n in enumerate(sizes):
            if ONLY_SIZES and SIZE_NAMES[si] not in ONLY_SIZES:
                continue
            for label, lang, file, variant in rows:
                tag = re.sub(r"\W+", "_", f"{name}_{SIZE_NAMES[si]}_{label}").strip("_")
                jobs[tag] = (lang, file, variant, n, tag)
    # Builds run in parallel; timing below stays strictly sequential.
    with ThreadPoolExecutor(os.cpu_count()) as pool:
        exes = dict(zip(jobs, pool.map(lambda j: build(*j), jobs.values())))
    for name, param, sizes, rows in BENCHES:
        if only and name not in only:
            continue
        res[name] = {}
        for si, n in enumerate(sizes):
            if ONLY_SIZES and SIZE_NAMES[si] not in ONLY_SIZES:
                continue
            for label, lang, file, variant in rows:
                tag = re.sub(r"\W+", "_", f"{name}_{SIZE_NAMES[si]}_{label}").strip("_")
                m = measure(exes[tag])
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
             f"Wall time in ms: best of {REPS} whole-process runs after {WARM} warm-ups. Peak MB: max RSS "
             "from `/usr/bin/time -l` at the largest size measured. A row whose stdout differs from the "
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
