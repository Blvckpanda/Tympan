/**
 * lint.js — `tympan lint`: the diagnostics that explain a bad-looking PDF.
 *
 * Visibility, not judgement: the pipeline already measures every page before
 * it prints (metrics.js), but a number in a JSON field helps nobody sitting in
 * front of a half-empty PDF. This module turns those measurements, plus a
 * source-document audit, into named findings with a severity and a hint —
 * "page 3 is 33% full", "logo.png never loaded (file:// read blocked)".
 *
 * Two things it deliberately does NOT do:
 *   - It does not rasterize. Every finding comes from a DOM measurement or a
 *     computed geometry value, so lint is cheap, deterministic and free of
 *     the coverage-metric trap (a painted background reads as 100% full).
 *   - It does not fail a build by default. A sparse page is a finding, not a
 *     defect: covers, statement bands and full-bleed figures are meant to be
 *     sparse. Errors are reserved for output that is wrong (a lost image, no
 *     pages at all); `--strict` is how a caller promotes warnings.
 *
 * Everything except auditSourceInPage is pure and I/O-free, so the whole rule
 * set is unit-tested without Chromium.
 */

/** Severity ranking; higher wins when a report is summarized. */
export const SEVERITY_RANK = { error: 3, warning: 2, note: 1 };

/**
 * Scale below which a shrink is reported as a warning rather than a note.
 * 0.9 is where "a bit smaller" becomes "visibly smaller than the page before
 * it" — the non-monotonic typography the pagination mission exists to fix.
 */
export const SCALE_WARN = 0.9;

/** Scales differing by more than this across pages count as inconsistent. */
export const SCALE_SPREAD = 0.05;

/** Cap on findings of one rule, so a 400-image document cannot flood a log. */
export const MAX_FINDINGS_PER_RULE = 8;

/**
 * Flow-mode fill floor, below which a page is a remnant sheet, not a
 * deliberately sparse page. Section mode can exonerate a sparse cover with
 * `targetFill: 0`; flow cannot — its fill policy is the mode itself, so a
 * sheet that stands almost empty is a break decision Chromium made, and the
 * report should say so at any target.
 */
export const FLOW_MIN_FILL = 0.1;

const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
/**
 * Fill percentage rounded DOWN, for messages that compare against a floor:
 * round-off must never display a value AT or above the floor it was judged
 * below (0.098 fill printed as "10% full — below the 10% flow floor" until
 * this helper existed).
 */
const pctFloor = (n) => `${Math.floor((Number(n) || 0) * 100)}%`;

/** One finding, with the fields every consumer (CLI, JSON, tests) shares. */
function finding(rule, severity, message, extra = {}) {
  return { rule, severity, message, ...extra };
}

/**
 * Is this lint run judging flow-mode output?
 *
 * An explicit `layout` wins (the CLI wires the conversion result's own
 * `layout` through). Without one, the pages are the evidence: the pipeline
 * stamps every PDF-measured flow page with `measuredFrom: 'pdf'`, a mark a
 * section-mode page is never given — its numbers come from the DOM.
 * @param {object} ctx
 * @returns {boolean}
 */
export function flowOutput(ctx) {
  if (ctx.layout === 'flow') return true;
  if (ctx.layout === 'section') return false;
  const pages = Array.isArray(ctx.pages) ? ctx.pages : [];
  return pages.some((p) => p && p.measuredFrom === 'pdf');
}

/**
 * Rule 1-7: the page records and the document geometry.
 * @param {object} ctx see lintDocument
 * @returns {Array<object>} findings
 */
function pageFindings(ctx) {
  const out = [];
  // 0 is a real value, not a missing one: it turns the fill rule off, which is
  // what a deliberately sparse deck (full-bleed pages) needs.
  // null is not 0: only an explicit 0 turns the rule off. Number(null) is 0
  // and finite, so a null target used to slip past the default as target 0,
  // silently disabling the underfilled rule; undefined stays the 0.7 default.
  const asked = ctx.targetFill == null ? NaN : Number(ctx.targetFill);
  const target = Number.isFinite(asked) ? asked : 0.7;
  const pages = Array.isArray(ctx.pages) ? ctx.pages : [];
  const flow = flowOutput(ctx);

  for (const p of pages) {
    const label = `page ${p.index}`;
    // Flow output is judged by the flow rules further down, not by the
    // section rules: the 0.7 target answers "did this section fill its sole
    // sheet?" — a question flow's sections cannot answer, because they share
    // sheets, and a heading flag there is a PDF-text-layer heuristic, not the
    // DOM fact section mode measures.
    if (!flow && p.fillRatio < target) {
      out.push(
        finding(
          'page-underfilled',
          'warning',
          `${label} is ${pct(p.fillRatio)} full — ${Math.round(p.blankTailPx)}px of blank sheet below the content`,
          { page: p.index, fillRatio: p.fillRatio, blankTailPx: p.blankTailPx, sectionId: p.sectionId }
        )
      );
    }
    if (!flow && p.strandedHeading) {
      out.push(
        finding(
          'stranded-heading',
          'warning',
          `${label} ends on a heading — its section starts on the next sheet, so the reader turns the page to find the content`,
          { page: p.index, sectionId: p.sectionId }
        )
      );
    }
    if (p.keptTogether === false) {
      out.push(
        finding(
          'split-keep-together',
          'warning',
          `${label} splits a block that must not be split (table row or figure)`,
          { page: p.index, sectionId: p.sectionId }
        )
      );
    }
    // Only a shrink the HEIGHT forced costs type size: that is the page whose
    // section was too tall. A shrink the width bound caused is a property of
    // the whole document (rule `column-narrower-than-layout` below), and
    // repeating it per page buries the real finding — measured on the Kitch
    // deck, where one width mismatch produced nine identical warnings.
    const scaledFor = p.scaledFor ?? (p.scaleApplied < 1 ? 'height' : 'none');
    if (scaledFor === 'height') {
      const sev = p.scaleApplied < SCALE_WARN ? 'warning' : 'note';
      out.push(
        finding(
          'page-scaled',
          sev,
          `${label} was scaled to ${pct(p.scaleApplied)} to fit — its section is taller than the text area, so its type renders smaller than a page that fit`,
          { page: p.index, scaleApplied: p.scaleApplied, sectionId: p.sectionId }
        )
      );
    }
  }

  // A page that had to shrink for width MORE than its siblings has content
  // wider than the column: an unbreakable table, an oversized figure. Named
  // per page, because here the page really is different from the rest.
  const widthBound = pages.filter((p) => p.scaledFor === 'width' && p.widthScale < 1);
  if (widthBound.length) {
    const baseline = Math.max(...widthBound.map((p) => p.widthScale));
    for (const p of widthBound) {
      if (p.widthScale >= baseline - 0.005) continue;
      out.push(
        finding(
          'content-overflow',
          'warning',
          `page ${p.index}'s content is wider than the text column (scaled to ${pct(p.widthScale)}) — a wide table, figure or unbreakable row cannot fit the sheet`,
          { page: p.index, widthScale: p.widthScale, sectionId: p.sectionId }
        )
      );
    }
  }

  const scales = pages.filter((p) => p.scaledFor === 'height').map((p) => p.scaleApplied);
  if (scales.length > 1 && Math.max(...scales) - Math.min(...scales) > SCALE_SPREAD) {
    out.push(
      finding(
        'inconsistent-scale',
        'warning',
        `type size varies between pages: this document shrinks ${pct(Math.min(...scales))}–${pct(Math.max(...scales))} across ${scales.length} sheets`,
        { scales: scales.map((s) => Math.round(s * 1000) / 1000) }
      )
    );
  }

  // The column tympan prints into is narrower than the width the document was
  // laid out at, so Chromium scales EVERY page to fit it. Measured, not
  // asserted: resolved geometry on both sides, no rendering required.
  //
  // Since 0.8 the layout width is CAPPED at the column when geometry is
  // resolved (clampContentWidth), so this rule is an invariant check and can
  // only fire for a caller that assembled its own geometry — a layout wider
  // than the column is a bug in the pipeline, not a property of the document.
  // Before 0.8 it fired on every page of the Kitch deck (774px layout, 698px
  // column), which was really tympan measuring its own viewport.
  const geo = ctx.geometry || {};
  const layoutPx = Number(ctx.layoutWidthPx ?? geo.contentW);
  const columnPx = Number(geo.columnW) > 0
    ? Number(geo.columnW)
    : Number(geo.W_IN) > 0
      ? (geo.W_IN - (geo.margins?.left || 0) - (geo.margins?.right || 0)) * 96
      : NaN;
  if (Number.isFinite(layoutPx) && Number.isFinite(columnPx) && columnPx > 0 && layoutPx > columnPx * 1.01) {
    const column = Math.round(columnPx);
    out.push(
      finding(
        'column-narrower-than-layout',
        'warning',
        `the document lays out at ${Math.round(layoutPx)}px but prints into a ${column}px column: every page is scaled to ${pct(columnPx / layoutPx)} and type renders ${pct(1 - columnPx / layoutPx)} smaller than authored`,
        {
          layoutWidthPx: Math.round(layoutPx),
          columnWidthPx: column,
          // The two fixes, in the order that keeps the design intact: lay the
          // document out at the column width, or give it a wider sheet.
          hint: `lay the document out at ${column}px, or print to a wider sheet (landscape gives ${Math.round((11.69 - (geo.margins?.left || 0) - (geo.margins?.right || 0)) * 96)}px) so nothing has to scale`,
        }
      )
    );
  }

  // The document asked for a wider measure than the paper has, so it was laid
  // out at the column instead of being scaled down to fit. Named as a note,
  // because it is a deliberate change to the author's design and the remedy
  // (a wider sheet, or smaller side margins) belongs to them.
  const requestedPx = Number(ctx.requestedLayoutWidthPx);
  if (
    Number.isFinite(requestedPx) &&
    Number.isFinite(columnPx) &&
    columnPx > 0 &&
    requestedPx > columnPx * 1.01
  ) {
    out.push(
      finding(
        'content-width-clamped',
        'note',
        `the document lays out at ${Math.round(requestedPx)}px; it prints at a ${Math.round(columnPx)}px column so nothing is scaled (type stays its authored size) — print to a wider sheet or reduce side margins for a wider measure`,
        { requestedWidthPx: Math.round(requestedPx), columnWidthPx: Math.round(columnPx) }
      )
    );
  }

  // Flow-mode rules: measured from the produced PDF's text layer, not the
  // DOM, so each finding names its provenance rather than borrowing the
  // precision section mode's DOM measurements earn.
  if (flow) {
    for (const p of pages) {
      const label = `page ${p.index}`;
      const stranded = p.strandedHeading || p.lastBlockKind === 'heading';
      if (stranded) {
        out.push(
          finding(
            'flow-stranded-heading',
            'warning',
            `${label} ends on heading-sized text (PDF text layer) — its body flowed to the next sheet, leaving this one without its section`,
            { page: p.index, lastBlockKind: p.lastBlockKind ?? null, measuredFrom: 'pdf' }
          )
        );
      }
      // Below the 10% floor regardless of targetFill: a remnant sheet (a
      // widow, or a keep-together block Chromium could not place) is a break
      // decision, not a stylistic sparse page like a cover is.
      if (p.fillRatio < FLOW_MIN_FILL) {
        out.push(            finding(
              'flow-near-empty',
              'warning',
              `${label} is ${pctFloor(p.fillRatio)} full (${Math.round(p.blankTailPx)}px blank) — below the ${pct(FLOW_MIN_FILL)} flow floor; a widow or an unbreakable block forced this sheet to stand almost empty`,
              { page: p.index, fillRatio: p.fillRatio, blankTailPx: p.blankTailPx, measuredFrom: 'pdf' }
            )
          );
      }
    }
  }

  if (pages.length === 0) {
    out.push(finding('no-pages', 'error', 'no pages were produced — nothing to inspect'));
  }
  return out;
}

/**
 * Rule 8-10: what the document asked for and did not get.
 * @param {object} ctx
 * @returns {Array<object>}
 */
function assetFindings(ctx) {
  const out = [];
  const audit = ctx.audit || {};
  // Prefer the per-page measurement (that is the PDF's own layout); fall back
  // to the source page's list, which is all we know when the printed sections
  // dropped the reference before it could fail a second time.
  const broken = Array.isArray(audit.brokenImages) && audit.brokenImages.length
    ? audit.brokenImages
    : (Array.isArray(audit.sourceBrokenImages) ? audit.sourceBrokenImages : []);
  for (const img of broken.slice(0, MAX_FINDINGS_PER_RULE)) {
    out.push(
      finding(
        'broken-asset',
        'error',
        `image ${shortSrc(img.src)} did not load — the PDF is missing it (printed as blank space)`,
        { src: img.src ?? null, page: img.page ?? null }
      )
    );
  }
  if (broken.length > MAX_FINDINGS_PER_RULE) {
    out.push(
      finding('broken-asset', 'error', `and ${broken.length - MAX_FINDINGS_PER_RULE} more image(s) did not load`, {
        count: broken.length,
      })
    );
  }

  const blocked = Array.isArray(audit.blockedRequests) ? audit.blockedRequests : [];
  const byReason = new Map();
  for (const b of blocked) {
    const reason = b.reason || 'blocked';
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(b.url);
  }
  for (const [reason, urls] of byReason) {
    out.push(
      finding(
        'blocked-request',
        'warning',
        `${urls.length} request(s) blocked (${reason}) — e.g. ${shortSrc(urls[0])}; the PDF does not include them`,
        { reason, count: urls.length, urls: urls.slice(0, 3) }
      )
    );
  }

  const css = audit.printCss || {};
  const mediaPrint = Number(css.mediaPrint) || 0;
  const pageRules = Number(css.pageRules) || 0;
  if (mediaPrint > 0 || pageRules > 0) {
    out.push(
      finding(
        'print-css-in-source',
        'note',
        `the source carries its own print CSS (${mediaPrint} @media print block(s), ${pageRules} @page rule(s)) — tympan ignores it by design, so this PDF is not the browser's Ctrl-P output`,
        { mediaPrint, pageRules }
      )
    );
  }
  return out;
}

/**
 * Rule 11-13: the layout the print engine cannot honour faithfully.
 * @param {object} ctx
 * @returns {Array<object>}
 */
function layoutHazards(ctx) {
  const out = [];
  const audit = ctx.audit || {};
  const fixed = Array.isArray(audit.fixedElements) ? audit.fixedElements : [];
  if (fixed.length) {
    out.push(
      finding(
        'fixed-position',
        'warning',
        `${fixed.length} position:fixed element(s) — a fixed header or bar prints on the sheet it happened to be over, not on every page`,
        { elements: fixed.slice(0, 3), count: fixed.length }
      )
    );
  }
  const clamps = Array.isArray(audit.viewportClamps) ? audit.viewportClamps : [];
  if (clamps.length) {
    out.push(
      finding(
        'viewport-clamp',
        'warning',
        `${clamps.length} block(s) are sized to the viewport (vh), not to the page — they are taller than the sheet they print on`,
        { elements: clamps.slice(0, 3), count: clamps.length }
      )
    );
  }
  return out;
}

/**
 * Run every rule over one document's measurements.
 *
 * @param {object} ctx
 *   input?: string                 display name for the document
 *   pages?: Array<object>          judged page records (metrics.js)
 *   quality?: object               summarizeQuality() rollup
 *   geometry?: object              resolveGeometry() output (W_IN, margins, contentW)
 *   layoutWidthPx?: number         width the source was laid out at
 *   requestedLayoutWidthPx?: number width the source ASKED for (before the
 *                                  column cap)
 *   audit?: object                 source audit (printCss, brokenImages,
 *                                  blockedRequests, fixedElements, viewportClamps)
 *   targetFill?: number            fill threshold for page-underfilled
 *   layout?: 'section'|'flow'      the output's print mode. Flow pages are
 *                                  judged by the flow rules (flow-near-empty,
 *                                  flow-stranded-heading); left out, the
 *                                  mode is inferred from pages carrying
 *                                  `measuredFrom: 'pdf'`.
 * @returns {{input: string|null, ok: boolean, findings: Array<object>,
 *   errors: number, warnings: number, notes: number, quality: object|null}}
 */
export function lintDocument(ctx = {}) {
  const findings = [...pageFindings(ctx), ...assetFindings(ctx), ...layoutHazards(ctx)];
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  const errors = count('error');
  return {
    input: ctx.input ?? null,
    ok: errors === 0,
    findings,
    errors,
    warnings: count('warning'),
    notes: count('note'),
    quality: ctx.quality ?? null,
  };
}

/**
 * A document that could not be converted at all, in the same shape as a lint
 * report — so a batch that half-fails still accounts for every input instead
 * of quietly linting the ones that worked.
 * @param {string} input
 * @param {string} message
 * @returns {object} lint report
 */
export function failureReport(input, message) {
  return {
    input,
    ok: false,
    findings: [finding('conversion-failed', 'error', message || 'conversion failed')],
    errors: 1,
    warnings: 0,
    notes: 0,
    quality: null,
  };
}

/**
 * Totals across a lint run (the `--json` summary line).
 * @param {Array<object>} reports lintDocument() results
 * @returns {{errors: number, warnings: number, notes: number, ok: boolean}}
 */
export function summarizeLint(reports) {
  const list = reports || [];
  const errors = list.reduce((n, r) => n + (r.errors || 0), 0);
  const warnings = list.reduce((n, r) => n + (r.warnings || 0), 0);
  const notes = list.reduce((n, r) => n + (r.notes || 0), 0);
  return { errors, warnings, notes, ok: errors === 0 };
}

/**
 * Exit code for a lint run: 0 clean, 1 findings that matter.
 * Errors always fail; `--strict` is how a caller asks for warnings to fail
 * too (the default keeps a legitimately sparse cover from breaking CI).
 * @param {Array<object>} reports lintDocument() results
 * @param {object} [opts] { strict }
 * @returns {0|1}
 */
export function lintExitCode(reports, opts = {}) {
  const bad = (reports || []).some(
    (r) => r.errors > 0 || (opts.strict && (r.warnings > 0 || r.notes > 0))
  );
  return bad ? 1 : 0;
}

/** Trim a URL/src to something a terminal line can hold. */
export function shortSrc(src) {
  const s = String(src ?? '');
  if (s.length <= 64) return s;
  return '...' + s.slice(s.length - 61);
}

/**
 * Human-readable lint report. Pure: the CLI prints it, tests assert on it.
 * @param {Array<object>} reports lintDocument() results
 * @param {object} [opts] { qualityLine?: (q) => string }
 * @returns {string}
 */
export function formatLintReport(reports, opts = {}) {
  const lines = [];
  for (const r of reports) {
    const mark = r.errors ? '[FAIL]' : r.warnings ? '[warn]' : '[ok]';
    lines.push(`${mark} ${r.input ?? '(unknown input)'}`);
    if (opts.qualityLine && r.quality) lines.push(`     ${opts.qualityLine(r.quality)}`);
    const order = { error: 0, warning: 1, note: 2 };
    for (const f of [...r.findings].sort((a, b) => order[a.severity] - order[b.severity])) {
      lines.push(`     ${f.severity.padEnd(7)} ${f.rule}: ${f.message}`);
    }
  }
  const withFindings = reports.filter((r) => r.findings.length).length;
  const errs = reports.reduce((n, r) => n + r.errors, 0);
  const warns = reports.reduce((n, r) => n + r.warnings, 0);
  lines.push(
    `tympan lint: ${reports.length} document(s), ${errs} error(s), ${warns} warning(s)` +
      (reports.length - withFindings ? `, ${reports.length - withFindings} clean` : '')
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * In-page audit — serialized into page.evaluate by pipeline.js, so it
 * carries no Node scope: one serializable argument, one plain object out.
 * ------------------------------------------------------------------ */

/**
 * Audit the source document for the things that make a PDF differ from what
 * the reader sees in the browser.
 *
 * Read-only by contract: lint must be safe to run on a document you are still
 * deciding to convert. Every count is capped — a 4000-element page must not
 * serialize a megabyte back into Node.
 * @returns {{printCss: {mediaPrint: number, pageRules: number, sheets: number,
 *   unreadableSheets: number}, fixedElements: string[], viewportClamps: string[],
 *   brokenImages: Array<{src: string, alt: string}>, imageCount: number}}
 */
export function auditSourceInPage() {
  const CAP = 12;
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 60);
  };

  // Print CSS is read through the CSSOM, never by regex over the HTML: a
  // regex reports rules the browser dropped, and misses rules injected at
  // runtime — the exact CSS tympan exists to defeat.
  const printCss = { mediaPrint: 0, pageRules: 0, sheets: 0, unreadableSheets: 0 };
  const MEDIA = 4;
  const PAGE = 6;
  const GROUP = [12, 7]; // SUPPORTS_RULE = 12, LAYER_BLOCK = 7 (ignored if absent)
  const walk = (rules, depth) => {
    if (!rules || depth > 6) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const t = rule.type;
      if (t === MEDIA) {
        let cond = '';
        try {
          cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
        } catch (e) { /* detached rule */ }
        if (/print/i.test(cond)) printCss.mediaPrint++;
        try { walk(rule.cssRules, depth + 1); } catch (e) { /* ignore */ }
      } else if (t === PAGE) {
        printCss.pageRules++;
      } else if (GROUP.includes(t)) {
        try { walk(rule.cssRules, depth + 1); } catch (e) { /* ignore */ }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    printCss.sheets++;
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      printCss.unreadableSheets++; // cross-origin stylesheet: real, and unnamed
      continue;
    }
    walk(rules, 0);
  }

  const fixedElements = [];
  const viewportClamps = [];
  const vh = window.innerHeight || 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed' && fixedElements.length < CAP) {
      fixedElements.push(describe(el));
      continue;
    }
    if (viewportClamps.length >= CAP || !vh) continue;
    const declaresVh = /vh/.test(cs.height || '') || /vh/.test(cs.minHeight || '');
    if (!declaresVh) continue;
    const r = el.getBoundingClientRect();
    // A block that fills the viewport is the print hazard: on paper it is
    // taller than the sheet, so it lands alone and pushes everything down.
    if (r.height >= vh * 0.95) viewportClamps.push(describe(el));
  }

  const brokenImages = [];
  const images = Array.from(document.images);
  for (const img of images) {
    if (img.complete && img.naturalWidth === 0 && brokenImages.length < CAP) {
      brokenImages.push({ src: img.currentSrc || img.src || '', alt: img.alt || '' });
    }
  }
  return { printCss, fixedElements, viewportClamps, brokenImages, imageCount: images.length };
}
