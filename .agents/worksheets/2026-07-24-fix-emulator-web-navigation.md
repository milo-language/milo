<!-- doc-meta
system: worksheets
purpose: track the fix for VitePress intercepting links to static emulator applications
key-files: docs/site/index.md, docs/site/demos.md
update-when: implementation or verification status changes
last-verified: 2026-07-24
-->

# Worksheet: Fix emulator web navigation

- **Slug / tag:** `ws/fix-emulator-web-navigation`
- **Started:** 2026-07-24
- **Status:** done
- **Related:** `.github/workflows/docs.yml`

## Goal
Emulator links on the VitePress site load their static applications on the first click, and Back returns directly to the originating docs page.

## Plan
1. Mark every same-origin emulator application link as external to the VitePress router.
2. Add a focused regression check and build the documentation site.
3. Exercise click and Back behavior in a browser against the built site.

## Current state
All six emulator anchors bypass the VitePress router with `data-vp-ignore`, and a source-level regression test covers both pages. The requested emulator UI/audio follow-up belongs to the separate `milo-language/emulators` repository, whose clone is absent and cannot be fetched because this environment's GitHub proxy returns HTTP 407.

## Log
- 2026-07-24 — Read repository workflow, conventions, deployment workflow, and link sources. Found six affected anchors across `index.md` and `demos.md`.
- 2026-07-24 — Added `data-vp-ignore` to each emulator anchor and a regression test requiring the attribute on all three links on both pages.
- 2026-07-24 — Targeted tests and lint passed. Full tests reached unrelated failures because `clang` is absent. Docs dependency installation was blocked by network connection refusals, so the docs build could not run.
- 2026-07-24 — Cross-model implementation review reported no findings. The emulator frontend follow-up is blocked outside this repository: the documented clone is absent and `git clone` failed with `CONNECT tunnel failed, response 407`.

## Decisions
- Use VitePress's `data-vp-ignore` anchor attribute so navigation remains same-tab browser navigation with native history.

## Blockers / open questions
- Browser build/interaction verification requires docs dependencies; package downloads are blocked in this environment.
- SNES audio and unified controller UI changes require `milo-language/emulators`; its clone is unavailable and GitHub access is blocked.

## Verification
- [x] targeted tests: `bun test tests/siteNavigation.test.ts` (2 pass)
- [ ] ran the site: blocked because VitePress dependencies are unavailable
- [ ] docs build: `bun run build` failed because VitePress is not installed; `bun install --frozen-lockfile` was blocked by connection refusals
- [x] agent review: correctness, security, and performance reviewers reported no findings
- [x] docs updated (last-verified bumped): worksheet added; affected source pages are site content rather than system documentation
