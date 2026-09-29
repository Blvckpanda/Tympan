# tympan

[![CI](https://github.com/Blvckpanda/Tympan/actions/workflows/ci.yml/badge.svg)](https://github.com/Blvckpanda/Tympan/actions/workflows/ci.yml)
[![Release](https://github.com/Blvckpanda/Tympan/actions/workflows/release.yml/badge.svg)](https://github.com/Blvckpanda/Tympan/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@blvckpanda%2Ftympan)](https://www.npmjs.com/package/@blvckpanda/tympan)
[![MIT license](https://img.shields.io/npm/l/@blvckpanda%2Ftympan)](LICENSE)

**A deterministic, secure, fast HTML→PDF converter that produces verifiable
PDFs with zero configuration.** One semantic section per page, runtime
print-CSS defeated, self-verifying output — built for the single-file HTML
bundles AI assistants produce. The charter is [SPEC.md](SPEC.md); the
roadmap below is real and staged.

![tympan before/after](assets/before-after.gif)

Plain Playwright's `page.pdf()` prints whatever the page's print CSS says — which is
exactly what breaks AI HTML: runtime-injected `@media print` rules force page breaks
on every section, clamp covers to `100vh`, and cap pages with `@page` rules. tympan
defeats that pipeline instead of fighting it.

## Quickstart

```bash
npx @blvckpanda/tympan deck.html
# deck.pdf + deck-email.pdf, one section per page, links clickable, verified
```

Or install the `tympan` command globally:

```bash
npm install -g @blvckpanda/tympan
tympan deck.html
```

Preview it locally while you edit:

```bash
npm run ui        # or: npx -p @blvckpanda/tympan tympan-ui  (local server, live reload, PDF pane)
```

Library:

```js
import { convert } from '@blvckpanda/tympan';
const { master, email, detection, verification } = await convert('deck.html', {
  email: true,
  outline: true,
  probe: /www\.example\.city/,
});
if (!verification.ok) throw new Error('verification failed');
```

Requires Node ≥ 20 and a Chromium binary (`npx playwright install chromium`, or point
`TYMPAN_CHROMIUM` at any chrome executable).

## Why it wins

1. **Reproducible:** same input, same bytes — under the exact-pinned engine
   (after the v0.5 metadata/IDs pass, see the roadmap).
2. **Safe on untrusted HTML by default:** `file://` reads and private-IP
   fetches are blocked (v0.5). Loosening is explicit.
3. **Diagnostics that say exactly what broke:** per-section progress,
   page-count and probe verification, non-zero exit codes for CI.
4. **Correct output:** selectable text, clickable links, bookmarks outline,
   metadata — verified, not assumed.

And the principle under all of it: **never trust a measurement.** Sections
are printed, the artifact is inspected, and the scale shrinks until the
one-page invariant *holds* — late webfonts and print rounding can't produce
sliver pages. A regression test pins this ([test/spill.test.mjs](test/spill.test.mjs)).

## Screenshots

**tympan ui** — paste HTML or watch a local file, watch sections convert one by
one, read the result in the browser's native PDF viewer:

![tympan ui converting a three-section document](assets/tympan-ui.png)

The pitch as a card (also the repo's social preview — [1280×640](assets/social-card.png)):

<p align="center"><img src="assets/social-card.png" alt="tympan social card" width="560"></p>

## What it does

1. **Detects sections** in the rendered page: your `--selector`, then
   `section.page-section`, then `[data-page]`/`[data-slide]`, then
   `<section>`/`<article>` children of the widest main-ish container, then the whole
   document as one page.
2. **Builds a clean document** per section: static stylesheets only — no React
   runtime, no injected print CSS, no `@page` caps.
3. **Prints each section onto exactly one page**, shrinking just enough when a
   section is taller than the page (never spilling onto a sliver page).
4. **Merges centered** via pdf-lib — text stays selectable and **hyperlinks stay clickable**.
5. **Verifies** the result: page count === section count, last-page text probe,
   non-zero exit on any mismatch (CI-friendly).

## Options (CLI and library)

| Option | Default | Description |
|---|---|---|
| `selector` | auto-detect | Explicit CSS selector for sections |
| `email` | off | Also emit an image-downscaled variant (≤1600px JPEG q0.82) |
| `out` | `<input>.pdf` | Master output path |
| `probe` | none | Text (or regex source) that must appear on the last page |
| `format` | `a4` | `a4` or `letter` |
| `orientation` | `landscape` | `landscape` or `portrait` |
| `margin` | `0.4,0.5,0.4,0.5` | Page margins in inches: `N` or `T,R,B,L` (CLI) |
| `teaser` | none | Only convert the first N sections (CLI: `--teaser N`) |
| `outline` | off | PDF bookmarks panel — one entry per section (`--outline`) |
| `title` | source `<title>` | PDF metadata title |
| `author` | none | PDF metadata author |
| `verify` | `true` | Self-verification pass (`--no-verify` to skip) |

## How is this different from Playwright / Gotenberg / WeasyPrint?

| | Rendering engine | AI-HTML pagination | One section per page | Self-verifying |
|---|---|---|---|---|
| Playwright / Puppeteer | Chromium | whatever the page's print CSS dictates — often broken | no | no |
| Gotenberg | Chromium (Docker API) | same as Playwright | no | no |
| WeasyPrint / Dompdf | no JS — cannot render AI bundles at all | — | — | — |
| **tympan** | Chromium (via Playwright) | **defeats runtime print CSS by cloning each section into a clean document** | **guaranteed, with auto-shrink** | **built in, exit codes for CI** |

tympan is an opinionated *layer* on Chromium, not a new engine: the value is the
pipeline, not the renderer.

## Roadmap

The staged plan lives in [SPEC.md](SPEC.md) (phases §4, adoption decisions §10).
Where things stand:

- **Now (v0.4.x):** the reliable core — one section per page, closed-loop
  shrink-to-fit (regression-tested), links + outline + metadata, email
  variant, preview UI, self-verification with CI exit codes, tag-driven
  releases with provenance.
- **v0.5 — determinism & security:** fixed timestamps and IDs in the output,
  request interception (block `file://`, private/metadata IPs; offline mode),
  `--wait-for <selector>` / ready-signal waits, `doctor`, JSON output,
  presets + config file, batch mode.
- **v0.6+ — standards:** tagged PDF/PDF-UA, PDF/A, size optimization,
  `lint`, `test` (visual regression for CI).

Non-goals (from the spec): our own layout engine, a GUI, a general PDF
editor, Word/PowerPoint conversion, OCR, AI in the render path.

## Limitations (honest ones)

- The PDF **Producer** field stays `pdf-lib`'s — its `save()` hardcodes it. Title,
  author, and subject set via `--title`/`--author`/`--subject` persist normally.
- Content that lives **only** in print media CSS won't appear: the whole point is
  printing the screen composition with the app's runtime print CSS stripped out.
- Background images and graphics render fine (vector merge, `printBackground: on`);
  what's *not* preserved is print-only styling.
- One section = one page is a hard rule: an overfull section shrinks to fit rather
  than flowing onto a second page.
- Byte-identical output is a *goal* (v0.5), not yet a property: Chromium embeds
  varying IDs/timestamps until the post-process pass lands.

## Contributing & releasing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the test gates.
Releases are cut by version tags; the process lives in
[PUBLISHING.md](PUBLISHING.md). The social preview card is
[assets/social-card.png](assets/social-card.png) (1280×640).

## Status

v0.4.0 is on npm: full CLI, clickable links preserved through the merge, PDF
outline + metadata, the local preview UI, tag-driven release automation
with provenance, and the spec adopted as the project charter. See
[CHANGELOG](CHANGELOG.md) for history.

## License

[MIT](LICENSE)
