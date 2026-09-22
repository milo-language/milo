import fs from 'node:fs'
import path from 'node:path'

// Shared by config.mts (markdown fences) and theme/tour.data.ts (tour lessons).
// The canonical grammar is generated from the compiler's keyword lists by
// scripts/gen-tmlanguage.ts and gated by tests/tmLanguage.test.ts. This used to be a
// hand-made COPY sitting next to this config, and it had drifted to the pre-generator
// version: it highlighted `char`, `String` and `Box` (none exist in Milo) and missed
// `unsafe`, `from`, `trait`, `interface`, `type`, `move`, the contract keywords and the
// `int`/`byte`/`float`/`string` type names. Read the one file the gate covers.
// Shiki resolves a fence's language by the grammar's `name`, and the generated
// grammar carries the display name 'Milo'. Every ```milo fence therefore missed and
// fell back to plain text while the build still exited 0. Pin the id to the fence.
export const miloGrammar = {
  ...JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../editors/vscode/syntaxes/milo.tmLanguage.json'),
      'utf-8',
    ),
  ),
  name: 'milo',
}
