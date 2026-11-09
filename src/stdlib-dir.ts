// The directory holding std/ (the repo root in a checkout). Kept import-light: the resolver's hot path loads it.
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// MILO_ROOT overrides for contexts where import.meta.url doesn't map to the repo
// (e.g. a `bun build --compile` binary, whose module URLs point into the bundle).
export const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
