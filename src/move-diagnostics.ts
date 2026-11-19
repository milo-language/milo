// The text of every use-after-move diagnostic, one function per shape. src/move-flow.ts decides where
// they apply; the wording is the checker's, moved here so there is one copy of it.
import type { TypeKind } from "./types";
import type { StructInfo } from "./checker";

export interface MoveText { message: string; hint?: string }

// `name` read after it was moved whole. `movedByPattern`: the move was a match taking its payload.
export function usedAfterMove(name: string, t: TypeKind, structs: Map<string, StructInfo>, show: (t: TypeKind) => string, movedByPattern: boolean): MoveText {
  const message = `use of moved variable '${name}'`;
  if (movedByPattern) {
    return { message, hint: `the pattern moved '${name}''s payload out, so reading '${name}' here would see a zeroed value. Use the pattern's binding instead, or compute what you need from '${name}' before the match.` };
  }
  // A `@noCopy` handle is deliberately not clonable — duplicating one is how you get the double-free
  // it exists to prevent — so the usual hint would name a fix that cannot be applied.
  const noCopy = t.tag === "struct" && structs.get(t.name)?.noCopy === true;
  const pointerField = t.tag === "struct" ? structs.get(t.name)?.pointerField : undefined;
  // An owning closure has no `.clone()` to suggest: duplicating the environment is exactly what makes it unsound to own.
  const owningFn = t.tag === "fn" && t.owning === true;
  // A type from a package is stored as `gl$Texture2D`; the hint names what the reader types.
  const bare = () => show(t).split("$").pop();
  return {
    message,
    hint: owningFn
      ? `'${name}' is a 'move' closure, so it OWNS what it captured and there is only one of it — passing it on transferred that ownership. Build a second closure, or restructure so the transfer happens last.`
      : noCopy
      ? `'${name}' is a @noCopy handle, so transferring it ended its life here — copying one would let the same resource be released twice. Borrow it (pass it to a '&${bare()}' parameter) instead of transferring, or reorder so the transfer is last.`
      : pointerField
      ? `'${name}' holds a raw pointer ('${pointerField}'), so it is move-tracked and transferring it ended its life here: a copy would be a second owner of whatever the pointer addresses. Borrow it (pass it to a '&${bare()}' parameter) instead of transferring, reorder so the transfer is last, or mark '${bare()}' @copy if it does not own what the pointer points at.`
      : `ownership of '${name}' was transferred earlier and it can no longer be used here. To keep it alive, clone it at the point of transfer: '${name}.clone()'.`,
  };
}

// The field `root.path` read after `root.gone` (itself or a prefix of it) was moved out.
export function fieldUsedAfterMove(root: string, path: string, gone: string): MoveText {
  return {
    message: `use of moved value '${root}${path}'`,
    hint: gone === path
      ? `ownership of '${root}${path}' was transferred earlier — the field is empty now. Clone it at the point of transfer: '${root}${path}.clone()'.`
      : `'${root}${gone}' was moved out earlier, which took '${root}${path}' with it. Clone at the point of transfer: '${root}${gone}.clone()'.`,
  };
}

// `name` read whole after its field `name.gone` was moved out.
export function incomplete(name: string, gone: string): MoveText {
  return {
    message: `'${name}' is incomplete: '${name}${gone}' was moved out of it`,
    hint: `using '${name}' as a whole would show that field as empty — clone it at the point of transfer, or use the fields that are still there`,
  };
}

// `name` moved whole after its field `name.gone` was moved out.
export function moveOfIncomplete(name: string, gone: string): MoveText {
  return {
    message: `cannot move '${name}' because '${name}${gone}' was already moved out of it`,
    hint: `move the remaining fields individually, or clone '${name}${gone}' at the point it was transferred so '${name}' stays whole`,
  };
}

// A move inside a loop body that the next iteration would repeat.
export function moveOutOfLoop(place: string): MoveText {
  return { message: `cannot move '${place}' out of a loop` };
}

// Closure `fname` captures `cap` by reference and reads `cap.path` when it runs, after `cap.gone` moved.
export function captureUsedAfterMove(fname: string, cap: string, path: string, gone: string | null): MoveText {
  if (gone === null) {
    return {
      message: `use of moved variable '${cap}'`,
      hint: `'${fname}' captures '${cap}' by reference and uses it when it runs, but ownership of '${cap}' was transferred earlier, so the closure would see an emptied value. Reassign '${cap}' first, or clone it at the point of transfer.`,
    };
  }
  return {
    message: `use of moved value '${cap}${gone}'`,
    hint: `'${fname}' captures '${cap}' by reference and reads '${cap}${path}' when it runs, but '${cap}${gone}' was moved out earlier, so the closure would see an emptied field. Clone it at the point of transfer: '${cap}${gone}.clone()'.`,
  };
}

// Calling the closure `name` after it was moved. `consumedByCall`: an earlier call used it up.
export function calledAfterMove(name: string, t: TypeKind | undefined, consumedByCall: boolean): MoveText {
  return {
    message: `use of moved variable '${name}'`,
    hint: consumedByCall
      ? `'${name}' moves a captured value out of itself when it runs, so calling it consumes it: the second call would see that capture already gone. Build a second closure, or clone what it captures inside the body instead of moving it.`
      : t !== undefined && t.tag === "fn" && t.owning === true
      ? `'${name}' is a 'move' closure and it was transferred earlier, so calling it here would run against an environment its new owner may already have released.`
      : `ownership of '${name}' was transferred earlier and it can no longer be used here.`,
  };
}
