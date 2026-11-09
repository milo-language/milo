// Every generated checker pass against its TypeScript original in one walk of the corpus: the nine
// ts2milo-<pass>-diff.ts gates, with each program parsed and checked once instead of once per gate.
// Red when any pass fails to build, differs, crashes, or is reached by no program.
// Options (--limit, --only, --reuse, --neuter) are in scripts/ts2milo/pass-diff.ts.
import { runPassDiffs } from "./ts2milo/pass-diff";
import { spec as purity } from "./ts2milo-purity-diff";
import { spec as nonescaping } from "./ts2milo-nonescaping-diff";
import { spec as concurrentArgs } from "./ts2milo-concurrent-args-diff";
import { spec as escapingClosures } from "./ts2milo-escaping-closures-diff";
import { spec as globalBorrow } from "./ts2milo-global-borrow-diff";
import { spec as mutBundle } from "./ts2milo-mut-bundle-diff";
import { spec as pointerEscape } from "./ts2milo-pointer-escape-diff";
import { spec as taskScopes } from "./ts2milo-task-scopes-diff";
import { spec as threadBoundary } from "./ts2milo-thread-boundary-diff";

if (import.meta.main) runPassDiffs([purity, nonescaping, concurrentArgs, escapingClosures, globalBorrow, mutBundle, pointerEscape, taskScopes, threadBoundary]);
