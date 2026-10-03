// MILO_TIMING=1 per-phase wall-time breakdown of one compiler invocation, printed to stderr.
//
// main.ts imports this module FIRST so the timestamp below is taken before any other
// compiler module evaluates. Bun transpiles and links the whole import graph before it
// evaluates any of it, so `performance.now()` here covers Bun startup plus parsing every
// compiler module; the gap to main.ts's first statement is only module evaluation. Both
// are fixed per-process costs a daemon would remove, so they are reported as phases.
const loadedAt = performance.now();

export const timingEnabled = process.env.MILO_TIMING === "1";

interface Entry { name: string; ms: number; depth: number; note?: string }
const entries: Entry[] = [];
let depth = 0;
let reported = false;

export function phase<T>(name: string, fn: () => T): T {
  if (!timingEnabled) return fn();
  // Pushed before running so nested phases print under their parent, in call order.
  const e: Entry = { name, ms: 0, depth };
  entries.push(e);
  depth++;
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    e.ms = performance.now() - t0;
    depth--;
  }
}

// Attach a detail to the most recent phase with this name (e.g. "3/8 units compiled").
export function phaseNote(name: string, note: string): void {
  if (!timingEnabled) return;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.name === name) { entries[i]!.note = note; return; }
  }
}

// Called from main.ts's first statement, after every import has been evaluated.
export function markModulesLoaded(): void {
  if (!timingEnabled) return;
  entries.unshift(
    { name: "startup+module parse", ms: loadedAt, depth: 0 },
    { name: "module eval", ms: performance.now() - loadedAt, depth: 0 },
  );
}

export function timingReport(): void {
  if (!timingEnabled || reported) return;
  reported = true;
  // Total is wall time since process start, so time spent outside any phase (arg
  // parsing, temp file writes) shows up as the gap between the rows and the total.
  const total = performance.now();
  const width = Math.max(20, ...entries.map(e => e.name.length + e.depth * 2));
  const lines = ["milo timing (ms):"];
  for (const e of entries) {
    const label = ("  ".repeat(e.depth) + e.name).padEnd(width);
    const pct = ((e.ms / total) * 100).toFixed(1).padStart(5);
    lines.push(`  ${label} ${e.ms.toFixed(1).padStart(9)} ${pct}%${e.note ? "  " + e.note : ""}`);
  }
  lines.push(`  ${"total".padEnd(width)} ${total.toFixed(1).padStart(9)} 100.0%`);
  console.error(lines.join("\n"));
}
