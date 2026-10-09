// `milo upgrade`: replace the running compiler binary with a newer release.
//
// Mirrors install.sh (same release assets, same "newest vX.Y.Z by default, `latest` is
// the rolling build of main" policy) but runs from the installed binary, so a user never
// has to find the curl line again. Installs owned by a package manager are left to it:
// overwriting a Homebrew or dpkg file desyncs the manager's own record of what it shipped.

import { createHash } from "crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { spawnSync } from "child_process";
import { MILO_VERSION, MILO_BUILD } from "./version";

const REPO = "milo-language/milo";

const USAGE = `usage: milo upgrade [--check] [--nightly | --tag <vX.Y.Z>]
  --check     report the newest release, change nothing
  --nightly   install the rolling build of main (tag 'latest')
  --tag <t>   install a specific release, e.g. v0.2.0`;

function hostAsset(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && arch ? `milo-${os}-${arch}` : null;
}

// The release list, not GitHub's "latest release" pointer: see install.sh.
async function newestVersionTag(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`could not list releases: HTTP ${res.status}`);
  const releases = (await res.json()) as { tag_name: string; draft: boolean }[];
  const tag = releases.find(r => !r.draft && /^v\d/.test(r.tag_name))?.tag_name;
  if (!tag) throw new Error("no versioned release found");
  return tag;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Who owns this file? Returns the command that should upgrade it instead, if not us.
function managedBy(exe: string): string | null {
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(exe)) return "brew upgrade milo";
  if (exe.startsWith("/usr/bin/") || exe.startsWith("/usr/lib/")) {
    return "your system package manager (apt/dnf), or reinstall with install.sh";
  }
  return null;
}

export async function runUpgrade(args: string[]): Promise<number> {
  let check = false;
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") check = true;
    else if (a === "--nightly") tag = "latest";
    else if (a === "--tag" && args[i + 1]) tag = args[++i];
    else if (a.startsWith("--tag=")) tag = a.slice(6);
    else if (a === "-h" || a === "--help") { console.log(USAGE); return 0; }
    else { console.error(`error: unexpected argument '${a}'\n${USAGE}`); return 1; }
  }

  // Under `bun run src/main.ts` execPath is bun itself; replacing that would be a disaster.
  const exe = realpathSync(process.execPath);
  if (/^bun(\.exe)?$/.test(basename(exe))) {
    console.error("milo is running from a source checkout; upgrade it with `git pull`.");
    return 1;
  }
  const asset = hostAsset();
  if (!asset) {
    console.error(`no prebuilt milo for ${process.platform}-${process.arch}; build from source.`);
    return 1;
  }

  const current = `v${MILO_VERSION}`;
  const currentIsRelease = !MILO_BUILD.startsWith("dev");
  try {
    const target = tag ?? await newestVersionTag();
    const upToDate = target !== "latest" && target === current && currentIsRelease;
    console.log(`installed: milo ${MILO_VERSION} (${MILO_BUILD})`);
    console.log(`available: ${target}`);
    if (check) return 0;
    if (upToDate) { console.log("already up to date."); return 0; }

    const owner = managedBy(exe);
    if (owner) {
      console.error(`this milo was installed by a package manager (${exe}); upgrade with ${owner}.`);
      return 1;
    }

    const base = `https://github.com/${REPO}/releases/download/${target}`;
    const [tarball, sums] = await Promise.all([
      download(`${base}/${asset}.tar.gz`),
      download(`${base}/SHA256SUMS`).then(b => new TextDecoder().decode(b)),
    ]);
    const want = sums.split("\n").find(l => l.trim().endsWith(`${asset}.tar.gz`))?.split(/\s+/)[0];
    const got = createHash("sha256").update(tarball).digest("hex");
    if (!want) throw new Error(`SHA256SUMS has no entry for ${asset}.tar.gz`);
    if (want !== got) throw new Error(`checksum mismatch for ${asset}.tar.gz: expected ${want}, got ${got}`);

    const tmp = mkdtempSync(join(tmpdir(), "milo-upgrade-"));
    try {
      const archive = join(tmp, "milo.tar.gz");
      await Bun.write(archive, tarball);
      const tar = spawnSync("tar", ["xzf", archive, "-C", tmp], { stdio: "inherit" });
      if (tar.status !== 0) throw new Error("could not extract the archive");
      // Archives before 2026-07-30 are flat; newer ones nest under milo-<target>/.
      const bin = [join(tmp, asset, "milo"), join(tmp, "milo")].find(existsSync);
      if (!bin) throw new Error("archive did not contain a milo binary");
      chmodSync(bin, 0o755);
      const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
      if (probe.status !== 0) throw new Error(`the downloaded binary does not run: ${probe.stderr.trim()}`);

      // Stage beside the target and rename: same filesystem, so the swap is atomic and a
      // failed copy never leaves a half-written compiler on PATH.
      const staged = join(dirname(exe), `.milo-upgrade-${process.pid}`);
      try {
        copyFileSync(bin, staged);
        chmodSync(staged, 0o755);
        renameSync(staged, exe);
      } catch (e) {
        rmSync(staged, { force: true });
        if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM") {
          throw new Error(`no permission to replace ${exe}; rerun with sudo or reinstall to a user directory`);
        }
        throw e;
      }
      console.log(`upgraded ${exe} to ${probe.stdout.trim()}`);
      return 0;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
