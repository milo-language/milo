// Data-layer unit tests for the package manager (src/pkg.ts). No network: only
// the local-path fetch and pure parse/serialize/hash paths are exercised.
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseManifest,
  stringifyManifest,
  isPublishable,
  parseSource,
  parseLock,
  stringifyLock,
  sha256Tree,
  cachePathFor,
  fetchLocal,
  type Manifest,
  type Lockfile,
} from "../src/pkg";

const tmps: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "milo-pkg-test-"));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("parseManifest / stringifyManifest", () => {
  test("requires name and version", () => {
    expect(() => parseManifest(`{ "version": "1.0.0" }`)).toThrow(/name/);
    expect(() => parseManifest(`{ "name": "x" }`)).toThrow(/version/);
  });

  test("minimal app manifest (no lib/bin) parses and is not publishable", () => {
    const m = parseManifest(`{ "name": "app", "version": "0.1.0" }`);
    expect(m).toEqual({ name: "app", version: "0.1.0" });
    expect(isPublishable(m)).toBe(false);
  });

  test("accepts jsonc comments and trailing commas", () => {
    const m = parseManifest(`{
      // the package
      "name": "http2",
      "version": "1.2.0", /* semver */
    }`);
    expect(m.name).toBe("http2");
    expect(m.version).toBe("1.2.0");
  });

  test("round-trips a fully populated manifest", () => {
    const m: Manifest = {
      name: "http2",
      version: "1.2.0",
      description: "HTTP/2 client",
      license: "MIT",
      repository: "github.com/foo/milo-http2",
      milo: ">=0.4.0",
      lib: "lib.milo",
      bin: { http2: "src/cli.milo", "http2-bench": "src/bench.milo" },
      deps: { "json-ext": "github.com/bar/json-ext@v0.3.1" },
      devDeps: { bench: "github.com/baz/bench@v0.1.0" },
      targets: ["darwin", "linux", "windows"],
      exclude: ["tests/**", "examples/**"],
      nativeHints: { SDL2: { brew: "sdl2", apt: "libsdl2-dev" } },
    };
    expect(parseManifest(stringifyManifest(m))).toEqual(m);
    expect(isPublishable(m)).toBe(true);
    // stringify is stable (deterministic).
    expect(stringifyManifest(m)).toBe(stringifyManifest(m));
  });

  test("stringify is order-independent (deterministic key sort)", () => {
    const a: Manifest = { name: "p", version: "1.0.0", deps: { z: "github.com/o/z@v1", a: "github.com/o/a@v1" } };
    const b: Manifest = { name: "p", version: "1.0.0", deps: { a: "github.com/o/a@v1", z: "github.com/o/z@v1" } };
    expect(stringifyManifest(a)).toBe(stringifyManifest(b));
  });

  test("rejects wrong field types", () => {
    expect(() => parseManifest(`{ "name": "p", "version": "1", "deps": "nope" }`)).toThrow(/deps/);
    expect(() => parseManifest(`{ "name": "p", "version": "1", "targets": [1,2] }`)).toThrow(/targets/);
  });
});

describe("parseSource", () => {
  test("git host shorthand, no ref", () => {
    expect(parseSource("github.com/foo/bar")).toEqual({ kind: "git", host: "github.com", org: "foo", repo: "bar" });
  });

  test("git host shorthand with tag / sha / branch refs", () => {
    expect(parseSource("github.com/foo/bar@v1.2.0")).toEqual({
      kind: "git", host: "github.com", org: "foo", repo: "bar", ref: "v1.2.0",
    });
    expect(parseSource("gitlab.com/foo/bar@a1b2c3d")).toEqual({
      kind: "git", host: "gitlab.com", org: "foo", repo: "bar", ref: "a1b2c3d",
    });
    expect(parseSource("codeberg.org/foo/bar@main")).toEqual({
      kind: "git", host: "codeberg.org", org: "foo", repo: "bar", ref: "main",
    });
  });

  test("explicit git URL keeps the user@host '@' out of the ref", () => {
    expect(parseSource("git+ssh://git@internal/bar.git")).toEqual({
      kind: "giturl", url: "git+ssh://git@internal/bar.git",
    });
    expect(parseSource("git+ssh://git@internal/bar.git@v1.2.0")).toEqual({
      kind: "giturl", url: "git+ssh://git@internal/bar.git", ref: "v1.2.0",
    });
  });

  test("local paths", () => {
    expect(parseSource("./vendor/bar")).toEqual({ kind: "local", path: "./vendor/bar" });
    expect(parseSource("../shared")).toEqual({ kind: "local", path: "../shared" });
    expect(parseSource("/abs/path")).toEqual({ kind: "local", path: "/abs/path" });
  });

  test("tarball requires a valid sha256 fragment", () => {
    const hex = "a".repeat(64);
    expect(parseSource(`https://ex.com/bar-1.2.0.tar.gz#sha256=${hex}`)).toEqual({
      kind: "tarball", url: "https://ex.com/bar-1.2.0.tar.gz", sha256: hex,
    });
    expect(() => parseSource("https://ex.com/bar.tar.gz")).toThrow(/sha256/);
    expect(() => parseSource("https://ex.com/bar.tar.gz#sha256=short")).toThrow(/64 hex/);
  });

  test("rejects bare names and malformed shorthand", () => {
    expect(() => parseSource("http2")).toThrow();
    expect(() => parseSource("github.com/foo")).toThrow(/host\/org\/repo/);
    expect(() => parseSource("")).toThrow();
  });
});

describe("parseLock / stringifyLock", () => {
  const lock: Lockfile = {
    lockVersion: 1,
    packages: {
      "json-ext": { url: "github.com/bar/json-ext", version: "v0.3.1", commit: "deadbeef", hash: "sha256:00", deps: [] },
      http2: {
        url: "github.com/foo/milo-http2",
        version: "v1.2.0",
        commit: "a1b2c3d4e5f6",
        hash: "sha256:9f86d081",
        deps: ["json-ext"],
      },
    },
  };

  test("round-trips", () => {
    expect(parseLock(stringifyLock(lock))).toEqual(lock);
  });

  test("serialization sorts package names but preserves deps order", () => {
    const text = stringifyLock(lock);
    expect(text.indexOf(`"http2"`)).toBeLessThan(text.indexOf(`"json-ext"`));
    const rt = parseLock(text);
    expect(rt.packages.http2.deps).toEqual(["json-ext"]);
  });

  test("rejects an unsupported lockVersion", () => {
    expect(() => parseLock(`{ "lockVersion": 2, "packages": {} }`)).toThrow(/lockVersion/);
  });
});

describe("sha256Tree", () => {
  function buildTree(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  test("deterministic and prefixed", () => {
    const d = scratch();
    buildTree(d, { "a.milo": "one", "sub/b.milo": "two" });
    const h1 = sha256Tree(d);
    const h2 = sha256Tree(d);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("order-independent: same tree written in different order → same hash", () => {
    const d1 = scratch();
    const d2 = scratch();
    buildTree(d1, { "a.milo": "one", "m.milo": "mid", "z.milo": "end", "sub/b.milo": "two" });
    buildTree(d2, { "z.milo": "end", "sub/b.milo": "two", "a.milo": "one", "m.milo": "mid" });
    expect(sha256Tree(d1)).toBe(sha256Tree(d2));
  });

  test("changes when a file's contents change", () => {
    const d = scratch();
    buildTree(d, { "a.milo": "one" });
    const before = sha256Tree(d);
    writeFileSync(join(d, "a.milo"), "ONE");
    expect(sha256Tree(d)).not.toBe(before);
  });

  test("distinguishes path from content (no boundary ambiguity)", () => {
    const d1 = scratch();
    const d2 = scratch();
    buildTree(d1, { ab: "c" });
    buildTree(d2, { a: "bc" });
    expect(sha256Tree(d1)).not.toBe(sha256Tree(d2));
  });
});

describe("cachePathFor", () => {
  test("git layout matches resolver's host/org/repo/version", () => {
    const src = parseSource("github.com/foo/bar@v1.2.0");
    const p = cachePathFor(src, "v1.2.0");
    expect(p.endsWith(join("github.com", "foo", "bar", "v1.2.0"))).toBe(true);
  });

  test("local layout rewrites '/' to '_' under host 'local' (resolver convention)", () => {
    const src = parseSource("./vendor/bar");
    const p = cachePathFor(src, "main");
    expect(p.endsWith(join("local", "._vendor_bar", "main"))).toBe(true);
  });

  test("honors XDG_CACHE_HOME", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/xdgcache";
    try {
      const p = cachePathFor(parseSource("github.com/foo/bar"), "v1");
      expect(p).toBe(join("/tmp/xdgcache", "milo", "github.com", "foo", "bar", "v1"));
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe("fetchLocal", () => {
  test("copies a local package tree into destDir", () => {
    const srcDir = scratch();
    mkdirSync(join(srcDir, "src"), { recursive: true });
    writeFileSync(join(srcDir, "milo.json"), `{ "name": "bar", "version": "0.1.0", "lib": "lib.milo" }`);
    writeFileSync(join(srcDir, "lib.milo"), "pub fn hi() {}");
    writeFileSync(join(srcDir, "src", "extra.milo"), "fn helper() {}");

    const dest = join(scratch(), "extracted");
    fetchLocal({ kind: "local", path: srcDir }, dest);

    expect(readdirSync(dest).sort()).toEqual(["lib.milo", "milo.json", "src"]);
    expect(readFileSync(join(dest, "lib.milo"), "utf-8")).toBe("pub fn hi() {}");
    expect(readFileSync(join(dest, "src", "extra.milo"), "utf-8")).toBe("fn helper() {}");
    // a valid manifest survives the copy
    expect(parseManifest(readFileSync(join(dest, "milo.json"), "utf-8")).name).toBe("bar");
  });
});
