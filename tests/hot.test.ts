// Hot reload (src/hot.ts): build a `--hot` host, patch it through the fifo, and check the
// running process picks up the new body while its state survives. The pieces are driven
// directly (no file-watcher timing) except the one `milo hot` end-to-end case.
import { test, expect, describe, afterAll } from "bun:test";
import { spawnSync, execSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { emitPatch, compilePatch, sendPatch, awaitAck, initialHashes, patchLibName, hostTransform, type HotManifest, type PatchResult } from "../src/hot";
import { monitorPidTree, DEFAULT_MEM_MB } from "../scripts/guard";

const ROOT = resolve(import.meta.dir, "..");
const MAIN = join(ROOT, "src/main.ts");
const OS = process.platform === "darwin" ? "darwin" : "linux";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PROGRAM = `from "std/io" import { readLine }

var counter: i64 = 0

struct Point { x: i64, y: i64 }

fn compute(): i64 {
    return 100
}

fn label(): string {
    return "v"
}

fn tag(n: i64): string {
    return $"t{n}"
}

fn sum<T>(a: T, b: T): T { return a + b }

fn mk(a: i64): Point { return Point { x: a, y: a + 1 } }

fn main() {
    while true {
        match readLine() {
            Some(line) => {
                counter = counter + 1
                let p = mk(counter)
                print($"{label()}={counter + compute()} {sum(p.x, 10)} {tag(p.y)}")
            }
            None => { return }
        }
    }
}
`;

function milo(args: string[]): string {
  const r = spawnSync("bun", ["run", MAIN, ...args], { cwd: ROOT, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`milo ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

/** Line reader over a child's stdout/stderr stream. */
class Lines {
  private buf = "";
  private lines: string[] = [];
  private done = false;
  constructor(stream: ReadableStream<Uint8Array>) {
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        this.buf += dec.decode(chunk);
        let i: number;
        while ((i = this.buf.indexOf("\n")) !== -1) { this.lines.push(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); }
      }
      this.done = true;
    })();
  }
  async next(timeoutMs = 10000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (this.done || Date.now() > deadline) throw new Error(`no line (done=${this.done}, partial=${JSON.stringify(this.buf)})`);
      await Bun.sleep(5);
    }
    return this.lines.shift()!;
  }
  /** Skip lines until one matches; returns it. */
  async until(re: RegExp, timeoutMs = 20000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = await this.next(Math.max(1, deadline - Date.now()));
      if (re.test(line)) return line;
    }
  }
}

class Host {
  dir = mkdtempSync(join(tmpdir(), "milo_hottest_"));
  src = join(this.dir, "prog.milo");
  bin = join(this.dir, "host");
  fifo = join(this.dir, "cmd");
  ack = join(this.dir, "ack");
  manifest!: HotManifest;
  current: Record<string, string> = {};
  n = 0;
  proc!: ReturnType<typeof Bun.spawn>;
  out!: Lines;
  stopGuard = () => {};

  constructor() { dirs.push(this.dir); }

  start(source: string) {
    writeFileSync(this.src, source);
    milo(["build", "--hot", this.src, "-o", this.bin]);
    this.manifest = JSON.parse(readFileSync(`${this.bin}.hot.json`, "utf-8"));
    this.current = initialHashes(this.manifest);
    execSync(`mkfifo ${this.fifo}`);
    writeFileSync(this.ack, "");
    this.proc = Bun.spawn([this.bin], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: { ...process.env, MILO_HOT_FIFO: this.fifo, MILO_HOT_ACK: this.ack, MILO_LINE_BUFFERED: "1" },
    });
    this.stopGuard = monitorPidTree(this.proc.pid, DEFAULT_MEM_MB, () => {});
    this.out = new Lines(this.proc.stdout as ReadableStream<Uint8Array>);
  }

  async send(): Promise<string> {
    (this.proc.stdin as any).write("x\n");
    (this.proc.stdin as any).flush();
    return this.out.next();
  }

  /** Rebuild the edited source the way `milo hot` does and, when it is a patch, apply it. */
  async edit(source: string): Promise<PatchResult> {
    writeFileSync(this.src, source);
    // --debug: the same -O0 codegen settings `build --hot` used for the host.
    const ir = milo(["emit-ir", "--debug", this.src]);
    const r = emitPatch(this.manifest, this.current, ir, this.n + 1);
    if (r.kind !== "patch") return r;
    this.n++;
    const lib = patchLibName(this.dir, this.n, OS);
    compilePatch("clang", r.ir, lib, OS);
    sendPatch(this.fifo, lib, this.n, r.exported);
    const a = await awaitAck(this.ack, this.n);
    if (!a.ok) throw new Error(`apply failed: ${a.msg}`);
    Object.assign(this.current, r.hashes);
    return r;
  }

  stop() { this.stopGuard(); this.proc.kill(9); }
}

describe.skipIf(process.platform === "win32")("hot reload", () => {
  test("body edit swaps compute and keeps the global counter", async () => {
    const h = new Host();
    h.start(PROGRAM);
    try {
      expect(await h.send()).toBe("v=101 11 t2");
      expect(await h.send()).toBe("v=102 12 t3");
      const r = await h.edit(PROGRAM.replace("return 100", "return 200"));
      expect(r.kind).toBe("patch");
      if (r.kind === "patch") expect(r.changed).toEqual(["compute"]);
      // counter is 3 now: state survived, the new body ran.
      expect(await h.send()).toBe("v=203 13 t4");

      // A string literal edit: the patch carries its own copy of the constant.
      const r2 = await h.edit(PROGRAM.replace("return 100", "return 200").replace(`return "v"`, `return "w"`));
      if (r2.kind === "patch") expect(r2.changed).toEqual(["label"]);
      expect(await h.send()).toBe("w=204 14 t5");

      // A monomorphized generic and a fn that calls into std (interpolation).
      const p3 = PROGRAM.replace("return 100", "return 200").replace(`return "v"`, `return "w"`)
        .replace("return a + b }", "return a + b + b }").replace(`$"t{n}"`, `$"T{n * 2}"`);
      const r3 = await h.edit(p3);
      expect(r3.kind).toBe("patch");
      if (r3.kind === "patch") expect(r3.changed.sort()).toEqual(["sum_i64", "tag"]);
      expect(await h.send()).toBe("w=205 25 T12");

      // Reverting to an earlier body is a patch too (hashes track what is applied).
      const r4 = await h.edit(PROGRAM);
      expect(r4.kind).toBe("patch");
      expect(await h.send()).toBe("v=106 16 t7");
      expect((await h.edit(PROGRAM)).kind).toBe("none");
    } finally { h.stop(); }
  }, 60000);

  test("a struct layout change is refused", async () => {
    const h = new Host();
    h.start(PROGRAM);
    try {
      expect(await h.send()).toBe("v=101 11 t2");
      const r = await h.edit(PROGRAM.replace("struct Point { x: i64, y: i64 }", "struct Point { x: i64, y: i64, z: i64 }")
        .replace("Point { x: a, y: a + 1 }", "Point { x: a, y: a + 1, z: 0 }"));
      expect(r).toEqual({ kind: "refuse", reason: "type %Point changed layout" });
    } finally { h.stop(); }
  }, 60000);

  test("a signature change is refused", async () => {
    const h = new Host();
    h.start(PROGRAM);
    try {
      const r = await h.edit(PROGRAM.replace("fn compute(): i64 {\n    return 100", "fn compute(k: i64): i64 {\n    return 100 + k")
        .replace("compute()}", "compute(1)}"));
      expect(r).toEqual({ kind: "refuse", reason: "signature of compute changed" });
    } finally { h.stop(); }
  }, 60000);

  test("a new global and a new function are refused", () => {
    const ir = (s: string) => {
      const d = mkdtempSync(join(tmpdir(), "milo_hotir_"));
      dirs.push(d);
      writeFileSync(join(d, "p.milo"), s);
      return milo(["emit-ir", "--debug", join(d, "p.milo")]);
    };
    const host = hostTransform(ir(PROGRAM));
    if ("error" in host) throw new Error(host.error);
    const cur = initialHashes(host.manifest);
    expect(emitPatch(host.manifest, cur, ir(PROGRAM.replace("var counter: i64 = 0", "var counter: i64 = 0\nvar other: i64 = 0")), 1))
      .toEqual({ kind: "refuse", reason: "global other added" });
    expect(emitPatch(host.manifest, cur, ir(PROGRAM.replace("fn mk(", "fn extra(): i64 { return 1 }\n\nfn mk(").replace("return 100", "return extra()")), 1))
      .toEqual({ kind: "refuse", reason: "function extra added" });
  }, 60000);

  test("milo hot patches a real file edit and restarts on a layout change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "milo_hotcli_"));
    dirs.push(dir);
    const src = join(dir, "prog.milo");
    writeFileSync(src, PROGRAM);
    const proc = Bun.spawn(["bun", "run", MAIN, "hot", src], {
      cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, MILO_LINE_BUFFERED: "1" },
    });
    const out = new Lines(proc.stdout as ReadableStream<Uint8Array>);
    const err = new Lines(proc.stderr as ReadableStream<Uint8Array>);
    const send = async () => { (proc.stdin as any).write("x\n"); (proc.stdin as any).flush(); return out.next(20000); };
    try {
      expect(await send()).toBe("v=101 11 t2");
      writeFileSync(src, PROGRAM.replace("return 100", "return 300"));
      expect(await err.until(/^hot: (patched|restart)/)).toMatch(/^hot: patched compute in \d+ms$/);
      expect(await send()).toBe("v=302 12 t3");
      writeFileSync(src, PROGRAM.replace("struct Point { x: i64, y: i64 }", "struct Point { x: i64, y: i64, z: i64 }")
        .replace("Point { x: a, y: a + 1 }", "Point { x: a, y: a + 1, z: 0 }"));
      expect(await err.until(/^hot: (patched|restart)/)).toBe("hot: restart (type %Point changed layout)");
      // A fresh process: the counter starts over.
      expect(await send()).toBe("v=101 11 t2");
    } finally {
      proc.kill("SIGINT");
      await proc.exited;
    }
  }, 90000);
});
