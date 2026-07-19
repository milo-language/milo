#!/usr/bin/env bun
// Generate a Milo host that can load a Node-API (.node) addon, and trace which
// napi_* entry points the addon actually calls.
//
// A .node addon is a plain dylib whose only entry point is napi_register_module_v1.
// It does not export a JS API — it BUILDS one by calling back into the host. So the
// host's job is to provide the napi_* symbols the addon leaves undefined, and the
// addon's undefined-symbol list is the exact contract to implement.
//
// This emits stubs that return napi_ok and print their own name, which answers two
// questions cheaply: does registration run to completion, and which subset of the
// API does this addon need. Signatures (arity) come from node's own headers rather
// than being hand-transcribed.
//
//   bun scripts/napi-probe.ts <addon.node> [--node-src ~/git/node/src] [--keep]
//
// Requires a Milo host linked with -Wl,-export_dynamic so the dlopen'd addon can
// resolve host symbols.

import { execSync, execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const addon = args.find(a => !a.startsWith("--"));
if (!addon || !existsSync(addon)) {
  console.error("usage: bun scripts/napi-probe.ts <addon.node> [--node-src DIR] [--keep]");
  process.exit(1);
}
const nodeSrcIdx = args.indexOf("--node-src");
const nodeSrc = nodeSrcIdx >= 0 ? args[nodeSrcIdx + 1] : join(homedir(), "git", "node", "src");

// The addon's undefined napi symbols ARE the contract.
const nm = execSync(`nm -u ${JSON.stringify(addon)}`, { encoding: "utf-8" });
const names = [...new Set(
  [...nm.matchAll(/_(n[a-z_0-9]*api[a-z_0-9]*)/g)].map(m => m[1])
)].filter(n => n !== "napi_register_module_v1").sort();

if (!names.length) {
  console.error("no napi symbols found — is this a Node-API addon?");
  process.exit(1);
}

// Arity from node's headers; hand-written signatures drift from the real ABI.
let hdr = "";
for (const h of ["js_native_api.h", "node_api.h"]) {
  const p = join(nodeSrc, h);
  if (existsSync(p)) hdr += readFileSync(p, "utf-8");
}
if (!hdr) {
  console.error(`no napi headers under ${nodeSrc} — pass --node-src`);
  process.exit(1);
}
hdr = hdr.replace(/\/\/.*/g, "");

function arityOf(name: string): { n: number; isVoid: boolean } {
  // napi_fatal_error and friends return void, not napi_status
  const re = new RegExp(`(napi_status|void)\\s+(NAPI_NO_RETURN\\s+)?NAPI_CDECL\\s+${name}\\s*\\(([^;]*?)\\)\\s*;`, "s");
  const alt = new RegExp(`(napi_status|NAPI_NO_RETURN void|void)\\s+NAPI_CDECL\\s*\\n?${name}\\s*\\(([^;]*?)\\)\\s*;`, "s");
  const m = hdr.match(re) ?? hdr.match(alt);
  if (!m) return { n: 4, isVoid: false }; // conservative default; stubs ignore args
  const params = m[m.length - 1].trim();
  const isVoid = m[1].includes("void");
  if (!params || params === "void") return { n: 0, isVoid };
  let depth = 0, count = 1;
  for (const ch of params) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return { n: count, isVoid };
}

const lines: string[] = [
  'from "std/io" import { writeStdout }',
  "",
  "extern fn dlopen(_path: *u8, _flags: i32): *u8",
  "extern fn dlsym(_handle: *u8, _sym: *u8): *u8",
  "extern fn malloc(_n: i64): *u8",
  "",
];
let unresolved = 0;
for (const n of names) {
  const { n: arity, isVoid } = arityOf(n);
  if (arity === 4 && !hdr.includes(n)) unresolved++;
  const ps = Array.from({ length: arity }, (_, i) => `_a${i}: *u8`).join(", ");
  lines.push(isVoid
    ? `fn ${n}(${ps}) {\n    writeStdout("  [napi] ${n}\\n")\n}`
    : `fn ${n}(${ps}): i32 {\n    writeStdout("  [napi] ${n}\\n")\n    return 0\n}`);
}
lines.push(
  "",
  "fn main() {",
  "    unsafe {",
  `        let h = dlopen(${JSON.stringify(addon)}, 2)`,
  '        if (h as i64) == 0 {',
  '            writeStdout("dlopen FAILED — host is missing symbols the addon needs\\n")',
  "            return",
  "        }",
  '        writeStdout("addon dlopened\\n")',
  '        let sym = dlsym(h, "napi_register_module_v1")',
  '        if (sym as i64) == 0 {',
  '            writeStdout("dlsym of napi_register_module_v1 FAILED\\n")',
  "            return",
  "        }",
  "        let reg = sym as extern (*u8, *u8) => *u8",
  "        // opaque env/exports: the addon only hands these back to our stubs",
  "        let envBuf = malloc(4096)",
  "        let expBuf = malloc(4096)",
  "        let r = reg(envBuf, expBuf)",
  '        writeStdout("register returned\\n")',
  "    }",
  "}",
);

const dir = mkdtempSync(join(tmpdir(), "napi-probe-"));
const src = join(dir, "napihost.milo");
const bin = join(dir, "napihost");
writeFileSync(src, lines.join("\n") + "\n");

console.log(`${names.length} napi symbols required by ${addon}`);
if (unresolved) console.log(`warning: ${unresolved} signature(s) not found in headers; used a 4-arg default`);

const COMPILER = join(import.meta.dir, "..", "src", "main.ts");
execFileSync("bun", ["run", COMPILER, "build", src, "-o", bin, "-Wl,-export_dynamic"], { stdio: "inherit" });
try {
  execFileSync(bin, { stdio: "inherit" });
} catch (e: any) {
  console.error(`addon registration crashed (exit ${e.status ?? "?"}) — stubs return napi_ok without producing real values, so the addon may dereference one`);
}
if (args.includes("--keep")) console.log(`\ngenerated host kept at ${src}`);
