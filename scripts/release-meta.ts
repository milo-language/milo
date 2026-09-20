// Shared facts about a release: the target list and how a git tag maps to a version
// string. Every packaging script (npm, nfpm, Homebrew) derives its names from here so
// a new target is added in one place instead of four.

export type Target = {
  /** Release-artifact name: `milo-<target>.tar.gz`. */
  target: string;
  /** npm `os` field. */
  os: "darwin" | "linux";
  /** npm `cpu` field. */
  cpu: "arm64" | "x64";
  /** Debian/RPM architecture, for the Linux targets only. */
  debArch?: "amd64" | "arm64";
};

export const TARGETS: Target[] = [
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "linux-x64", os: "linux", cpu: "x64", debArch: "amd64" },
  { target: "linux-arm64", os: "linux", cpu: "arm64", debArch: "arm64" },
];

export const REPO = "milo-language/milo";

/** `v0.1.0` -> `0.1.0`. Rejects anything else so a stray tag can't publish a package. */
export function releaseVersion(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`not a release tag: ${tag} (expected vMAJOR.MINOR.PATCH)`);
  return m[1]!;
}

export function tarballUrl(version: string, target: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/milo-${target}.tar.gz`;
}
