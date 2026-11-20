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
export const movePrefix = (name: string) => `cannot move '${name}'`;

// A write while a raw pointer into the buffer is held (src/checker-borrows.ts errorIfFrozen, and the index-write and
// reassignment sites in src/checker-stmt.ts). `text` is the written expression; an index write names its root.
export function pointerConflict(kind: "call" | "assign" | "elem", written: string, root: string, holder: string, call: string, line: number): BorrowText {
  const tail = `while '${holder}' still points into its buffer (from '${call}' on line ${line})`;
  if (kind === "elem") return { message: `'${root}' is written here ${tail}`, hint: `write through '${holder}' instead, or take the pointer after the last write` };
  const hint = `take the pointer after the last mutation, or pass '${call}' inline to the call`;
  return { message: kind === "call" ? `'${written}' may reallocate here ${tail}` : `'${written}' is reassigned here ${tail}`, hint };
}
