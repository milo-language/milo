// The directory holding std/ (the repo root in a checkout). Kept import-light: the resolver's hot path loads it.
import { resolve, dirname } from "path";

// MILO_ROOT overrides for contexts where import.meta.url doesn't map to the repo
// (e.g. a `bun build --compile` binary, whose module URLs point into the bundle).
// No "url" import: the playground bundles this file for the browser, and the browser
// polyfill of node:url has no fileURLToPath. The pathname is percent-encoded, hence the decode.
export const STDLIB_DIR = process.env.MILO_ROOT ?? resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..");
