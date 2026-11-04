// The shape rules for traceability attributes (@req, @assume, @derived, @deactivated). A file of
// its own because the checker needs them and the checker runs in the browser playground, while
// src/requirements.ts reaches files and subprocesses.
import type { Attribute } from "./ast";

export const TRACE_ATTRS = new Set(["req", "assume", "derived", "deactivated"]);
export const ID_RE = /^[A-Za-z0-9_.\-]+$/;

/** Shape errors for one traceability attribute (the checker reports them), or null. */
export function traceAttrError(attr: Attribute, where: "fn" | "struct" | "clause"): string | null {
  if (attr.name === "deactivated") {
    if (where !== "fn") return "only a fn can be deactivated";
    if (attr.args.length !== 1 || attr.argKinds?.[0] !== "string" || attr.args[0]!.trim() === "") {
      return `write a reason: @deactivated("flight-test hook")`;
    }
    return null;
  }
  if (attr.name === "assume" && where !== "fn") return "@assume goes on a fn";
  if (attr.name === "derived" && where === "clause") return "@derived goes on a fn or struct";
  if (attr.args.length !== 1) return `write exactly one requirement id: @${attr.name}(HLR-1)`;
  if (!ID_RE.test(attr.args[0]!)) {
    return `'${attr.args[0]}' is not a requirement id: use letters, digits, '-', '_' and '.'`;
  }
  return null;
}
