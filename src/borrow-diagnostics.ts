// The text of the view-loan and loop-loan conflict diagnostics. src/borrow-flow.ts decides where they apply.
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

// A write while a raw pointer into the buffer is held (a mutating call, an index write, a reassignment, or a closure write);
// `text` is the written expression; an index write names its root.
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

// A read of a pointer holder after a plain move of its source (`take(v)`): the new owner may have freed the buffer. `forget(v)`
// and `let w = v` keep the holders alive.
export function usedAfterSourceMoved(name: string, root: string, call: string, line: number): BorrowText {
  return {
    message: `'${name}' used after its source '${root}' was moved (from '${call}' on line ${line})`,
    hint: `use 'forget(${root})' to hand the buffer to the pointer's new owner, or take the pointer after the move`,
  };
}

// `return p` where `p` points into a local that dies with the frame.
export function returnedPointerDangles(name: string, root: string, call: string, line: number): BorrowText {
  return {
    message: `cannot return '${name}': '${root}' is freed when this function returns, so the pointer would dangle (from '${call}' on line ${line})`,
    hint: `return the buffer itself, or 'forget' it first if the caller takes ownership of it`,
  };
}
