// `fs` as the playground bundle sees it: a read-only view of the in-memory file map in
// playground-host.ts. Only what the resolver, checker and suggest.ts call is here; anything
// else is a build error in the bundle rather than a silent no-op.
import { vfs } from "./playground-host";

export const existsSync = (p: string): boolean => vfs.has(p);
export function readFileSync(p: string, _enc?: string): string {
  const t = vfs.get(p);
  if (t === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return t;
}
export const readdirSync = (_p: string): string[] => [];
export function statSync(p: string): never {
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
}
