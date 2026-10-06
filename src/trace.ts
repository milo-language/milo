// `milo trace <file>`: list the records of a record/replay trace (std/replay,
// docs/record-replay.md) so a person or a UI can see a recorded run as a timeline of
// calls. Streams the file: payloads are skipped, not loaded, so a trace holding large
// file or socket reads lists in constant memory.
import { closeSync, openSync, readSync, writeSync } from "fs";

export interface TraceRecord {
  seq: number;
  kind: string;
  arg: string;
  payloadLen: number;
  /** Byte offset of the record's header line in the file. */
  offset: number;
}

const HEADER = "milo-trace 1\n";

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/** Every record's header and arg, in order. Throws on a foreign or corrupt trace. */
export function* traceRecords(path: string): Generator<TraceRecord> {
  const fd = openSync(path, "r");
  try {
    if (readAt(fd, 0, HEADER.length).toString("latin1") !== HEADER) {
      throw new Error(`${path} is not a milo-trace version 1 file`);
    }
    let pos = HEADER.length;
    for (let seq = 1; ; seq++) {
      let chunk = readAt(fd, pos, 4096);
      if (chunk.length === 0) return;
      const nl = chunk.indexOf(10);
      if (nl < 0) throw new Error(`trace corrupt at record ${seq}`);
      const fields = chunk.subarray(0, nl).toString("latin1").split(" ");
      if (fields.length !== 4 || Number(fields[0]) !== seq) throw new Error(`trace corrupt at record ${seq}`);
      const argLen = Number(fields[2]);
      const payloadLen = Number(fields[3]);
      if (nl + 1 + argLen + 1 > chunk.length) chunk = readAt(fd, pos, nl + 1 + argLen + 1);
      const arg = chunk.subarray(nl + 1, nl + 1 + argLen).toString("latin1");
      const end = pos + nl + 1 + argLen + 1 + payloadLen + 1;
      const tail = readAt(fd, end - 1, 1);
      if (tail.length !== 1 || tail[0] !== 10) throw new Error(`trace corrupt at record ${seq}`);
      yield { seq, kind: fields[1], arg, payloadLen, offset: pos };
      pos = end;
    }
  } finally {
    closeSync(fd);
  }
}

/** One record's payload bytes. */
function payloadOf(path: string, rec: TraceRecord): Buffer {
  const fd = openSync(path, "r");
  try {
    const head = readAt(fd, rec.offset, 4096);
    const start = rec.offset + head.indexOf(10) + 1 + Buffer.byteLength(rec.arg, "latin1") + 1;
    return readAt(fd, start, rec.payloadLen);
  } finally {
    closeSync(fd);
  }
}

function shortArg(arg: string): string {
  const shown = arg.length > 60 ? arg.slice(0, 60) + "..." : arg;
  return shown.replace(/[^\x20-\x7e]/g, ".");
}

const USAGE = "usage: milo trace <file> [--json] [--kind <prefix>] [--payload <seq>]";

export function runTrace(args: string[]): number {
  let file: string | null = null;
  let json = false;
  let kindPrefix = "";
  let payloadSeq = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--kind" && i + 1 < args.length) kindPrefix = args[++i];
    else if (a === "--payload" && i + 1 < args.length) payloadSeq = Number(args[++i]);
    else if (!a.startsWith("-") && file === null) file = a;
    else { console.error(USAGE); return 2; }
  }
  if (file === null) { console.error(USAGE); return 2; }
  try {
    if (payloadSeq > 0) {
      for (const rec of traceRecords(file)) {
        if (rec.seq === payloadSeq) {
          writeSync(1, payloadOf(file, rec));
          return 0;
        }
      }
      console.error(`trace has no record ${payloadSeq}`);
      return 1;
    }
    const records: TraceRecord[] = [];
    let total = 0;
    for (const rec of traceRecords(file)) {
      total++;
      if (!rec.kind.startsWith(kindPrefix)) continue;
      if (json) records.push(rec);
      else console.log(`${String(rec.seq).padStart(6)}  ${rec.kind.padEnd(14)} ${shortArg(rec.arg).padEnd(24)} ${rec.payloadLen} bytes`);
    }
    if (json) console.log(JSON.stringify({ version: 1, total, records }));
    return 0;
  } catch (e) {
    console.error(`milo trace: ${(e as Error).message}`);
    return 1;
  }
}
