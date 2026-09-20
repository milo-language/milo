// Resolves the one milo-fmt binary that every formatter entry point shells out to
// (`milo fmt`, the LSP's textDocument/formatting handler, the pre-commit hook).
// There is deliberately no second formatter implementation: a divergent fallback
// would silently rewrite source (hex→decimal and friends) on save.
//
// Two modes, because a shipped `bun build --compile` binary lives on a read-only
// $bunfs — building bin/milo-fmt next to the executable there fails with EROFS,
// which is what broke `milo fmt` for everyone installing from a release tarball:
//   - dev checkout: build examples/cli-tools/fmt.milo → bin/milo-fmt, rebuilt
//     whenever fmt.milo or any src/*.ts is newer (the compiler is an input too:
//     fmt.milo is Milo source, so a codegen change alters its behavior without
//     fmt.milo moving).
//   - shipped binary: no repo on disk, so build the embedded copy of that source
//     into the user cache, keyed by a hash of the source and the executable's
//     identity — the same two inputs the mtime check covers in a checkout.
//
// Every staleness check fails closed: an unprovable-fresh binary is rebuilt, never
// used. A stale formatter is not a degraded formatter, it is a wrong one — one
// already shipped a formatter bug into 16 committed files via the pre-commit hook,
// which formats staged .milo and re-stages the result, quietly reverting the fix
// in the same commit.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { cacheRoot } from "./pkg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FMT_SRC = resolve(ROOT, "examples", "cli-tools", "fmt.milo");
const SRC_DIR = resolve(ROOT, "src");

// A shipped binary is one whose own sources aren't on disk beside it. Checked
// against src/main.ts rather than $bunfs so it stays right if Bun renames the
// virtual mount, and so a release binary dropped inside a checkout still takes
// the cache path (its bin/ may not be writable, and its compiler is itself, not
// the checkout's).
const COMPILED = !existsSync(join(SRC_DIR, "main.ts"));

type FmtBin = { path: string } | { error: string };

// argv for invoking this compiler: a shipped binary IS the compiler; in a
// checkout it's the current runtime plus src/main.ts.
function compilerArgv(rest: string[]): [string, string[]] {
  return COMPILED ? [process.execPath, rest] : [process.execPath, [join(SRC_DIR, "main.ts"), ...rest]];
}

export function ensureFmtBinary(): FmtBin {
  return COMPILED ? cachedFmtBinary() : devFmtBinary();
}

function devFmtBinary(): FmtBin {
  const bin = resolve(ROOT, "bin", "milo-fmt");
  if (!devStale(bin)) return { path: bin };
  if (!existsSync(FMT_SRC)) return { error: `formatter source not found at ${FMT_SRC}` };
  mkdirSync(resolve(ROOT, "bin"), { recursive: true });
  return build(FMT_SRC, bin);
}

function devStale(bin: string): boolean {
  if (!existsSync(bin)) return true;
  try {
    const binTime = statSync(bin).mtimeMs;
    if (statSync(FMT_SRC).mtimeMs > binTime) return true;
    for (const f of readdirSync(SRC_DIR)) {
      if (!f.endsWith(".ts")) continue;
      if (statSync(join(SRC_DIR, f)).mtimeMs > binTime) return true;
    }
    return false;
  } catch {
    return true; // can't prove it's fresh — rebuild rather than format with unknown rules
  }
}

function cachedFmtBinary(): FmtBin {
  let source: string | undefined;
  try { source = require("./stdlib-bundle").FMT_SOURCE; } catch {}
  if (!source) return { error: "this build embeds no formatter source (run scripts/bundle-stdlib.ts)" };

  // mtime can't decide freshness here: the source lives inside the executable and
  // the "compiler" is that same executable. Hash both instead — a different milo
  // build gets a different cache entry rather than reusing one built by another.
  const key = createHash("sha256")
    .update(source)
    .update(executableIdentity())
    .digest("hex")
    .slice(0, 16);
  const binDir = join(cacheRoot(), "fmt");
  const bin = join(binDir, `milo-fmt-${key}`);
  if (existsSync(bin)) return { path: bin };

  try {
    mkdirSync(binDir, { recursive: true });
  } catch (e) {
    return { error: `could not create ${binDir}: ${e}` };
  }
  const srcPath = join(binDir, `fmt-${key}.milo`);
  try {
    writeFileSync(srcPath, source);
  } catch (e) {
    return { error: `could not write ${srcPath}: ${e}` };
  }

  // Build to a per-pid temp then rename: two milo processes (an editor's LSP and a
  // CLI run) can race here, and an atomic swap means neither ever observes a
  // half-written binary.
  const tmp = `${bin}.${process.pid}.tmp`;
  const built = build(srcPath, tmp);
  if ("error" in built) return built;
  try {
    renameSync(tmp, bin);
  } catch (e) {
    return { error: `could not install ${bin}: ${e}` };
  }
  pruneStaleCache(binDir);
  return { path: bin };
}

// Identity of the running compiler, cheap enough to compute per invocation
// (hashing a ~100MB executable is not). Any rebuild or reinstall changes size or
// mtime, so a new compiler never reuses an old formatter.
function executableIdentity(): string {
  try {
    const st = statSync(process.execPath);
    return `${process.execPath}:${st.size}:${st.mtimeMs}`;
  } catch {
    return process.execPath;
  }
}

// Keep the few most recent entries and drop the rest, so the cache doesn't grow by
// a binary per upgrade. Deliberately NOT "delete everything but the current key":
// someone running a stable and a nightly milo side by side would have each
// invocation evict the other's formatter and pay the rebuild every time.
const KEEP_CACHED_FORMATTERS = 3;

function pruneStaleCache(binDir: string) {
  try {
    const entries = readdirSync(binDir)
      .filter(f => f.startsWith("milo-fmt-"))
      .map(f => ({ f, mtime: statSync(join(binDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of entries.slice(KEEP_CACHED_FORMATTERS)) {
      rmSync(join(binDir, f), { force: true });
      rmSync(join(binDir, `fmt-${f.slice("milo-fmt-".length)}.milo`), { force: true });
    }
  } catch {}
}

function build(src: string, out: string): FmtBin {
  const [cmd, argv] = compilerArgv(["build", src, "-o", out]);
  const r = spawnSync(cmd, argv, { encoding: "utf-8" });
  if (r.status !== 0 || !existsSync(out)) {
    return { error: (r.stderr || r.error?.message || "").trim() || `could not build ${out}` };
  }
  return { path: out };
}
