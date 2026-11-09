// Fixtures that serve on a fixed port run in parallel with every other fixture, so a port must
// be unique across them and must sit outside the kernel's ephemeral range: Linux hands out
// 32768-60999 as source ports for outbound connections (macOS 49152-65535), and a client
// socket in another fixture holding the port makes the bind fail before the fixture prints.
// httpKeepAlive (47398) failed that way on linux x64 CI on 2026-11-09 with empty stdout.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dir, "fixtures");
const EPHEMERAL_FLOOR = 32768;
const PORT_DECL = /\bPORT\s*:\s*u16\s*=\s*(\d+)/g;
const PORT_ARG = /\b(?:serve[A-Za-z]*|listen[A-Za-z]*|bind)\(\s*"[^"]*"\s*,\s*(\d{2,5})\b/g;

function fixturePorts(): Map<number, string[]> {
  const byPort = new Map<number, string[]>();
  for (const f of readdirSync(DIR).filter(n => n.endsWith(".milo")).sort()) {
    const text = readFileSync(join(DIR, f), "utf8");
    const ports = new Set([...text.matchAll(PORT_DECL), ...text.matchAll(PORT_ARG)].map(m => Number(m[1])));
    for (const p of ports) byPort.set(p, [...(byPort.get(p) ?? []), f]);
  }
  return byPort;
}

test("fixture ports are unique and below the ephemeral range", () => {
  const byPort = fixturePorts();
  // Ten fixtures declare a port today; a scan that finds almost none has stopped matching.
  expect(byPort.size).toBeGreaterThanOrEqual(8);
  const shared = [...byPort].filter(([, fs]) => fs.length > 1).map(([p, fs]) => `${p}: ${fs.join(", ")}`);
  const ephemeral = [...byPort].filter(([p]) => p >= EPHEMERAL_FLOOR).map(([p, fs]) => `${p}: ${fs.join(", ")}`);
  expect(shared).toEqual([]);
  expect(ephemeral).toEqual([]);
});
