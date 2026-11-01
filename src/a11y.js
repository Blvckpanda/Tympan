/**
 * a11y.js — the accessibility half of `tympan lint` (SPEC §4 Phase 2).
 *
 * lint.js's diagnostics half answers "why does the PDF look wrong"; this
 * module answers "why would a screen reader or a low-vision reader fail on
 * the source". The checks are the ones a PDF inherits directly from the
 * HTML: a missing `lang`, images with no alt, form controls with no
 * accessible name, text under the WCAG contrast floor, a torn heading
 * outline, tables with no header, and link text that names nothing
 * (WCAG 1.1.1, 1.3.1, 1.4.3, 3.1.1, 4.1.2).
 *
 * Same contract as lint's audit:
 *   - `auditAccessibilityInPage` is serialized into page.evaluate by
 *     pipeline.js — DOM-only, no Node scope, no imports, one plain object
 *     out. Read-only, so lint stays safe to run on a document you are
 *     still deciding to convert.
 *   - `a11yFindings` is pure and I/O-free, unit-tested without Chromium.
 *   - Every list is capped and every cap leaves the TOTAL count in the
 *     audit, so a 400-image document cannot flood a log.
 *   - Findings are warnings/notes, never errors: they do not fail a build
 *     by default (lintExitCode is unchanged) — `--strict` promotes them.
 */

/**
 * Text under this ratio (1-21 scale) fails the WCAG 1.4.3 floor.
 */
export const CONTRAST_NORMAL = 4.5;
/** Large type (>= 24px, or >= 18.67px bold) needs less — WCAG's own floor. */
export const CONTRAST_LARGE = 3;

/** Text that names nothing; exempted when aria-label/title do name it. */
export const GENERIC_LINK_TEXT = new Set([
  'click here',
  'here',
  'read more',
  'learn more',
  'more',
  'this link',
  'link',
  'download',
  'doc',
  'pdf',
]);

/** Input types that never carry a label — their value is the name. */
const SELF_NAMED_INPUT = new Set(['button', 'submit', 'reset', 'hidden', 'image']);

/**
 * Audit the source document's accessibility, in the browser.
 *
 * One pass over the body; `getComputedStyle` per element is already what
 * lint's own audit pays, and the contrast check is folded into that pass.
 * Deterministic: document order everywhere, no Set→Array probabilism, all
 * findings same-page reproducible.
 * @returns {object} see a11yFindings for the consumed fields
 */
export function auditAccessibilityInPage() {
  const CAP = 12;
  // Literal, not module-scope: this fn is serialized into page.evaluate and
  // may reference NOTHING outside itself (AGENTS.md's in-page contract).
  const SELF_NAMED = ['button', 'submit', 'reset', 'hidden', 'image'];
  const GENERIC = new Set([
    'click here', 'here', 'read more', 'learn more', 'more',
    'this link', 'link', 'download', 'doc', 'pdf',
  ]);
  const CONTRAST_NORMAL_LIMIT = 4.5;
  const CONTRAST_LARGE_LIMIT = 3;
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/)[0]
      : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 60);
  };

  const htmlLang = document.documentElement.getAttribute('lang');
  const lang = htmlLang && htmlLang.trim() ? htmlLang.trim() : null;

  // WCAG 1.1.1: alt="" (deliberately empty) is correct for decorative
  // images; a MISSING attribute is the failure. Count total + capped list.
  const imageTotal = document.images.length;
  const missingAlt = [];
  let missingAltCount = 0;
  for (const img of Array.from(document.images)) {
    if (!img.hasAttribute('alt')) {
      missingAltCount++;
      if (missingAlt.length < CAP) {
        missingAlt.push({ src: img.currentSrc || img.src || '' });
      }
    }
  }

  // WCAG 1.3.1: a heading outline with a hole (h1 then h3) or no heading.
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  const headingTotal = headings.length;
  const headingSkips = [];
  let prev = 0;
  let h1Count = 0;
  for (const h of headings) {
    const level = Number(h.tagName.slice(1));
    if (level === 1) h1Count++;
    if (prev && level > prev + 1 && headingSkips.length < CAP) {
      headingSkips.push({ from: `h${prev}`, to: `h${level}` });
    }
    prev = level;
  }

  // WCAG 4.1.2: every control needs an accessible name — label[for],
  // a wrapping <label>, aria-label, aria-labelledby or a title.
  const controls = Array.from(document.querySelectorAll('input,select,textarea'));
  const labeled = (el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (SELF_NAMED.indexOf(type) !== -1) return true;
    if (el.getAttribute('aria-label') && el.getAttribute('aria-label').trim()) return true;
    const rel = el.getAttribute('aria-labelledby');
    if (rel) {
      for (const id of rel.split(/\s+/)) {
        const t = id && document.getElementById(id);
        if (t && t.textContent.trim()) return true;
      }
    }
    if (el.getAttribute('title') && el.getAttribute('title').trim()) return true;
    if (el.closest('label')) return true;
    const id = el.getAttribute('id');
    if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return true;
    return false;
  };
  const controlTotal = controls.length;
  const unlabeled = [];
  let unlabeledCount = 0;
  for (const el of controls) {
    if (!labeled(el)) {
      unlabeledCount++;
      if (unlabeled.length < CAP) unlabeled.push(describe(el));
    }
  }

  // WCAG 1.4.3: text under the contrast floor, measured the way the browser
  // actually paints — the text color composited over its nearest OPAQUE
  // ancestor background (alpha compositing, not just the element's own).
  const parseRgba = (col) => {
    const m = /^\s*rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)\s*$/.exec(col || '');
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const luminance = ({ r, g, b }) => {
    const lin = [r, g, b].map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const overWhite = { r: 255, g: 255, b: 255, a: 1 };
  // Composite `top` over `under` by its own alpha (WCAG text is painted, so
  // a translucent color's contrast is the contrast of what you SEE).
  const composite = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: Math.min(1, top.a + under.a * (1 - top.a)),
  });
  const ratio = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  // The effective background an element's text is painted over: walk UP the
  // ancestors compositing translucent backgrounds until one is opaque.
  const effectiveBackground = (el) => {
    let bg = null;
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parseRgba(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        bg = bg ? composite(bg, c) : c;
        if (bg.a >= 1) return bg;
      }
      node = node.parentElement;
    }
    // Never opaque: finish over the canvas (white for an unset background).
    return bg ? composite(bg, overWhite) : overWhite;
  };
  const lowContrast = [];
  let lowContrastCount = 0;
  let lowest = null;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // Direct text nodes only — containers count once per render site, so a
    // whole-page wrapper is not scored against its grandchildren's colors.
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.nodeValue.trim()
    );
    if (!hasText) continue;
    const fg = parseRgba(cs.color);
    if (!fg || fg.a === 0) continue;
    const size = parseFloat(cs.fontSize) || 16;
    const large = size >= 24 || (size >= 18.67 && Number(cs.fontWeight) >= 700);
    const floor = large ? CONTRAST_LARGE_LIMIT : CONTRAST_NORMAL_LIMIT;
    const bg = effectiveBackground(el);
    const cr = Math.round(ratio(composite(fg, bg), bg) * 100) / 100;
    if (cr < floor) {
      lowContrastCount++;
      if (!lowest || cr < lowest.ratio) lowest = { describe: describe(el), ratio: cr, large };
      if (lowContrast.length < CAP) {
        lowContrast.push({ el: describe(el), ratio: cr, large });
      }
    }
    if (lowContrastCount > 4000) break; // pathological page; the audit caps out
  }

  // WCAG 2.4.4: link text that names nothing ("click here"), when the
  // author did not give it an accessible name instead. Visible links only.
  const links = Array.from(document.querySelectorAll('a[href]'));
  const linkTotal = links.length;
  const genericLinks = [];
  let genericCount = 0;
  for (const a of links) {
    const cs = getComputedStyle(a);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (a.getAttribute('aria-label') && a.getAttribute('aria-label').trim()) continue;
    const text = (a.textContent || '').trim().toLowerCase();      if (GENERIC.has(text)) {
        genericCount++;
        if (genericLinks.length < CAP) genericLinks.push({ text: (a.textContent || '').trim() });
      }
  }

  // WCAG 1.3.1: a DATA table (more than one row) with no header row at all.
  const tables = Array.from(document.querySelectorAll('table'));
  const tableTotal = tables.length;
  const headerlessTables = [];
  let headerlessCount = 0;
  for (const t of tables) {
    if (t.rows.length <= 1) continue;
    const first = t.rows[0];
    const hasHeader =
      first.querySelector('th, [role="columnheader"], [scope], [headers]') !== null ||
      !!t.querySelector('thead');
    if (!hasHeader) {
      headerlessCount++;
      if (headerlessTables.length < CAP) headerlessTables.push(describe(t));
    }
  }

  return {
    lang,
    h1Count,
    headingTotal,
    headingSkips,
    imageTotal,
    missingAltCount,
    missingAlt,
    controlTotal,
    unlabeledCount,
    unlabeled,
    linkTotal,
    genericCount,
    genericLinks,
    tableTotal,
    headerlessCount,
    headerlessTables,
    lowContrastCount,
    lowestContrast: lowest,
    lowContrast,
  };
}

/**
 * The rule set: audit object -> findings, in lint.js's exact shape.
 * Warnings for the reader-blocking facts (no lang, no alt, unnamed
 * controls, contrast floor), notes for outline-quality judgement calls
 * (skips, no h1, generic link text, headerless tables).
 * @param {object} a11y auditAccessibilityInPage() output
 * @returns {Array<{rule, severity, message}>}
 */
export function a11yFindings(a11y) {
  const out = [];
  if (!a11y) return out;
  const finding = (rule, severity, message, extra = {}) =>
    ({ rule, severity, message, ...extra });

  if (!a11y.lang) {
    out.push(
      finding(
        'a11y-html-lang',
        'warning',
        'the html element carries no lang attribute — screen readers cannot pick a voice (WCAG 3.1.1)'
      )
    );
  }

  if (a11y.missingAltCount > 0) {
    const shown = (a11y.missingAlt || []).map((m) => m.src).filter(Boolean).slice(0, 3);
    out.push(
      finding(
        'a11y-img-alt',
        'warning',
        `${a11y.missingAltCount} image(s) carry no alt attribute —${shown.length ? ` e.g. ${shown[0]}` : ''} (alt="" is fine for decorative; nothing is not)`,
        { count: a11y.missingAltCount }
      )
    );
  }

  if (a11y.unlabeledCount > 0) {
    out.push(
      finding(
        'a11y-form-label',
        'warning',
        `${a11y.unlabeledCount} form control(s) have no label, aria-label or title — e.g. ${(a11y.unlabeled || [])[0] || '(unnamed)'}`,
        { count: a11y.unlabeledCount }
      )
    );
  }

  if (a11y.lowContrastCount > 0) {
    const low = a11y.lowestContrast;
    const who = low ? `${low.describe} at ${low.ratio}:1` : 'the lowest run was unnamed';
    const floor = low && low.large ? CONTRAST_LARGE : CONTRAST_NORMAL;
    out.push(
      finding(
        'a11y-contrast',
        'warning',
        `${a11y.lowContrastCount} text run(s) sit under the ${floor}:1 contrast floor — lowest: ${who} (WCAG 1.4.3)`,
        { count: a11y.lowContrastCount, lowest: low ? low.ratio : null }
      )
    );
  }

  if ((a11y.headingSkips || []).length) {
    const s = a11y.headingSkips[0];
    out.push(
      finding(
        'a11y-heading-order',
        'note',
        `the heading outline jumps ${s.from} -> ${s.to} — a heading level is skipped and the outline has a hole`,
        { count: a11y.headingSkips.length }
      )
    );
  }

  if (a11y.h1Count !== 1 && (a11y.headingTotal || 0) > 0) {
    out.push(
      finding(
        'a11y-heading-count',
        'note',
        a11y.h1Count === 0
          ? 'the document has headings but no h1 — the outline starts on a lower level'
          : `the document carries ${a11y.h1Count} h1 elements — one top heading is the usual shape`
      )
    );
  }
  if ((a11y.headingTotal || 0) === 0) {
    out.push(
      finding('a11y-no-headings', 'note', 'the document has no headings at all — PDF navigation rides on them')
    );
  }

  if (a11y.genericCount > 0) {
    const e = a11y.genericLinks || [];
    out.push(
      finding(
        'a11y-generic-link',
        'note',
        `${a11y.genericCount} link(s) say only generic text (e.g. "${(e[0] ? e[0].text : 'click here').trim().toLowerCase()}") — give the destination a name`,
        { count: a11y.genericCount }
      )
    );
  }

  if (a11y.headerlessCount > 0) {
    out.push(
      finding(
        'a11y-table-headers',
        'note',
        `${a11y.headerlessCount} table(s) have no header row at all — e.g. ${(a11y.headerlessTables || [])[0] || 'table'}`,
        { count: a11y.headerlessCount }
      )
    );
  }

  return out;
}
