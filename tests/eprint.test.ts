// eprint writes its string parts to stderr by length and everything else through
// dprintf, and the two must interleave in argument order.
//
// String parts used to go through dprintf's `%.*s`. Its precision is a C int, so a
// string over 2 GiB printed nothing at all (the length wrapped negative and dprintf
// failed) and an embedded NUL cut the string short. The 2 GiB case is too big for the
// suite; it was checked by hand with a 2^31 + 10 byte string piped to `wc -c`. What
// this pins is the ordering and the NUL, which the by-length path changed.
import { test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");

test("eprint interleaves string and formatted parts in order, NULs included", () => {
  const dir = mkdtempSync(join(tmpdir(), "eprint-"));
  try {
    const file = join(dir, "e.milo");
    writeFileSync(file, `
struct P {
    x: i64,
}

fn show(s: &string): void {
    eprint("ref:", s)
}

fn main(): void {
    var nul: string = "a"
    nul.push(0)
    nul.push(98)
    eprint("n=", 42, " p=", P { x: 7 }, " s=", nul, "|")
    show("tail")
    eprint(1.5)
}
`);
    const r = spawnSync("bun", ["run", join(ROOT, "src", "main.ts"), "run", file], { cwd: ROOT });
    expect(r.status).toBe(0);
    const err = r.stderr.toString("latin1");
    expect(err).toBe("n=42 p=P { x: 7 } s=a\u0000b|\nref:tail\n1.5\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
