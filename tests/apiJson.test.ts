// Gate on `milo api --json` and `milo check --json` — the two machine-readable surfaces
// that let tooling read the compiler without importing its TypeScript.
//
// The point is decoupling: docs generators, package tooling, editors and agents should
// consume a documented payload, not `import { ... } from "../src/api-search"`,
// which only code inside this repo can do — and which pins the whole tooling ecosystem to
// the compiler staying written in TypeScript.
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { API_JSON_SCHEMA, signatureParts, splitParams } from "../src/api-search";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

function milo(args: string[]): { out: string; code: number } {
  try {
    // maxBuffer: the full std dump is ~800 KB, over the default. It is also why
    // src/stdout.ts exists — process.exit() truncates an async pipe write, so this
    // command used to lose its tail and produce invalid JSON only when piped.
    return { out: execFileSync("bun", ["run", MAIN, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status ?? 1 };
  }
}

test("api --json describes a module: signatures, split params, struct fields", () => {
  const doc = JSON.parse(milo(["api", "--module", "std/json", "--json"]).out);
  expect(doc.schema).toBe(API_JSON_SCHEMA);
  expect(doc.entries.length).toBeGreaterThan(20);

  const get = doc.entries.find((e: any) => e.name === "Json.get");
  expect(get.kind).toBe("function");
  expect(get.module).toBe("std/json");
  expect(get.returns).toBe("Option<Json>");
  expect(get.params.map((p: any) => p.name)).toEqual(["self", "key"]);

  // Struct fields are in the payload, so a consumer never re-reads std/*.milo to answer
  // "does this type have that field" — the question docs/site/stdlib/json.md got wrong.
  const json = doc.entries.find((e: any) => e.kind === "type" && e.name === "Json");
  expect(json.fields.map((f: any) => f.name)).toContain("source");
  expect(json.fields.map((f: any) => f.name)).not.toContain("raw");

  // Enum variants too, with the comment above each one, so the site's generated reference
  // can list them without re-reading std/*.milo.
  const err = doc.entries.find((e: any) => e.kind === "type" && e.name === "JsonError");
  expect(err.variants.map((v: any) => v.name)).toEqual(["Syntax", "Missing", "Mismatch"]);
  expect(err.variants[0].payload).toBe("string");
  expect(err.variants[0].doc).toContain("not JSON");
  const val = doc.entries.find((e: any) => e.kind === "type" && e.name === "JsonVal");
  expect(val.variants.find((v: any) => v.name === "JNull").payload).toBeUndefined();
});

test("api --json carries an explicit enum discriminant as the variant's value", () => {
  const doc = JSON.parse(milo(["api", "--module", "std/ws", "--json"]).out);
  const op = doc.entries.find((e: any) => e.kind === "type" && e.name === "WsOpcode");
  expect(op.variants.find((v: any) => v.name === "Close")).toEqual({ name: "Close", value: "8" });
});

test("api --json with no query covers every module, including platform arms", () => {
  const doc = JSON.parse(milo(["api", "--json"]).out);
  const modules = new Set(doc.entries.map((e: any) => e.module));
  expect(modules.size).toBeGreaterThan(60);
  expect([...modules].some(m => (m as string).includes("platform"))).toBe(true);
});

test("param splitting survives commas inside generics and function types", () => {
  expect(splitParams("m: HashMap<string, i64>, f: (&Request, i64) => Response"))
    .toEqual(["m: HashMap<string, i64>", "f: (&Request, i64) => Response"]);
  // No return type means void — the same thing the checker infers.
  expect(signatureParts("fn f(a: i64)").returns).toBe("void");
});

test("check --json reports a rejection as data, and exits nonzero", () => {
  const bad = join(ROOT, "tests", "errors", "aliasMutContainerElement.milo");
  const res = milo(["check", bad, "--json"]);
  expect(res.code).toBe(1);
  const doc = JSON.parse(res.out);
  expect(doc.ok).toBe(false);
  expect(doc.diagnostics.length).toBeGreaterThan(0);
  const d = doc.diagnostics[0];
  expect(d.severity).toBe("error");
  expect(typeof d.message).toBe("string");
  expect(typeof d.line).toBe("number");
  expect(d.file).toContain("aliasMutContainerElement.milo");
});

test("check --json on a clean file says so, and exits zero", () => {
  const res = milo(["check", join(ROOT, "examples", "hello.milo"), "--json"]);
  expect(res.code).toBe(0);
  const doc = JSON.parse(res.out);
  expect(doc.ok).toBe(true);
  expect(doc.diagnostics.filter((d: any) => d.severity === "error")).toEqual([]);
});

test("prove --json reports each obligation's verdict as data", () => {
  const fixture = join(ROOT, "tests", "prove", "addNonneg.milo");
  const res = milo(["prove", fixture, "--json"]);
  const doc = JSON.parse(res.out);
  expect(doc.schema).toBe(1);
  expect(doc.obligations.length).toBeGreaterThan(0);
  for (const o of doc.obligations) {
    expect(["proven", "failed", "unknown", "error"]).toContain(o.status);
    expect(typeof o.fn).toBe("string");
  }
  // `unknown` is not `failed` — a gate that collapsed them would report an undecided
  // proof as a broken one, which is the distinction this payload exists to preserve.
  expect(doc.proven + doc.failed + doc.unknown + doc.errors).toBe(doc.obligations.length);
});

test("safety --json reports profile compliance as data", () => {
  const fixture = join(ROOT, "examples", "embedded", "flightController.milo");
  const doc = JSON.parse(milo(["safety", fixture, "--safety=do178", "--json"]).out);
  expect(doc.schema).toBe(1);
  expect(doc.level).toBe("do178c-b");
  expect(Array.isArray(doc.violations)).toBe(true);
  expect(doc.ok).toBe(!doc.violations.some((v: any) => v.severity === "error"));
});

test("test --json reports per-test records, and only the payload on stdout", () => {
  const res = milo(["test", join(ROOT, "tests", "milo-tests", "basics_test.milo"), "--json"]);
  // Nothing but the document: a ✓ line leaking into stdout makes the payload unparseable.
  const doc = JSON.parse(res.out);
  expect(doc.schema).toBe(1);
  expect(doc.tests.length).toBeGreaterThan(0);
  expect(doc.passed + doc.failed).toBe(doc.tests.length);
  for (const t of doc.tests) expect(typeof t.ms).toBe("number");
});
