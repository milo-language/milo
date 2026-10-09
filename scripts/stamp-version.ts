// Stamps the current commit into src/version.ts so a released binary can report
// which commit built it. Run in CI immediately before `bun build --compile`;
// the edit is never committed.
//
// Written as a bun script rather than `sed -i` because the release matrix builds
// on both macOS and Linux runners, and their seds disagree about -i.

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { releaseVersion } from "./release-meta";

const path = new URL("../src/version.ts", import.meta.url).pathname;

const sha =
  process.env.GITHUB_SHA?.slice(0, 7) ??
  execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;

// The rolling `latest` build keeps the "dev" marker, the same string a source checkout
// reports. Without it a binary off main printed `milo 0.2.0 (sha)`, indistinguishable
// from the 0.2.0 release while carrying two months of breaking changes past it.
const build = tag ? sha : `dev ${sha}`;

const src = readFileSync(path, "utf8");
let stamped = src.replace(
  /^export const MILO_BUILD = "dev";$/m,
  `export const MILO_BUILD = ${JSON.stringify(build)};`
);

if (stamped === src) {
  console.error("stamp-version: MILO_BUILD line not found in src/version.ts");
  process.exit(1);
}

// On a tag build the tag is the version of record, so `milo --version` matches the
// release, the Homebrew formula, and the npm package. The checked-in MILO_VERSION is
// what a dev build reports and what the NEXT tag is expected to be; a mismatch means
// someone tagged without bumping it, which would ship two different version strings.
if (tag) {
  const version = releaseVersion(tag);
  const current = /^export const MILO_VERSION = "([^"]+)";$/m.exec(src)?.[1];
  if (current !== version) {
    console.error(
      `stamp-version: tag ${tag} is version ${version}, but src/version.ts says ${current}. ` +
        `Bump MILO_VERSION and re-tag.`
    );
    process.exit(1);
  }
}

writeFileSync(path, stamped);
console.log(`stamped MILO_BUILD = ${build}${tag ? ` (tag ${tag})` : ""}`);
