// End-to-end tests for the package-manager CLI verbs (src/pkgcli.ts).
//
// NO NETWORK. Every package here is a local-path dependency in a temp dir, and the
// XDG_* variables are redirected so the suite never touches the real ~/.milo cache,
// ~/.local/bin, or the user's installed.json. Anything that would need a git remote
// (add from github.com, `milo update` tag re-resolution, `milo publish`'s push) is
// deliberately not covered here — see the notes at the bottom.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");

let ROOT: string;
let ENV: Record<string, string>;

// A fresh XDG sandbox per run: cache, data (installed.json), and bin dir.
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "milo-pkgcli-"));
  ENV = {
    ...(process.env as Record<string, string>),
    XDG_CACHE_HOME: join(ROOT, "cache"),
    XDG_DATA_HOME: join(ROOT, "data"),
    XDG_BIN_HOME: join(ROOT, "bin"),
  };
  mkdirSync(join(ROOT, "bin"), { recursive: true });

  // greet: library only. mtool: binaries only. both: ships both.
  writePkg("greet", `{ "name": "greet", "version": "0.1.0", "lib": "lib.milo" }`, {
    "lib.milo": `pub fn greeting(): string {\n  return "hi from greet"\n}\n`,
  });
  writePkg("mtool", `{ "name": "mtool", "version": "0.2.0", "bin": { "mtool": "src/cli.milo" } }`, {
    "src/cli.milo": `fn main() {\n  print("mtool ran")\n}\n`,
  });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function writePkg(name: string, manifest: string, files: Record<string, string>): string {
  const dir = join(ROOT, "pkgs", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "milo.json"), manifest);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function milo(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", ["run", COMPILER, ...args], { cwd, env: ENV, encoding: "utf-8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// A scratch project directory (not nested under another milo.json).
function project(name: string): string {
  const dir = join(ROOT, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const GREET = () => join(ROOT, "pkgs", "greet");
const MTOOL = () => join(ROOT, "pkgs", "mtool");

describe("init / new", () => {
  test("init writes a milo.json named after the directory", () => {
    const dir = project("initme");
    const r = milo(dir, "init");
    expect(r.code).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.name).toBe("initme");
    expect(m.version).toBe("0.1.0");
    // a second init must not silently clobber the first
    expect(milo(dir, "init").code).toBe(1);
  });

  test("new scaffolds dir + main.milo + milo.json + .gitignore, and it runs", () => {
    const parent = project("newparent");
    const r = milo(parent, "new", "scaffolded");
    expect(r.code).toBe(0);
    const dir = join(parent, "scaffolded");
    expect(existsSync(join(dir, "milo.json"))).toBe(true);
    expect(existsSync(join(dir, "main.milo"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    const run = milo(dir, "run", "main.milo");
    expect(run.code).toBe(0);
    expect(run.out).toContain("hello from scaffolded");
  });
});

describe("add / install / lock", () => {
  test("add writes the manifest and the lock, and the dep resolves at compile time", () => {
    const dir = project("app");
    expect(milo(dir, "init").code).toBe(0);
    const add = milo(dir, "add", GREET());
    expect(add.code).toBe(0);

    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.deps.greet).toBe(GREET());

    const lock = JSON.parse(readFileSync(join(dir, "milo.lock"), "utf-8"));
    expect(lock.lockVersion).toBe(1);
    expect(lock.packages.greet.url).toBe(GREET());
    expect(lock.packages.greet.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(lock.packages.greet.deps).toEqual([]);

    // The whole point: the compiler resolves the import out of the cache the
    // installer just populated (the XDG reconciliation in resolver.ts).
    writeFileSync(join(dir, "main.milo"), `from "greet" import { greeting }\n\nfn main() {\n  print(greeting())\n}\n`);
    const run = milo(dir, "run", "main.milo");
    expect(run.code).toBe(0);
    expect(run.out).toContain("hi from greet");
  });

  test("add --dev records under devDeps", () => {
    const dir = project("devapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", "--dev", GREET()).code).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.devDeps.greet).toBe(GREET());
    expect(m.deps?.greet).toBeUndefined();
  });

  test("remove drops it from the manifest and prunes the lock", () => {
    const dir = project("removeapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    expect(milo(dir, "remove", "greet").code).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.deps.greet).toBeUndefined();
    const lock = JSON.parse(readFileSync(join(dir, "milo.lock"), "utf-8"));
    expect(lock.packages.greet).toBeUndefined();
    expect(milo(dir, "remove", "nosuch").code).toBe(1);
  });

  test("install --frozen fails on a stale lock and passes on a fresh one", () => {
    const dir = project("frozenapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    expect(milo(dir, "install", "--frozen").code).toBe(0);

    // Add a dependency by hand without re-locking — exactly the CI case.
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    m.deps.other = GREET();
    writeFileSync(join(dir, "milo.json"), JSON.stringify(m, null, 2));
    const stale = milo(dir, "install", "--frozen");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("milo.lock is out of date");
  });

  test("install --frozen fails when the lock is missing entirely", () => {
    const dir = project("nolock");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    rmSync(join(dir, "milo.lock"));
    const r = milo(dir, "install", "--frozen");
    expect(r.code).toBe(1);
    expect(r.err).toContain("milo.lock is missing");
  });

  test("tree and why report the graph", () => {
    const dir = project("treeapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    const tree = milo(dir, "tree");
    expect(tree.code).toBe(0);
    expect(tree.out).toContain("treeapp 0.1.0");
    expect(tree.out).toContain("greet");
    const why = milo(dir, "why", "greet");
    expect(why.code).toBe(0);
    expect(why.out).toContain("treeapp -> greet");
    expect(milo(dir, "why", "nosuch").code).toBe(1);
  });

  test("vendor copies deps in-tree, rewrites deps to local paths, and still builds", () => {
    const dir = project("vendorapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    writeFileSync(join(dir, "main.milo"), `from "greet" import { greeting }\n\nfn main() {\n  print(greeting())\n}\n`);
    const v = milo(dir, "vendor");
    expect(v.code).toBe(0);
    expect(existsSync(join(dir, "vendor", "greet", "lib.milo"))).toBe(true);
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.deps.greet).toBe("./vendor/greet");
    const run = milo(dir, "run", "main.milo");
    expect(run.code).toBe(0);
    expect(run.out).toContain("hi from greet");
  });

  test("run auto-installs a locked dep whose cache entry is gone", () => {
    const dir = project("autoapp");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", GREET()).code).toBe(0);
    writeFileSync(join(dir, "main.milo"), `from "greet" import { greeting }\n\nfn main() {\n  print(greeting())\n}\n`);
    rmSync(join(ROOT, "cache", "milo", "local"), { recursive: true, force: true });
    const run = milo(dir, "run", "main.milo");
    expect(run.code).toBe(0);
    expect(run.out).toContain("hi from greet");
  });
});

describe("lib/bin split", () => {
  test("add on a bin-only package points at milo tool install", () => {
    const dir = project("binonly");
    expect(milo(dir, "init").code).toBe(0);
    const r = milo(dir, "add", MTOOL());
    expect(r.code).toBe(1);
    expect(r.err).toContain("ships no library");
    expect(r.err).toContain(`milo tool install ${MTOOL()}`);
    // and nothing was written to the manifest
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.deps.mtool).toBeUndefined();
  });

  test("tool install on a lib-only package points at milo add", () => {
    const dir = project("libonly");
    const r = milo(dir, "tool", "install", GREET());
    expect(r.code).toBe(1);
    expect(r.err).toContain("ships no executables");
    expect(r.err).toContain(`milo add ${GREET()}`);
  });

  test("install <pkg> refuses instead of guessing", () => {
    const dir = project("npmhabit");
    expect(milo(dir, "init").code).toBe(0);
    const r = milo(dir, "install", "greet");
    expect(r.code).toBe(1);
    expect(r.err).toContain("takes no package");
    expect(r.err).toContain("milo add greet");
    expect(r.err).toContain("milo tool install greet");
  });
});

describe("milo tool", () => {
  const BIN = () => join(ROOT, "bin", "mtool");
  const RECEIPTS = () => join(ROOT, "data", "milo", "installed.json");

  test("tool install builds a working binary carrying a greppable MILO_PKG section", () => {
    const dir = project("toolapp");
    const r = milo(dir, "tool", "install", MTOOL());
    expect(r.code).toBe(0);
    expect(existsSync(BIN())).toBe(true);

    // it runs
    const ran = spawnSync(BIN(), [], { encoding: "utf-8" });
    expect(ran.stdout).toContain("mtool ran");

    // the embedded payload is present, tagged, and correct
    const bytes = readFileSync(BIN());
    const at = bytes.indexOf(Buffer.from("MILO_PKG\0", "ascii"));
    expect(at).toBeGreaterThan(0);
    const end = bytes.indexOf(0, at + 9);
    const meta = JSON.parse(bytes.subarray(at + 9, end).toString("utf-8"));
    expect(meta).toMatchObject({ name: "mtool", version: "0.2.0", bin: "mtool", url: MTOOL() });

    // and it greps the same way a user would check
    const strings = spawnSync("bash", ["-c", `strings '${BIN()}' | grep -c MILO_PKG`], { encoding: "utf-8" });
    expect(Number((strings.stdout ?? "0").trim())).toBeGreaterThan(0);
  }, 120000);

  test("tool list shows the installed binary", () => {
    const r = milo(ROOT, "tool", "list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("mtool");
    expect(r.out).toContain("0.2.0");
  });

  test("tool list --repair rebuilds a deleted installed.json from the binaries", () => {
    expect(existsSync(RECEIPTS())).toBe(true);
    rmSync(RECEIPTS());
    const bare = milo(ROOT, "tool", "list");
    expect(bare.out).toContain("no tools installed");
    const repaired = milo(ROOT, "tool", "list", "--repair");
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain("mtool");
    const cache = JSON.parse(readFileSync(RECEIPTS(), "utf-8"));
    expect(cache.tools.mtool.name).toBe("mtool");
    expect(cache.tools.mtool.version).toBe("0.2.0");
  });

  test("installing a different package over an existing binary is refused", () => {
    writePkg("impostor", `{ "name": "impostor", "version": "9.9.9", "bin": { "mtool": "src/cli.milo" } }`, {
      "src/cli.milo": `fn main() {\n  print("impostor")\n}\n`,
    });
    const r = milo(ROOT, "tool", "install", join(ROOT, "pkgs", "impostor"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to overwrite");
    expect(r.err).toContain("it is mtool 0.2.0");
    // the real binary survived
    expect(spawnSync(BIN(), [], { encoding: "utf-8" }).stdout).toContain("mtool ran");
  }, 120000);

  test("uninstall refuses a foreign binary that carries no section", () => {
    const foreign = join(ROOT, "bin", "foreign");
    copyFileSync("/bin/echo", foreign);
    const r = milo(ROOT, "tool", "uninstall", "foreign");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no MILO_PKG section");
    expect(existsSync(foreign)).toBe(true); // still there
  });

  test("uninstall removes the binary and drops the receipt", () => {
    const r = milo(ROOT, "tool", "uninstall", "mtool");
    expect(r.code).toBe(0);
    expect(existsSync(BIN())).toBe(false);
    const cache = JSON.parse(readFileSync(RECEIPTS(), "utf-8"));
    expect(cache.tools.mtool).toBeUndefined();
    // uninstalling something that was never installed is an error, not a no-op
    expect(milo(ROOT, "tool", "uninstall", "mtool").code).toBe(1);
  });

  test("tool run builds and runs without installing anything", () => {
    const before = readdirSync(join(ROOT, "bin"));
    const r = milo(ROOT, "tool", "run", MTOOL());
    expect(r.code).toBe(0);
    expect(r.out).toContain("mtool ran");
    expect(readdirSync(join(ROOT, "bin")).sort()).toEqual(before.sort());
  }, 120000);
});

// The git fetch path, exercised against a local repo over file:// — a real clone,
// real ref resolution, real commit pin, no network. Only the transport differs from
// github.com/foo/bar, and the transport is git's problem, not ours.
describe("git sources (local file:// remote, still no network)", () => {
  let repo: string;
  let sha: string;

  beforeAll(() => {
    repo = join(ROOT, "gitrepo");
    mkdirSync(repo, { recursive: true });
    const g = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    g("init", "-q", ".");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "test");
    writeFileSync(join(repo, "milo.json"), `{ "name": "gpkg", "version": "1.0.0", "lib": "lib.milo" }`);
    writeFileSync(join(repo, "lib.milo"), `pub fn fromGit(): string {\n  return "from git"\n}\n`);
    g("add", "-A");
    g("commit", "-qm", "init");
    g("tag", "v1.0.0");
    sha = (g("rev-parse", "HEAD").stdout ?? "").trim();
  });

  test("add at a tag pins the exact commit, not the tag", () => {
    const dir = project("gitapp");
    expect(milo(dir, "init").code).toBe(0);
    const r = milo(dir, "add", `git+file://${repo}@v1.0.0`);
    expect(r.code).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, "milo.lock"), "utf-8"));
    expect(lock.packages.gpkg.version).toBe("v1.0.0");
    expect(lock.packages.gpkg.commit).toBe(sha);
    // .git must not survive into the extracted tree, or the hash covers clone metadata
    const cached = join(ROOT, "cache", "milo", "giturl");
    const found = spawnSync("bash", ["-c", `find '${cached}' -maxdepth 3 -name .git | wc -l`], { encoding: "utf-8" });
    expect((found.stdout ?? "").trim()).toBe("0");
  });

  test("a modified cache entry fails the hash check on install --frozen", () => {
    const dir = project("gitapp2");
    expect(milo(dir, "init").code).toBe(0);
    expect(milo(dir, "add", `git+file://${repo}@v1.0.0`).code).toBe(0);
    expect(milo(dir, "install", "--frozen").code).toBe(0);

    const lock = JSON.parse(readFileSync(join(dir, "milo.lock"), "utf-8"));
    const cacheDir = spawnSync("bash", ["-c", `find '${join(ROOT, "cache", "milo", "giturl")}' -maxdepth 2 -name v1.0.0`], { encoding: "utf-8" });
    const target = (cacheDir.stdout ?? "").trim().split("\n")[0];
    expect(existsSync(target)).toBe(true);
    writeFileSync(join(target, "lib.milo"), `pub fn fromGit(): string {\n  return "poisoned"\n}\n`);

    const r = milo(dir, "install", "--frozen");
    expect(r.code).toBe(1);
    expect(r.err).toContain("hash mismatch");
    expect(r.err).toContain(lock.packages.gpkg.hash);
  });

  test("publish --dry-run validates but does not tag; a dirty tree is refused", () => {
    const pub = join(ROOT, "pubrepo");
    mkdirSync(pub, { recursive: true });
    const g = (...args: string[]) => spawnSync("git", args, { cwd: pub, encoding: "utf-8" });
    g("init", "-q", ".");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "test");
    writeFileSync(join(pub, "milo.json"), `{ "name": "pubpkg", "version": "0.3.0", "license": "MIT", "lib": "lib.milo" }`);
    writeFileSync(join(pub, "lib.milo"), `pub fn ok(): i64 {\n  return 1\n}\n`);
    g("add", "-A");
    g("commit", "-qm", "init");

    const clean = milo(pub, "publish", "--dry-run");
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("would tag v0.3.0");
    expect((g("tag", "--list").stdout ?? "").trim()).toBe("");

    writeFileSync(join(pub, "lib.milo"), `pub fn ok(): i64 {\n  return 2\n}\n`);
    const dirty = milo(pub, "publish", "--dry-run");
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain("working tree is dirty");
  }, 60000);

  test("update re-resolves a ref-less dep to the highest tag", () => {
    const dir = project("gitapp3");
    writeFileSync(
      join(dir, "milo.json"),
      JSON.stringify({ name: "gitapp3", version: "0.1.0", deps: { gpkg: `git+file://${repo}` } }, null, 2),
    );
    const r = milo(dir, "update");
    expect(r.code).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "milo.json"), "utf-8"));
    expect(m.deps.gpkg).toBe(`git+file://${repo}@v1.0.0`);
    const lock = JSON.parse(readFileSync(join(dir, "milo.lock"), "utf-8"));
    expect(lock.packages.gpkg.commit).toBe(sha);
  });
});

// SKIPPED — needs a real remote. `milo add github.com/...` over HTTPS, tarball
// download + #sha256= verification, and `milo publish`'s tag push are the only
// paths not covered above; the git transport is the only difference from the
// file:// tests, and it belongs to git.
test.skip("network: github/tarball fetch and publish --push", () => {});
