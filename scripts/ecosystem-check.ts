// Compile every published milo-language package against THIS checkout.
//
// Why this exists: a package's own CI pins a released `milo` binary, so it cannot
// tell you that the compiler you are about to ship breaks it. Nothing else in this
// repo compiles third-party code at all — the fixture suite and the examples are
// all first-party, and both take the local import path. Packages take the *package*
// path, which mangles names, and the two can disagree.
//
// Both failure modes have already happened:
//   * milo-postgres v0.1.0 — 32 green tests, did not compile for any consumer,
//     because a capitalised global was unresolvable under package mangling.
//   * milo-yaml v0.2.1 — the tag predated a fix already sitting on main.
//
// Neither was catchable by the package's own suite. This is.
//
//   bun scripts/ecosystem-check.ts            # all packages
//   bun scripts/ecosystem-check.ts --filter toml
//
// Network-dependent by nature: it resolves tags from GitHub. Run it on a schedule
// and before a release, not on every push.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

// One import and one call per package: enough to force the package path to
// resolve, mangle, type-check and codegen. A package that only *installs* proves
// nothing — the postgres failure was at compile time, after a clean install.
const PACKAGES: { repo: string; pkg: string; smoke: string }[] = [
  { repo: "milo-toml", pkg: "toml",
    smoke: `from "toml" import { Toml }\nfn main(): i32 {\n    let t = Toml.parse("a = 1\\n")!\n    print((t.i64("a") ?? 0).toString())\n    return 0\n}\n` },
  { repo: "milo-yaml", pkg: "yaml",
    smoke: `from "yaml" import { yamlParse, yamlToJson }\nfn main(): i32 {\n    let d = yamlParse("a: 1\\n")!\n    print(yamlToJson(d))\n    return 0\n}\n` },
  { repo: "milo-linkpreview", pkg: "linkpreview",
    smoke: `from "linkpreview" import { parseHtml }\nfn main(): i32 {\n    print(parseHtml("https://x.org/", "<title>hi</title>").title ?? "")\n    return 0\n}\n` },
  { repo: "milo-markdown", pkg: "markdown",
    smoke: `from "markdown" import { mdToHtml }\nfn main(): i32 {\n    print(mdToHtml("# hi"))\n    return 0\n}\n` },
  { repo: "milo-postgres", pkg: "postgres",
    smoke: `from "postgres" import { Conn }\nfn main(): i32 {\n    print("postgres linked")\n    return 0\n}\n` },
  { repo: "milo-redis", pkg: "redis",
    smoke: `from "redis" import { Conn }\nfn main(): i32 {\n    print("redis linked")\n    return 0\n}\n` },
  { repo: "milo-aws", pkg: "aws",
    smoke: `from "aws" import { Credentials }\nfn main(): i32 {\n    print("aws linked")\n    return 0\n}\n` },
  { repo: "milo-json-rpc", pkg: "json-rpc",
    smoke: `from "json-rpc" import { RpcMessage }\nfn main(): i32 {\n    print("json-rpc linked")\n    return 0\n}\n` },
  // The two binding packages link real system libraries, so the runner needs
  // libsdl2-dev and libgl1-mesa-dev. Neither smoke calls SDL_Init: this is a
  // compile-and-link check, and opening a window would need a display.
  { repo: "milo-sdl", pkg: "sdl",
    smoke: `from "sdl" import { SDL_Init, SDL_INIT_VIDEO }\nfn main(): i32 {\n    print("sdl linked")\n    return 0\n}\n` },
  { repo: "milo-gl", pkg: "gl",
    smoke: `from "gl" import { GlContext }\nfn main(): i32 {\n    print("gl linked")\n    return 0\n}\n` },
];

const filter = (() => {
  const i = process.argv.indexOf("--filter");
  return i === -1 ? "" : (process.argv[i + 1] ?? "");
})();

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf-8", env: process.env });
}

let failed = 0;
let ran = 0;
for (const p of PACKAGES) {
  if (filter && !p.repo.includes(filter)) continue;
  ran++;
  const dir = mkdtempSync(join(tmpdir(), `milo-eco-${p.pkg}-`));
  try {
    writeFileSync(join(dir, "milo.json"), `{ "name": "ecocheck", "version": "0.0.1" }\n`);
    const add = run("bun", ["run", MAIN, "pkg", "add", `github.com/milo-language/${p.repo}`], dir);
    if (add.status !== 0) {
      failed++;
      console.log(`FAIL ${p.repo}: install\n${(add.stderr || add.stdout).trim().split("\n").slice(0, 4).join("\n")}`);
      continue;
    }
    const version = (add.stdout.match(/@(v[\d.]+)/) ?? [, "untagged"])[1];
    writeFileSync(join(dir, "main.milo"), p.smoke);
    const built = run("bun", ["run", MAIN, "run", "main.milo"], dir);
    if (built.status !== 0) {
      failed++;
      console.log(`FAIL ${p.repo} ${version}: compile\n${(built.stderr || built.stdout).trim().split("\n").slice(0, 6).join("\n")}`);
    } else {
      console.log(`ok   ${p.repo} ${version} -> ${built.stdout.trim().split("\n")[0]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${ran - failed}/${ran} published packages compile against this checkout`);
process.exit(failed ? 1 : 0);
