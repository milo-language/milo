// Gate on the generated language reference: the site's attribute and warning sections are
// rendered from `milo lang --json`, never retyped.
//
// The attribute table was hand-kept and shipped missing five attributes — @noCopy, @thread
// and @synchronized among them, three of the four that exist for safety — and the warning
// section covered 10 of 26 warnings, so 16 lints a user could enable existed nowhere a user
// would look. A completeness test over a hand table is still two copies of the list; this
// holds the published bytes to the generator's output instead.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { generate } from "../scripts/gen-lang-docs";
import { WARNING_NAMES, WARNING_DOCS_URL } from "../src/warnings";
import { ATTRIBUTE_NAMES } from "../src/attributes";
import { langInfo } from "../src/lang-info";

const ROOT = join(import.meta.dir, "..");

test("the committed pages match the generator", () => {
  // Regenerate with: bun run scripts/gen-lang-docs.ts
  const stale = generate().filter(r => r.expected !== r.actual).map(r => r.file);
  expect(stale).toEqual([]);
});

test("every warning and attribute reaches the published page", () => {
  const warnings = readFileSync(join(ROOT, "docs/site/language/warnings-and-errors.md"), "utf-8");
  const annotations = readFileSync(join(ROOT, "docs/site/features/annotations.md"), "utf-8");
  // Inside the generated region only: prose elsewhere on the page mentions some of these in
  // passing, which would satisfy a bare includes() while the reference stayed incomplete.
  const region = (body: string, name: string) => {
    const start = body.indexOf(`<!-- generated:${name} -->`);
    const end = body.indexOf(`<!-- /generated:${name} -->`);
    expect({ region: name, present: start !== -1 && end > start }).toEqual({ region: name, present: true });
    return body.slice(start, end);
  };
  const warningRegion = region(warnings, "warnings");
  const attributeRegion = region(annotations, "attributes");
  expect(WARNING_NAMES.length).toBeGreaterThan(20); // an emptied list must not read as complete
  expect(ATTRIBUTE_NAMES.length).toBeGreaterThan(10);
  for (const n of WARNING_NAMES) {
    expect({ warning: n, published: warningRegion.includes(`\`${n}\``) }).toEqual({ warning: n, published: true });
  }
  for (const n of ATTRIBUTE_NAMES) {
    expect({ attribute: n, published: attributeRegion.includes(`@${n}`) }).toEqual({ attribute: n, published: true });
  }
});

test("the editor link for a warning points at the page that carries its entry", () => {
  // The LSP sends `codeDescription.href = WARNING_DOCS_URL#<name>`. Both halves are checked:
  // the origin is the site's own, and the path is the page the generator writes the region to.
  const config = readFileSync(join(ROOT, "docs/site/.vitepress/config.mts"), "utf-8");
  const site = config.match(/^const SITE = '([^']+)'/m)?.[1];
  expect(site).toBeDefined();
  expect(WARNING_DOCS_URL).toBe(`${site}/language/warnings-and-errors`);
  expect(generate().some(r => r.file === "docs/site/language/warnings-and-errors.md")).toBe(true);
});

test("every shown command and option reaches the CLI reference page", () => {
  const page = readFileSync(join(ROOT, "docs/site/cli.md"), "utf-8");
  const start = page.indexOf("<!-- generated:commands -->");
  const end = page.indexOf("<!-- /generated:commands -->");
  expect(start !== -1 && end > start).toBe(true);
  const region = page.slice(start, end);
  const info = langInfo();
  const shown = info.commands.filter(c => !c.hidden);
  expect(shown.length).toBeGreaterThan(25); // an emptied table must not read as complete
  for (const c of shown) expect({ command: c.name, published: region.includes(`### ${c.name}\n`) }).toEqual({ command: c.name, published: true });
  for (const o of info.cliOptions) expect({ option: o.flag, published: region.includes(`\`${o.flag}\``) }).toEqual({ option: o.flag, published: true });
});
