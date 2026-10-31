## Real deliverables: the layout-width fix, measured

The generated corpus above is synthetic. This section is the other half: three
real Kitch deliverables, converted before and after the 0.8.0 Phase 0 change
that capped the layout at the sheet's text column. Measured on the same machine,
same engine, same margins (A4 portrait, 0.4/0.5/0.4/0.5in → 698px column).

| document | layout before | pages | mean fill before | mean fill after | min fill before/after | page width scale before/after | bytes before/after |
|---|---|---|---|---|---|---|---|
| 01-brand-base.html | 774px | 11 → 11 | 35.2% | **39.6%** (+12.5% rel.) | 15.0% → 16.7% | 0.902 → **1.000** | 567,490 → 566,714 |
| 03-subscription-plans.html | 774px | 10 → 10 | 55.6% | **64.1%** (+15.3% rel.) | 15.0% → 16.7% | 0.902 → **1.000** | 426,415 → 424,050 |
| pot-counter.print.html | 774px | 4 → 4 | 26.8% | **31.9%** (+19.0% rel.) | 12.0% → 14.5% | 0.902 → **1.000** | 348,967 → 353,826 |

What the columns mean, and what they do not:

- **Page width scale 0.902 → 1.000** is the fix: every page used to be scaled to
  a 698px column because the layout was 774px. This is measured in the produced
  PDF, not inferred from the scale argument: the median glyph height on
  `03-subscription-plans` rose from **10.13pt to 11.24pt on every page that now
  prints at 1.0** (ratio 1.109, = 1/0.902). Page 6, which the narrower measure
  made taller than its sheet, lands at 10.05pt (0.894 × 11.24).
- **Page counts are identical** in all three documents. Nothing was reflowed
  onto extra sheets; the content that fit before still fits.
- **Byte deltas are small and structural**: the same pages, laid out at the
  authored scale. `pot-counter` grew 4.8KB because its text is now ~11% larger
  and so is its vector content, not because a page was added.
- **Two sections of `03` now shrink for height** (89% and 95%) where every page
  used to share one 90.2% scale. That is section layout doing its job under a
  narrower measure: those sections are taller than one page, and `--flow` is the
  fix for that, not this change. `tympan lint` reports it as `inconsistent-scale`
  — it did not say that before only because everything was uniformly scaled.
- **Fill is still far from full** (39–64%). The width fix recovers the 10% the
  scaling stole; it cannot fill a 1,045px sheet with a 400px section. That is
  the flow-layout work, and these numbers are its baseline.

Measured 2026-10-21, Windows 11, Node 24.18, Playwright 1.63.0 (pinned Chromium).

### The print-CSS claim, proved rather than asserted

`tympan lint` tells users tympan ignores a document's own print CSS. That was
false: the clean template copied the source's first `<style>` verbatim, so
`@media print` rules ran at print time. A fixture with
`@media print { .page-section { min-height: 2000px } }` failed with
`SPILL PAGES` on the pre-fix build even after six 10% shrink retries.

After stripping `@media print` and `@page` rules at the CSSOM, the same fixture
converts to 2 pages with per-page heights identical to an otherwise identical
control fixture (`test/layout-width.test.mjs`). `tympan lint`'s note about
source print CSS is now true, and a test keeps it true.

## The two open acceptance numbers, measured (2026-10-23)

The plan's §4 acceptance left two numbers unmet in flow mode: `01-brand-base`
printed a 9%-full page 6, and `03-subscription-plans` printed 8 sheets against
the ≤ 7 target. Both are now settled by measurement, not assertion.

**`01-brand-base`: the near-empty tail is real, and `--fill tight` closes it.**
Page 6 of the balanced run carries 102px: the source document's trailing
footer band (two text lines plus the running footer). Page 5 is genuinely full
(994/1045px), so the tail cannot join it and the sheet is the document's
remainder — not a pushed keep-together block and not a stranded heading.
`--fill tight`'s bounded ladder fixes it: at scale 0.98 the body fits 5
sheets, mean fill 96%, minimum 92%, and the tail page is gone. The ladder
reports its arithmetic (`fillPolicy.scaleApplied: 0.98`, attempts
`[{0.98: 5}, {0.97: 5}, {1: 6}]`); scale 1.0 keeps 6 pages at mean 81%,
minimum 10%. 0.98 wins the tie against 0.97 (fewest pages, larger scale).

**`03-subscription-plans`: 8 sheets is the floor while keep-together holds.**
Page 2 ends at 49% (513/1045px) because the "3. The two Office Pot plans"
heading — kept with its table by `break-after: avoid` — precedes the
CLASSIC/SIGNATURE comparison table, which is taller than the 532px slack and
carries `break-inside: avoid`, so heading and table move whole to sheet 3.
This is exactly the case §4 sanctions: "one page may legitimately end early
when a keep-together block (a table or figure) does not fit; the report must
name that block." The ladder cannot reach 7 either: at 0.97 the table is
still ~983px against ~547px of slack, so every candidate prints 8 pages and
the larger scale wins the tie. Splitting the table at a row boundary could
fill page 2's slack, but that trades the keep-together policy for one sheet —
recorded here as a deliberate non-fix. The ≤ 7 criterion was written from the
prototype's ink-coverage ruler (§12); under the shipped fill metric and the
keep-together policy, 8 sheets at mean 81% with one sanctioned early-ending
page is the correct result.

`--fill tight` is measured on both remaining documents, not just these two:
see the plan §12 table for balanced, and `docs/benchmarks.json` for the
corpus-wide numbers the generator produces.
