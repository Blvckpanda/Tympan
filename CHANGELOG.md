# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] - 2026-09-29

### Changed
- **The package is now unscoped: `npm install tympan`.** The name `tympan`
  was always the spec's first choice (SPEC §9) and free on the registry;
  the `@blvckpanda/` scope was purely defensive after npm's typosquat
  filter rejected the earlier working name at publish time. Scoped names
  skip that filter, so the scope existed to get *a* name out — with the
  final name verified free, the package ships as plain **`tympan`**. The
  scoped package `@blvckpanda/tympan@0.4.0` remains published as a stable
  alias; it will be deprecated once the unscoped line is proven.
- The release workflow's publish step is no longer skipped when
  `NPM_TOKEN` is absent (the `if:` guard removed): under npm trusted
  publishing the workflow authenticates via OIDC and needs no npm token
  secret at all. `NPM_TOKEN` remains set only as a fallback while the
  trusted publisher is re-pointed at the unscoped package; it is deleted
  in 0.4.2.

## [0.4.0] - 2026-09-29

### Changed
- **Renamed the project to tympan** — the padded sheet on a printing press
  that presses the paper against the type (SPEC §9). The package publishes
  as **`@blvckpanda/tympan`** (scoped names skip npm's typosquat similarity
  filter entirely — the lesson from the `aipdf` → `jspdf` rejection); the
  installed commands are `tympan` and `tympan-ui`; the repo is
  github.com/Blvckpanda/Tympan. The Chromium override environment variable
  is now `TYMPAN_CHROMIUM`; the acceptance runner's are `TYMPAN_REAL_DECK`
  / `TYMPAN_REAL_PROBE`.
- **Adopted the product spec as [SPEC.md](SPEC.md)** — verbatim, plus an
  "Adoption decisions" section recording every deviation and why:
  blocklist-over-allowlist security defaults, the exact-pinned Playwright
  engine contract, JavaScript through v1, the honest byte-determinism
  claim, and section-per-page as the default strategy. README positioning
  now leads with the spec's wedge: deterministic, secure, fast.
- The `playwright` dependency is exact-pinned (`1.63.0`, no caret): a
  floating engine is a rendering change in disguise.

### Fixed
- **Text probes no longer fail on extraction whitespace.** pdfjs joins text
  items with unstable gaps ("solo   developer"), so any multi-word `--probe`
  could miss text that is visibly on the last page. Probes are now
  case-insensitive and whitespace-flexible: every space in the probe matches
  any whitespace run in the extracted text. String probes also match
  *literally* now (metacharacters escaped) — they are text to find, not
  patterns to compile; pass an explicit RegExp for regex semantics.

### Added
- **Regression test for the shrink-to-fit spill fix.** A tall-text fixture
  with a late-applying webfont (injected after `fonts.ready` and the
  height measurement, but before the print — the exact race that produced
  sliver second pages before v0.3.3) must still convert to exactly one
  page per section: boundary-height and oversized variants, plus an
  end-to-end three-section run. Pins the closed print→count→shrink loop so
  this bug class cannot return silently.

## [0.2.0] - 2026-09-28

### Fixed
- **Hyperlinks now survive the merge.** The pipeline previously embedded each
  printed page as an XObject (pdf-lib `embedPage`), which silently dropped all
  link annotations; pages are now copied directly (`copyPages`) and rescaled,
  keeping every link clickable. Covered by an annotation-asserting test.

### Added
- `outline` option / `--outline` flag: PDF bookmarks panel with one entry per
  section (titles from each section's first heading or data/aria labels).
- Metadata options `title` / `author` / `subject` (CLI: `--title`, `--author`);
  title defaults to the source document's `<title>`.
- Per-section titles flow through detection for outline naming.

### Known limitation
- The Producer field remains pdf-lib's (its `save()` hardcodes it); other
  metadata fields persist normally.

## [0.3.3] - 2026-09-29

### Changed
- ** Renamed the project to platen** (the press plate that meets the paper).
  npm's typosquat protection rejected the unscoped `aipdf` at publish time
  (too similar to `jspdf`), so the package ships as **`@blvckpanda/platen`**;
  the installed command is `platen` (`platen-ui` for the preview UI), and the
  repo lives at github.com/Blvckpanda/Platen. The Chromium override environment
  variable is now `PLATEN_CHROMIUM`; the acceptance runner's are
  `PLATEN_REAL_DECK` / `PLATEN_REAL_PROBE`.

### Fixed
- **Shrink-to-fit now actually holds its one page.** Open-loop scaling measured
  the section once and printed at the exact boundary scale; late font swaps
  (e.g. webfonts applied after measurement) and Chromium's print rounding
  spilled moderately-tall sections onto a sliver second page. Printing is now
  verified per section and the scale shrinks 10% per retry until the section
  fits — the one-page-per-section guarantee is enforced by the output, not the
  estimate.

### Added
- First npm publication: `npm install @blvckpanda/platen` / `npx @blvckpanda/platen` now installs from
  the registry. `package.json` gains `repository`, `homepage`, and `bugs`
  pointing at the GitHub repo (required for npm provenance).
- README: Release workflow badge, npm version + license badges, and a
  Screenshots section (social card, `platen ui` in action).
- `smoke:real` accepts any deck via `PLATEN_REAL_DECK` / `PLATEN_REAL_PROBE`.

## [0.3.1] - 2026-09-28

### Changed
- The real-deck acceptance runner (`npm run smoke:real`) is fully decoupled
  from any specific project: the deck path and probe text come from
  environment variables instead of hardcoded paths.

## [0.3.0] - 2026-09-28

### Added
- `--probe <text>` CLI flag: text that must appear on the last page (hit exits
  0, miss exits 1, missing value exits 2).
- `platen ui` (`bin/platen-ui.js`, `npm run ui`): zero-dependency local preview
  server — paste HTML or watch a file, per-section progress over SSE, result in
  the browser's native PDF viewer, live reload on save.
- Image-heavy email-variant test that runs on Linux CI (deterministic
  three-image 2000x1200 fixture, regenerable via
  `scripts/gen-image-fixture.mjs`).
- Release automation: `.github/workflows/release.yml` publishes on `v*` tags
  with provenance and attaches the tarball to a GitHub Release; the publish
  step skips cleanly while the `NPM_TOKEN` secret is unset.
- Launch assets: 1280x640 social card, animated before/after GIF, SHOW_HN
  draft; README upgraded with CI badge, quickstart, and an honest Limitations
  section.
- `PUBLISHING.md` and `CONTRIBUTING.md`.

## [Unreleased]

### Added
- `convert(input, options)` library API and `platen` CLI (in progress).
- Generic section detection: explicit selector → `section.page-section` →
  `[data-page]` / `[data-slide]` → `<section>`/`<article>` children of the main
  container → whole-document fallback, with a reported strategy + confidence.
- Clean-document cloning pipeline that defeats runtime-injected print CSS
  (`break-before/after: page`, `100vh` clamps, `@page` caps).
- Guaranteed one-section-per-page output with automatic shrink-to-fit scaling
  and centered vector merging (selectable text preserved).
- Email-optimized variant: in-DOM image downscaling (canvas JPEG) followed by
  section re-extraction, so the smaller variant actually embeds the smaller
  images.
- Self-verification: page count vs section count, zero spill pages, and
  arbitrary text probes on the last page.
