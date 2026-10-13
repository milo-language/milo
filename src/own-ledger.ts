// Ownership ledger verifier: checks codegen's drop bookkeeping against itself on the textual IR (MILO_OWN_LEDGER=1).
//
// Codegen, in ledger mode, brackets every owned value's life in a frame with markers:
//   call void @__milo_own_make(i64 ID)            ; the value is now this frame's to dispose of
//   call void @__milo_own_end(i64 ID, i32 KIND)   ; it no longer is (dropped, moved, returned, ...)
//   call void @__milo_own_guard(i64 ID, i1 %c)    ; %c is ID's alive flag; the next `br i1 %c` tests it
//   call void @__milo_own_view(i64 VID, i64 SRC)  ; SRC's bytes (0: owned outside this frame) were
//                                                 ; copied without a move: VID borrows, never owns
//   call void @__milo_own_part(i64 PID, i64 FID)  ; a field FID was moved out of PID's value
// This pass builds each function's CFG and runs a forward may-dataflow over each ID's state
// {unmade, live, ended}. It reports an end reachable while the ID may already be ended
// (double end) or never made, an ID that may be live at a `ret` (leak), and an ID made inside
// a loop that may still be live on the loop's back-edge (one leak per iteration). Blocks that
// end in `unreachable` (panics) are exempt. The markers never reach clang: stripOwnLedger
// removes them, so a ledger build compiles and runs exactly like a normal one.
//
// The guard is what lets a static pass agree with codegen's run-time alive flags: on the
// flag's true edge the ID can only be live, on its false edge it cannot be. Without it every
// guarded scope-exit drop would merge "moved on some path" with "live on another" and look
// like a leak.
//
// Copy intent. Codegen declares every copy of an owned type's bytes as a MOVE (the source's
// ID ends with a transfer kind and the destination is made), a CLONE (a fresh make) or a
// VIEW (a view marker; nobody owns the copy). The double-owner shape, two places that each
// free the same bytes, then surfaces as one of:
//   drop-of-view    a view is dropped: it frees bytes its source still owns (double free)
//   own-of-view     a view is handed to an owner (armed in a droppable slot, stored, returned,
//                   passed by value): the new owner frees bytes the source still owns
//   end-after-move  an ID already transferred away (MOVE/STORE/RETURN/ARG/CAPTURE) is ended
//                   again: the new owner and this frame both dispose of it
//   use-after-move  a view is taken of a source that may already have been transferred away
//   use-after-drop  a view is taken of a source that may already have been dropped
//
// Parts. A field moved out of a local (`take(e.value)`) leaves the rest of the local behind,
// still the local's to drop. Each such field is a part ID of the local's ID: made with it,
// ended by the part marker (the move), and ended again by a whole-value end of the parent,
// which drops every field. So a parent ended whole while a part may already have left is
//   part-double-drop  the parent's drop visits a field that was moved out (its zeroed
//                     leftover is dropped: a user Drop runs twice)
// The end kind DROPF is the parent's field-by-field drop, which drops each moved field only
// on its own flag's live edge (guarded, ending the part with DROP), so it ends no part;
// DROPZF is the same drop where DROPZ would be used (an assignment's overwrite).

export const OWN_END_KINDS = ["DROP", "MOVE", "RETURN", "ARG", "STORE", "CAPTURE", "DROPZ", "DROPF", "DROPZF"] as const;
export type OwnEndKind = typeof OWN_END_KINDS[number];

export type OwnFindingKind = "double-end" | "end-unmade" | "leak-ret" | "leak-iter" | "remake-live" |
  "drop-of-view" | "own-of-view" | "end-after-move" | "use-after-move" | "use-after-drop" | "part-double-drop";

export interface OwnFinding {
  fn: string;
  id: number;
  kind: OwnFindingKind;
  irLine: number;      // 1-based line of the ID's first make (or the offending end when never made)
  origin: string;      // codegen site that made the ID
  srcLine: number;     // Milo source line of the make, 0 when unknown
  at: number;          // 1-based IR line where the finding was observed
}

// unmade, live, dropped, transferred away (moved, stored, returned, passed), a view.
const U = 1, L = 2, E = 4, M = 8, V = 16;

interface Ev { op: "make" | "end" | "view" | "part"; id: number; tolerant: boolean; transfer: boolean; src: number; line: number; fieldwise?: boolean }
interface Block {
  name: string;
  events: Ev[];
  guards: { id: number; cond: string }[];
  succs: string[];
  brCond: string | null;     // `br i1 %c, label %T, label %F`: c, with succs [T, F]
  term: "br" | "switch" | "ret" | "unreachable" | "fall";
  termLine: number;
}

const MAKE_RE = /call void @__milo_own_make\(i64 (\d+)\)(?:\s*;\s*own (\S+) L(\d+))?/;
const END_RE = /call void @__milo_own_end\(i64 (\d+), i32 (\d+)\)/;
const GUARD_RE = /call void @__milo_own_guard\(i64 (\d+), i1 (%[^)\s]+)\)/;
const VIEW_RE = /call void @__milo_own_view\(i64 (\d+), i64 (\d+)\)(?:\s*;\s*own (\S+) L(\d+))?/;
const PART_RE = /call void @__milo_own_part\(i64 (\d+), i64 (\d+)\)/;
const LABEL_RE = /^([A-Za-z0-9_.$-]+):/;

// Drop every marker line. Returns the same array when there is nothing to strip.
export function stripOwnLedger(lines: string[]): string[] {
  return lines.filter(l => !l.includes("@__milo_own_"));
}

export function verifyOwnLedger(lines: string[]): OwnFinding[] {
  const findings: OwnFinding[] = [];
  // A call to a `noreturn` function ends its path as surely as `unreachable` does, but
  // codegen often follows `exit(0)` with a `br` anyway (the block needs a terminator).
  // Without this, that dead edge would carry a moved value back around a loop.
  const noreturn = new Set<string>();
  for (const l of lines) {
    if ((l.startsWith("declare ") || l.startsWith("define ")) && / noreturn\b/.test(l)) {
      const m = /@("[^"]+"|[^\s(]+)\(/.exec(l);
      if (m) noreturn.add(m[1]);
    }
  }
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("define ") && l.trimEnd().endsWith("{")) {
      const m = /@("[^"]+"|[^\s(]+)\(/.exec(l);
      const fnName = m ? m[1] : "?";
      let j = i + 1;
      while (j < lines.length && lines[j] !== "}") j++;
      if (lines.slice(i + 1, j).some(x => x.includes("@__milo_own_"))) {
        verifyFunction(fnName, lines, i + 1, j, findings, noreturn);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return findings;
}

function verifyFunction(fn: string, lines: string[], start: number, end: number, out: OwnFinding[], noreturn: Set<string>) {
  const blocks: Block[] = [];
  const byName = new Map<string, number>();
  const makeInfo = new Map<number, { line: number; origin: string; src: number }>();
  // parent ID -> the part IDs moved out of it somewhere in this function
  const parts = new Map<number, Set<number>>();
  const partIds = new Set<number>();
  let cur: Block | null = null;
  const open = (name: string) => {
    cur = { name, events: [], guards: [], succs: [], brCond: null, term: "fall", termLine: 0 };
    byName.set(name, blocks.length);
    blocks.push(cur);
  };
  open("%entry");
  let anon = 0;
  const labelsOf = (s: string) => [...s.matchAll(/label %("[^"]+"|[A-Za-z0-9_.$-]+)/g)].map(m => m[1]);
  for (let k = start; k < end; k++) {
    const raw = lines[k];
    const lm = LABEL_RE.exec(raw);
    if (lm) {
      const prev = cur as Block | null;
      if (prev && prev.term === "fall") prev.succs.push(lm[1]);
      // A label right after `define {` names the entry block itself.
      if (prev && prev.name === "%entry" && prev.events.length === 0 && blocks.length === 1 && prev.term === "fall") {
        byName.delete("%entry");
        prev.name = lm[1];
        prev.succs = [];
        byName.set(lm[1], 0);
      } else {
        open(lm[1]);
      }
      continue;
    }
    const t = raw.trim();
    if (t === "" || t.startsWith(";")) continue;
    let b = cur as unknown as Block;
    if (b.term !== "fall") { open(`%anon${anon++}`); b = cur as unknown as Block; }
    const lineNo = k + 1;
    if (t.includes("@__milo_own_")) {
      let m: RegExpExecArray | null;
      if ((m = MAKE_RE.exec(t))) {
        const id = Number(m[1]);
        b.events.push({ op: "make", id, tolerant: false, transfer: false, src: 0, line: lineNo });
        if (!makeInfo.has(id)) makeInfo.set(id, { line: lineNo, origin: m[2] ?? "?", src: m[3] ? Number(m[3]) : 0 });
      } else if ((m = END_RE.exec(t))) {
        const kind = OWN_END_KINDS[Number(m[2])] ?? "DROP";
        b.events.push({ op: "end", id: Number(m[1]), tolerant: kind === "DROPZ" || kind === "DROPZF", transfer: !kind.startsWith("DROP"), src: 0, line: lineNo, fieldwise: kind === "DROPF" || kind === "DROPZF" });
      } else if ((m = PART_RE.exec(t))) {
        const pid = Number(m[1]), fid = Number(m[2]);
        let ps = parts.get(pid);
        if (!ps) { ps = new Set(); parts.set(pid, ps); }
        ps.add(fid);
        partIds.add(fid);
        if (!makeInfo.has(fid)) makeInfo.set(fid, { line: lineNo, origin: "field-move", src: 0 });
        b.events.push({ op: "part", id: fid, tolerant: false, transfer: true, src: pid, line: lineNo });
      } else if ((m = VIEW_RE.exec(t))) {
        const id = Number(m[1]);
        b.events.push({ op: "view", id, tolerant: false, transfer: false, src: Number(m[2]), line: lineNo });
        if (!makeInfo.has(id)) makeInfo.set(id, { line: lineNo, origin: m[3] ?? "view", src: m[4] ? Number(m[4]) : 0 });
      } else if ((m = GUARD_RE.exec(t))) {
        b.guards.push({ id: Number(m[1]), cond: m[2] });
      }
      continue;
    }
    if (t.startsWith("br ")) {
      b.term = "br"; b.termLine = lineNo;
      b.succs = labelsOf(t);
      const cm = /^br i1 (%[^,\s]+),/.exec(t);
      if (cm) b.brCond = cm[1];
    } else if (t.startsWith("switch ")) {
      let s = t;
      while (!s.includes("]") && k + 1 < end) s += " " + lines[++k].trim();
      b.term = "switch"; b.termLine = lineNo;
      b.succs = labelsOf(s);
    } else if (t.startsWith("ret ") || t === "ret") {
      b.term = "ret"; b.termLine = lineNo;
    } else if (t === "unreachable") {
      b.term = "unreachable"; b.termLine = lineNo;
    } else if (noreturn.size && t.includes("call ")) {
      const cm = /\bcall [^@]*@("[^"]+"|[^\s(]+)\(/.exec(t);
      if (cm && noreturn.has(cm[1])) { b.term = "unreachable"; b.termLine = lineNo; }
    }
  }

  // A view that is never ended needs no state of its own (only its source is checked), and
  // views are most of the markers: leaving them out keeps the dataflow narrow.
  const ended = new Set(blocks.flatMap(b => b.events.filter(e => e.op === "end").map(e => e.id)));
  const ids = [...new Set(blocks.flatMap(b => b.events.flatMap(e => {
    const own = e.op !== "view" || ended.has(e.id) ? [e.id] : [];
    // a part's parent is in `src` only to be tracked, as a view's source is
    return e.src ? [...own, e.src] : own;
  })).concat(blocks.flatMap(b => b.guards.map(g => g.id))))];
  if (ids.length === 0) return;
  const idx = new Map(ids.map((id, n) => [id, n]));
  const n = ids.length;
  const nb = blocks.length;
  const succIdx = blocks.map(b => b.succs.map(s => byName.get(s)).filter((x): x is number => x !== undefined));

  const transfer = (b: Block, s: Uint8Array): Uint8Array => {
    const o = s.slice();
    for (const e of b.events) {
      const k = idx.get(e.id);
      if (k === undefined) continue;
      o[k] = e.op === "make" ? L : e.op === "view" || (o[k] & V) ? V : e.transfer ? M : E;
      // A parent made or ended whole makes or ends its parts with it.
      const ps = e.op === "make" || (e.op === "end" && !e.fieldwise) ? parts.get(e.id) : undefined;
      if (ps) for (const f of ps) { const fk = idx.get(f); if (fk !== undefined) o[fk] = e.op === "make" ? L : E; }
    }
    return o;
  };
  const edgeState = (bi: number, si: number, outS: Uint8Array): Uint8Array => {
    const b = blocks[bi];
    if (!b.brCond || b.guards.length === 0 || b.succs.length !== 2) return outS;
    const gs = b.guards.filter(g => g.cond === b.brCond);
    if (gs.length === 0) return outS;
    const isTrue = byName.get(b.succs[0]) === si && b.succs[0] !== b.succs[1];
    const isFalse = byName.get(b.succs[1]) === si && b.succs[0] !== b.succs[1];
    if (!isTrue && !isFalse) return outS;
    const o = outS.slice();
    for (const g of gs) {
      const k = idx.get(g.id)!;
      o[k] = isTrue ? (o[k] & L) : (o[k] & ~L);
    }
    return o;
  };

  const inS: (Uint8Array | null)[] = new Array(nb).fill(null);
  const outS: (Uint8Array | null)[] = new Array(nb).fill(null);
  inS[0] = new Uint8Array(n).fill(U);
  const work: number[] = [0];
  const queued = new Uint8Array(nb); queued[0] = 1;
  while (work.length) {
    const bi = work.pop()!;
    queued[bi] = 0;
    const o = transfer(blocks[bi], inS[bi]!);
    outS[bi] = o;
    for (const si of succIdx[bi]) {
      const es = edgeState(bi, si, o);
      const prev = inS[si];
      let changed = false;
      if (!prev) { inS[si] = es.slice(); changed = true; }
      else for (let k = 0; k < n; k++) { const v = prev[k] | es[k]; if (v !== prev[k]) { prev[k] = v; changed = true; } }
      if (changed && !queued[si]) { queued[si] = 1; work.push(si); }
    }
  }

  const seen = new Set<string>();
  const report = (id: number, kind: OwnFindingKind, at: number) => {
    const key = `${id}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mi = makeInfo.get(id);
    out.push({ fn, id, kind, irLine: mi?.line ?? at, origin: mi?.origin ?? "?", srcLine: mi?.src ?? 0, at });
  };

  for (let bi = 0; bi < nb; bi++) {
    const b = blocks[bi];
    if (!inS[bi] || b.term === "unreachable") continue;
    const s = inS[bi]!.slice();
    for (const e of b.events) {
      const k = idx.get(e.id) ?? -1;
      const ps = parts.get(e.id);
      if (e.op === "make") {
        if (s[k] & L && !partIds.has(e.id)) report(e.id, "remake-live", e.line);
        s[k] = L;
        if (ps) for (const f of ps) s[idx.get(f)!] = L;
      } else if (e.op === "part") {
        if (s[k] & (M | E)) report(e.id, "end-after-move", e.line);
        s[k] = M;
      } else if (e.op === "view") {
        // The copied bytes must still be the source's. An unmade source is a slot codegen
        // never armed in this frame (a scratch temp), which makes no claim either way.
        if (e.src) {
          const sk = idx.get(e.src)!;
          if (s[sk] & M) report(e.id, "use-after-move", e.line);
          else if (s[sk] & E) report(e.id, "use-after-drop", e.line);
        }
        if (k >= 0) s[k] = V;
      } else if (s[k] & V) {
        // A view is never anyone's to dispose of; it stays a view, so one report per ID.
        report(e.id, e.transfer ? "own-of-view" : "drop-of-view", e.line);
      } else {
        if (!e.tolerant && s[k] & M) report(e.id, "end-after-move", e.line);
        else if (!e.tolerant && s[k] & E) report(e.id, "double-end", e.line);
        if (!e.tolerant && s[k] & U && !partIds.has(e.id)) report(e.id, "end-unmade", e.line);
        s[k] = e.transfer ? M : E;
        if (ps && !e.fieldwise) {
          for (const f of ps) {
            const fk = idx.get(f)!;
            if (s[fk] & (M | E)) report(f, "part-double-drop", e.line);
            s[fk] = E;
          }
        }
      }
    }
    if (b.term === "ret") {
      // A live part is part of its parent's value; the parent's own state speaks for it.
      for (let k = 0; k < n; k++) if (s[k] & L && !partIds.has(ids[k])) report(ids[k], "leak-ret", b.termLine);
    }
  }

  // Back-edges by DFS from the entry: an edge into a block still on the DFS stack.
  const color = new Uint8Array(nb); // 0 white, 1 on stack, 2 done
  const backEdges: [number, number][] = [];
  const stack: [number, number][] = [[0, 0]];
  color[0] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [bi, ei] = top;
    if (ei < succIdx[bi].length) {
      top[1]++;
      const si = succIdx[bi][ei];
      if (color[si] === 1) backEdges.push([bi, si]);
      else if (color[si] === 0) { color[si] = 1; stack.push([si, 0]); }
    } else {
      color[bi] = 2;
      stack.pop();
    }
  }
  const preds: number[][] = Array.from({ length: nb }, () => []);
  succIdx.forEach((ss, bi) => { for (const si of ss) preds[si].push(bi); });
  for (const [latch, header] of backEdges) {
    if (!outS[latch] || blocks[latch].term === "unreachable") continue;
    const body = new Set<number>([header]);
    const q = [latch];
    while (q.length) { const x = q.pop()!; if (body.has(x)) continue; body.add(x); for (const p of preds[x]) q.push(p); }
    // Only IDs made nowhere but inside the loop: a slot declared before the loop and
    // reassigned in it is re-made in the body yet rightly stays live across the back-edge.
    const madeInside = new Set<number>();
    for (const x of body) for (const e of blocks[x].events) if (e.op === "make") madeInside.add(e.id);
    for (let x = 0; x < nb; x++) if (!body.has(x)) for (const e of blocks[x].events) if (e.op === "make") madeInside.delete(e.id);
    const es = edgeState(latch, header, outS[latch]!);
    for (const id of madeInside) if (es[idx.get(id)!] & L) report(id, "leak-iter", blocks[latch].termLine);
  }
  // A per-iteration leak also shows up as the next iteration's make meeting a live ID; one
  // report is enough.
  for (let k = out.length - 1; k >= 0; k--) {
    const f = out[k];
    if (f.fn === fn && f.kind === "remake-live" && seen.has(`${f.id}:leak-iter`)) out.splice(k, 1);
  }
}

export function formatOwnFinding(f: OwnFinding): string {
  const src = f.srcLine ? `, milo line ${f.srcLine}` : "";
  return `${f.fn}: ${f.id} ${f.kind} (made at IR line ${f.irLine} by ${f.origin}${src}; seen at IR line ${f.at})`;
}
