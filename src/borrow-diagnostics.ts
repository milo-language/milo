// The text of the view-loan and loop-loan conflict diagnostics. src/borrow-flow.ts decides where they
// apply; the wording is the checker's (reportBorrowed in src/checker-borrows.ts), copied so the shadow
// comparison can tell a wrong place from a wrong sentence.
export interface BorrowText { message: string; hint?: string }

// `prefix` is the rejected operation with its place ("cannot call 'push' on 'xs'"); `root` is the
// borrowed binding, named as "it" when the prefix already ends with it.
const itOf = (prefix: string, root: string) => (prefix.endsWith(`'${root}'`) ? "it" : `'${root}'`);

export function whileHolderBorrows(prefix: string, root: string, holder: string): BorrowText {
  return {
    message: `${prefix} while '${holder}' borrows ${itOf(prefix, root)}`,
    hint: `'${holder}' points into '${root}', and this could move or free that memory: finish using '${holder}' first, or copy what it points to with '.clone()'`,
  };
}

// A conflict with a borrow the checker records without a holder (reportBorrowed's fallback wording). The hint is the one
// each walk site passes: `how` is the operation (a mutating call or place argument, an assignment, a closure's write, a move).
// The dashes in two hints are the walk's own text, kept so the wording does not change.
export function unattributed(prefix: string, root: string, how: "call" | "assign" | "closure" | "move"): BorrowText {
  const hint = how === "assign" ? `a reference or slice into this variable is still live — the assignment would invalidate it`
    : how === "closure" ? `a slice or loop iteration over '${root}' is still live, and the closure's write could move memory it points into`
    : how === "move" ? `a closure capture, or a live slice, reference or loop over this variable, still points into it: moving it would leave that borrow dangling`
    : `a slice or loop iteration over this variable is still live — mutating it could move memory the borrow points into`;
  return { message: `${prefix} because ${prefix.endsWith(`'${root}'`) ? "it" : `'${root}'`} is borrowed`, hint };
}

// A conflict with a callback's receiver: `items.each(cb)` borrows `items` until the callback returns.
export function whileCallbackRuns(prefix: string, root: string, label: string): BorrowText {
  return { message: `${prefix} while '${label}' borrows ${itOf(prefix, root)}`, hint: `collect the changes inside the callback and apply them after the call` };
}

export function whileLoopIterates(prefix: string, root: string): BorrowText {
  return {
    message: `${prefix} while a loop iterates over ${itOf(prefix, root)}`,
    hint: `collect the changes inside the loop and apply them after it, or iterate over a copy ('${root}.clone()')`,
  };
}

// `v[i] = x` inside a loop that hands out the elements of `v`.
export function elemAssignWhileIterated(target: string, root: string): BorrowText {
  return {
    message: `cannot assign to '${target}' because '${root}' is being iterated`,
    hint: `the loop hands out this element — finish the loop, or collect the writes and apply them after it`,
  };
}

export const callPrefix = (method: string, text: string) => `cannot call '${method}' on '${text}'`;
export const assignPrefix = (text: string) => `cannot assign to '${text}'`;
// A place handed to a `&mut` parameter ("pass") or written by `swap` / `replace`; names the root, as the checker does.
export const actionPrefix = (action: string, root: string) => `cannot ${action} '${root}'`;
export const movePrefix = (name: string) => `cannot move '${name}'`;

// A write while a raw pointer into the buffer is held (src/checker-borrows.ts errorIfFrozen, and the index-write and
// reassignment sites in src/checker-stmt.ts). `text` is the written expression; an index write names its root.
export function pointerConflict(kind: "call" | "assign" | "elem" | "closure", written: string, root: string, holder: string, call: string, line: number): BorrowText {
  const tail = `while '${holder}' still points into its buffer (from '${call}' on line ${line})`;
  if (kind === "elem") return { message: `'${root}' is written here ${tail}`, hint: `write through '${holder}' instead, or take the pointer after the last write` };
  // A closure's write names the capture and how the closure was reached: `written` is "calling 'f'".
  if (kind === "closure") return { message: `'${root}' is written by ${written} ${tail}`, hint: `take the pointer after the last mutation, or pass '${call}' inline to the call` };
  const hint = `take the pointer after the last mutation, or pass '${call}' inline to the call`;
  return { message: kind === "call" ? `'${written}' may reallocate here ${tail}` : `'${written}' is reassigned here ${tail}`, hint };
}

// A closure body's write of a captured place, at the call of the closure or where it is handed on.
export const closureWritePrefix = (name: string, how: "calling" | "passing", fname: string) => `cannot write to '${name}' by ${how} '${fname}'`;

// How a held reference into a global's buffer is named: a slice borrows from it, a raw pointer still points into it.
const heldView = (global: string, holder: string, call?: string, line?: number) =>
  call === undefined ? `'${holder}' borrows from '${global}'s buffer` : `'${holder}' still points into '${global}'s buffer (from '${call}' on line ${line})`;

// A call that parks the task while a reference into a global's buffer is held (src/checker-global-borrow.ts parkBlock).
export function parkWhileHeld(say: string, global: string, holder: string, call?: string, line?: number): BorrowText {
  const held = heldView(global, holder, call, line);
  return {
    message: `${say} can park this task while ${held}; another task may push to '${global}' before it resumes`,
    hint: `iterate by index ('while i < ${global}.len'), snapshot first ('${global}.clone()'), or take it with 'replace(${global}, ...)' so the task owns it`,
  };
}

// A callee that writes a global while a reference into its buffer is held (writeBlock's second loop).
export function writesGlobalWhileHeld(say: string, global: string, holder: string, call?: string, line?: number): BorrowText {
  return {
    message: `${say} writes the global '${global}' while ${heldView(global, holder, call, line)}`,
    hint: `pushing to, clearing or reassigning '${global}' frees the buffer '${holder}' points into: take '${holder}' after the call, or end its block before it`,
  };
}

// The flow class: the message templates src/borrow-flow.ts reports. The checker drops the walk's errors matching one (src/checker-core.ts),
// and scripts/borrow-shadow.ts and scripts/borrow-fuzz.ts judge the same set, so there is one list. In the order the shadow table prints them.
export const TEMPLATES: [string, RegExp][] = [
  ["call vs view", /^cannot call '.+' on '.+' while '[^']+' borrows .+$/],
  ["call vs loop", /^cannot call '.+' on '.+' while a loop iterates over .+$/],
  ["assign vs view", /^cannot assign to '.+' while '[^']+' borrows .+$/],
  ["assign vs loop", /^cannot assign to '.+' while a loop iterates over .+$/],
  ["elem assign vs loop", /^cannot assign to '.+' because '.+' is being iterated$/],
  ["pass/swap/replace vs view/loop", /^cannot (pass|swap|replace) '[^']+' while ('[^']+' borrows .+|a loop iterates over .+)$/],
  ["holder-less (it is borrowed)", /^cannot .+ because (it|'[^']+') is borrowed$/],
  ["park vs global view", /^.+ can park this task while '[^']+' (borrows from|still points into) .+'s buffer.*; another task may push to .+ before it resumes$/],
  ["global write vs global view", /^.+ writes the global '[^']+' while '[^']+' (borrows from|still points into) .+'s buffer.*$/],
  ["move vs view", /^cannot move '[^']+' while '[^']+' borrows .+$/],
  ["move vs loop", /^cannot move '[^']+' while a loop iterates over .+$/],
  ["call vs pointer", /^'.+' may reallocate here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["assign vs pointer", /^'.+' is reassigned here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
  ["closure write vs view/loop", /^cannot write to .[^.]+. by (calling|passing) .[^.]+. while (.[^.]+. borrows .+|a loop iterates over .+)$/],
  ["closure write vs pointer", /^.+. is written by (calling|passing) .[^.]+. while .[^.]+. still points into its buffer \(from .+ on line \d+\)$/],
  ["elem write vs pointer", /^'.+' is written here while '[^']+' still points into its buffer \(from '.+' on line \d+\)$/],
];
export const templateOf = (m: string): string | null => TEMPLATES.find(([, re]) => re.test(m))?.[0] ?? null;
