# Contributing to platen

Thanks for helping! This repo is small and direct: short-lived feature
branches, PRs into `main`, CI must be green before merge.

## Dev setup

Requirements: **Node ≥ 20** and Playwright's Chromium:

```bash
npm ci
npx playwright install chromium
```

## Test gates (all must pass before a PR can merge)

```bash
npm test          # unit + browser-level tests (browser tests skip without Chromium)
npm run smoke     # hostile fixture -> PDF -> verification, exit code asserted
npm run smoke:real  # optional: converts a real deck if PLATEN_REAL_DECK is set (see the script)
npm run ui        # optional: start the preview UI and click around
```

`npm test` auto-skips Chromium-dependent tests when no browser is available,
but a PR that touches the pipeline (`src/pipeline.js`, `src/template.js`,
`src/detect.js`, `src/verify.js`, `src/email.js`, `src/browser.js`) must be
validated with Chromium installed locally or via the CI smoke step.

## Branch / PR flow

1. Branch from `main` with a descriptive name (`feat/...`, `fix/...`).
2. Keep PRs focused; one behavior per PR.
3. CI runs the matrix (node 20/22) plus a Chromium smoke — it must be green.
4. Squash-or-merge commits with messages that say *why*, in the imperative
   mood, matching the existing log.

## Code layout

| Path | Owns |
|---|---|
| `src/pipeline.js` | convert() orchestration, geometry, printing, merge |
| `src/template.js` | clean-document builder + content width detection |
| `src/detect.js` | section-detection ladder (runs in-page; keep it DOM-only) |
| `src/email.js` | image downscale + footer merge helpers |
| `src/verify.js` | output verification (pdfjs text probe) |
| `src/browser.js` | Chromium discovery across platforms |
| `src/ui/server.js` | zero-dep preview UI server |
| `bin/platen.js`, `bin/platen-ui.js` | thin CLI wrappers over the library |
| `test/fixtures/*.html` | deterministic fixtures (see `scripts/gen-image-fixture.mjs`) |

In-page functions (`detectSectionsInPage`, `buildCleanTemplate`,
`detectContentMaxWidthInPage`) are serialized into the browser — they must not
reference Node-scope constants; tests cover the fallback paths.

## Releasing

Maintainers cut releases by version tag; see [PUBLISHING.md](PUBLISHING.md).
The tag push builds, publishes with provenance, and attaches the tarball to a
GitHub Release.
