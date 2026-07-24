// Per-package name mangling (docs/plans/package-manager.md §P0).
//
// The property under test: a dependency and the consumer may define the same
// top-level names, and every call still reaches the body it was written against.
// Before mangling this exact program was a hard `duplicate-fn` error in code the
// consumer did not write.
//
// No network: the dependency is a local-path dep, staged into a throwaway cache
// under a temp HOME (the resolver reads ~/.milo/cache/<host>/<path>/<version>/,
// and local-path deps map to host "local" with '/' rewritten to '_' — the same
// layout `milo install` writes).
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, mkdirSync, cpSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
const FIXTURE = resolve(import.meta.dir, "pkgfixtures", "colliding");

const HOME = mkdtempSync(join(tmpdir(), "milo-mangle-home-"));
const PROJECT = mkdtempSync(join(tmpdir(), "milo-mangle-proj-"));

// Stage the local-path dep exactly where resolvePath will look for it.
const cacheDir = join(HOME, ".milo", "cache", "local", FIXTURE.replace(/\//g, "_"), "main");
mkdirSync(cacheDir, { recursive: true });
cpSync(FIXTURE, cacheDir, { recursive: true });

writeFileSync(join(PROJECT, "milo.json"), JSON.stringify({
  name: "consumer",
  version: "0.1.0",
  deps: { colliding: FIXTURE },
}, null, 2));

function milo(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", ["run", COMPILER, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME },
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function write(name: string, content: string): string {
  const p = join(PROJECT, name);
  writeFileSync(p, content);
  return p;
}

// Consumer redefines every name the package exports, plus the package's own
// cross-file helper, all with different bodies.
const CONSUMER = `from "colliding" import { parse as pkgParse, describe as pkgDescribe, Doc as PkgDoc, makeLine, area }

pub struct Doc {
    text: string,
}

pub fn helper(s: string): string {
    return format("<", s, ">")
}

pub fn parse(s: string): Doc {
    return Doc { text: format("consumer:", helper(s)) }
}

pub fn describe(d: &Doc): string {
    return d.text
}

fn main(): void {
    let mine = parse("x")
    let theirs: PkgDoc = pkgParse("x")
    print(describe(mine))
    print(pkgDescribe(theirs))
    print(helper("y"))
    print(area(makeLine(41)) + 1)
}
`;

test("a dependency and the consumer may define the same names; each call reaches its own body", () => {
  const main = write("main.milo", CONSUMER);
  const r = milo(["run", main]);
  // No diagnostics. Not `toBe("")` — stderr legitimately carries progress lines
  // (dependency install), and asserting it is empty couples this test to unrelated
  // CLI chatter.
  expect(r.err).not.toContain("error");
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual([
    "consumer:<x>",     // consumer's parse called the consumer's helper
    "colliding:[x]",    // the package's parse called the package's own helper
    "<y>",              // the consumer's helper is still its own
    "42",               // enum literal + match pattern survive the type rewrite
  ]);
});

test("import { x as y } binds the alias to the package's symbol", () => {
  // No unaliased import of `parse` anywhere: the local name is only ever `pkgParse`.
  const main = write("alias.milo", `from "colliding" import { parse as pkgParse, describe as pkgDescribe }

fn main(): void {
    print(pkgDescribe(pkgParse("aliased")))
}
`);
  const r = milo(["run", main]);
  // No diagnostics. Not `toBe("")` — stderr legitimately carries progress lines
  // (dependency install), and asserting it is empty couples this test to unrelated
  // CLI chatter.
  expect(r.err).not.toContain("error");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("colliding:[aliased]");
});

test("only the dependency's symbols carry the package prefix", () => {
  const main = write("ir.milo", CONSUMER);
  const r = milo(["emit-ir", main]);
  expect(r.code).toBe(0);
  // package decls are prefixed...
  expect(r.out).toContain("colliding$parse");
  expect(r.out).toContain("colliding$helper");
  // ...consumer and std decls are not
  expect(r.out).toMatch(/@parse\b/);
  expect(r.out).not.toContain("colliding$main");
  expect(r.out).not.toContain("consumer$");
  expect(r.out).not.toContain("$strLen");
});

test("a package with no deps is untouched — mangling is inert without a manifest dep", () => {
  const main = write("plain.milo", `pub fn parse(s: string): string { return format("plain:", s) }

fn main(): void { print(parse("z")) }
`);
  const r = milo(["run", main]);
  // No diagnostics. Not `toBe("")` — stderr legitimately carries progress lines
  // (dependency install), and asserting it is empty couples this test to unrelated
  // CLI chatter.
  expect(r.err).not.toContain("error");
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("plain:z");
});
