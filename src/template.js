/**
 * template.js — clean-document builder.
 *
 * The trick that makes tympan work where raw Playwright fails: AI bundles
 * inject print CSS at runtime (`break-before/after: page`, `100vh` clamps,
 * `@page` caps). Rendering the original document always fragments. Instead,
 * each section is printed from a fresh minimal document that carries only:
 *   - the page's stylesheets (first head <style>, any <body>-level <style>
 *     tags — runtime-injected styles live there — plus head <link>s)
 *   - the source's own page background (html/body computed color), so a
 *     dark document converts to a dark PDF instead of a white one
 *   - a margin reset + a centered content column at the source's own width
 * No framework runtime, no injected print CSS, no @page rules.
 */

/**
 * Width the SOURCE document is rendered at while tympan measures it
 * (landscape @96dpi). Deliberately independent of the print column: laying a
 * 1026px deck out at a 698px viewport would trip its tablet media queries
 * during detection, so the page you measure is not the page you print.
 */
export const CONTENT_W = 1026;

/** Source-load width for portrait documents (@96dpi). */
export const PORTRAIT_CONTENT_W = 774;

/** Fallback width of the centered content column when detection finds nothing. */
export const DEFAULT_CONTENT_MAX_WIDTH = 870;

/** Clamp for the source-load viewport width (px) — never the print width. */
export const LOAD_WIDTH_MIN = 700;
export const LOAD_WIDTH_MAX = 1100;

/** Narrowest layout tympan will print into (px) before it is not a page. */
export const CONTENT_WIDTH_MIN = 320;

/**
 * Serialized into page.evaluate by pipeline.js: measure the source page's
 * effective background and its content width in one visit.
 * Background: the first non-transparent computed background-color walking
 * body -> html; transparent on both means the UA default (white).
 * Width: the content container's max-width (or laid-out width), falling
 * back to `fallbackWidth`.
 * @param {number} fallbackWidth
 * @returns {{background: string, contentWidth: number}}
 */
export function measurePageBackgroundAndWidth(fallbackWidth) {
  const isTransparent = (c) =>
    !c || c === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
  let background = '#ffffff';
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    const color = cs.backgroundColor;
    if (color && !isTransparent(color)) {
      // alpha < 1 over an ancestor still needs the ancestor behind it; the
      // clean doc stacks the same colors, so carry both when layered.
      background = color;
      break;
    }
    const img = cs.backgroundImage;
    if (img && img !== 'none') {
      // Gradient/pattern pages: carry the declaration so the print matches.
      background = img;
      break;
    }
  }
  // A semi-transparent body color must sit on the html color, not white:
  // when the chosen color has alpha and the other element has a solid one,
  // layer them the way the source browser would.
  const bodyC = document.body && getComputedStyle(document.body).backgroundColor;
  const htmlC = document.documentElement && getComputedStyle(document.documentElement).backgroundColor;
  const solid = (c) => c && !isTransparent(c) && !/rgba\([^)]*,\s*0(\.0+)?\s*\)/.test(c);
  const alpha = (c) => {
    const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(c || '');
    return m ? parseFloat(m[1]) : 1;
  };
  if (background === bodyC && bodyC && alpha(bodyC) < 1 && solid(htmlC)) {
    background = `linear-gradient(${htmlC}, ${htmlC}), ${bodyC}`;
  }

  // Content width: same heuristic as detectContentMaxWidthInPage, plus the
  // hero/body-level fallback for landing-style documents.
  const candidates = Array.from(
    document.querySelectorAll('main, [role="main"], body > div')
  );
  let best = null;
  for (const el of candidates) {
    const kids = el.querySelectorAll('section, article, [data-page], [data-slide]').length;
    if (!best || kids > best.kids) best = { el, kids };
  }
  let contentWidth = fallbackWidth;
  if (best) {
    const cs = getComputedStyle(best.el);
    const mw = parseFloat(cs.maxWidth);
    if (cs.maxWidth && cs.maxWidth !== 'none' && Number.isFinite(mw) && mw > 0) {
      contentWidth = Math.round(mw);
    } else {
      const w = best.el.getBoundingClientRect().width;
      if (Number.isFinite(w) && w > 0) contentWidth = Math.round(w);
    }
  }
  return { background, contentWidth };
}

/**
 * Clamp the SOURCE-LOAD viewport width. Not the print width: the page tympan
 * measures is rendered at a desktop-ish width on purpose (see CONTENT_W), and
 * only `clampContentWidth` decides how wide the printed column lays out.
 * @param {number} w
 * @returns {number}
 */
export function clampLoadWidth(w) {
  if (!Number.isFinite(w) || w <= 0) return PORTRAIT_CONTENT_W;
  return Math.round(Math.min(LOAD_WIDTH_MAX, Math.max(LOAD_WIDTH_MIN, w)));
}

/**
 * Clamp the PRINT layout width to the sheet's own text column.
 *
 * This is the fix for the silent 0.902 scale: a document authored at 774px was
 * printed into A4's 698px column, so Chromium scaled every page to fit and the
 * type rendered 10% smaller than authored. The column is a property of the
 * paper and the margins, so it is a CEILING, not a suggestion — `--content-width`
 * can narrow the layout, never widen it past what the paper can hold.
 *
 * @param {number} w requested layout width (px), typically detected from the source
 * @param {number} columnPx the printable column, `(W_IN - left - right) * 96`
 * @returns {number} px, 320..columnPx
 */
export function clampContentWidth(w, columnPx) {
  const column = Number.isFinite(columnPx) && columnPx > 0 ? columnPx : PORTRAIT_CONTENT_W;
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return Math.round(column);
  return Math.round(Math.min(column, Math.max(CONTENT_WIDTH_MIN, n)));
}

/**
 * Serialized into page.evaluate by pipeline.js. Builds the clean-document
 * shell; `maxWidthPx` sizes the centered content column and `background`
 * paints html/body with the source's own page background.
 * (Playwright evaluate passes exactly one serializable argument, so this
 * takes a single options object.)
 * @param {{maxWidthPx: number, background?: string}} opts
 */
export function buildCleanTemplate({ maxWidthPx, background }) {
  // Fallback must be a literal: this function is serialized into the browser
  // and cannot see Node-module constants.
  const max = Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? Math.round(maxWidthPx) : 870;
  const doc = document.implementation.createHTMLDocument('tympan');

  // The source's print CSS must NOT travel into the print template.
  //
  // This used to copy the first head <style> verbatim, which meant a document
  // that ships `@media print { section { break-before: page } }` or
  // `@page { margin: 0 }` had those rules applied by Chromium at print time —
  // while `tympan lint` told the user tympan ignored print CSS "by design".
  // Proved 2026-10-21 with a print-only `min-height: 2000px`: the section
  // spilled onto two pages even after six 10% shrink retries.
  //
  // Read through the CSSOM, never a regex over the CSS text: a regex misreads
  // comments, strings and nested blocks, and drops nothing a browser kept.
  const MEDIA_RULE = 4;
  const PAGE_RULE = 6;
  const LAYER_RULE = 7;
  const SUPPORTS_RULE = 12;
  const serialiseScreenRules = (rules, depth) => {
    let out = '';
    if (!rules || depth > 8) return out;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const type = rule.type;
      if (type === PAGE_RULE) continue; // @page never applies to a clean template
      if (type === MEDIA_RULE) {
        let condition = '';
        try {
          condition = rule.conditionText || (rule.media && rule.media.mediaText) || '';
        } catch (e) {
          continue;
        }
        // A media LIST can mix types (`@media print, screen`): drop the print
        // queries, keep the rest instead of discarding the whole block.
        const queries = String(condition).split(',').map((q) => q.trim()).filter(Boolean);
        const kept = queries.filter((q) => !/^(only\s+)?print(\s|$)/i.test(q));
        if (!kept.length) continue; // print-only block: dropped entirely
        const inner = serialiseScreenRules(rule.cssRules, depth + 1);
        if (inner.trim()) out += '@media ' + kept.join(', ') + '{' + inner + '}';
        continue;
      }
      if (type === SUPPORTS_RULE || type === LAYER_RULE) {
        let inner = '';
        try {
          inner = serialiseScreenRules(rule.cssRules, depth + 1);
        } catch (e) {
          inner = '';
        }
        if (!inner.trim()) continue;
        if (type === SUPPORTS_RULE) out += '@supports ' + (rule.conditionText || '') + '{' + inner + '}';
        else out += '@layer' + (rule.name ? ' ' + rule.name : '') + '{' + inner + '}';
        continue;
      }
      out += rule.cssText;
    }
    return out;
  };
  const withoutPrintRules = (cssText) => {
    const src = String(cssText || '');
    // Fast path: most styles carry no print media at all, and reparsing one
    // costs a full CSSOM round-trip per <style> on every template build.
    if (!/@page|print/i.test(src)) return src;
    const probe = document.createElement('style');
    probe.textContent = src;
    document.head.appendChild(probe);
    try {
      if (!probe.sheet) return src;
      return serialiseScreenRules(probe.sheet.cssRules, 0);
    } catch (e) {
      return src; // unreadable sheet: keep the design rather than lose it
    } finally {
      probe.remove();
    }
  };

  // EVERY head style, in document order — not just the first. A second head
  // <style> is where frameworks put their overrides, and dropping it silently
  // un-styled half the document.
  for (const st of Array.from(document.querySelectorAll('head style'))) {
    const cleaned = withoutPrintRules(st.textContent);
    if (!cleaned.trim()) continue;
    const clone = document.createElement('style');
    clone.textContent = cleaned;
    doc.head.appendChild(clone);
  }

  // Runtime/AI bundles inject <style> tags into <body>; without these the
  // extracted sections lose their styling entirely.
  for (const st of Array.from(document.body.querySelectorAll('style'))) {
    const cleaned = withoutPrintRules(st.textContent);
    if (!cleaned.trim()) continue;
    const clone = document.createElement('style');
    clone.textContent = cleaned;
    doc.head.appendChild(clone);
  }

  const links = Array.from(document.querySelectorAll('head link[rel="stylesheet"]'));
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const clone = document.createElement('link');
      clone.rel = 'stylesheet';
      clone.setAttribute('href', new URL(href, location.href).href);
      doc.head.appendChild(clone);
    } catch (e) { /* skip unresolvable href */ }
  }

  const main = document.createElement('main');
  doc.body.appendChild(main);

  // Reset + center + carry the source's own page background. body inherits
  // so section-level rgba fills layer over the same base as in the source.
  const bg = (background && String(background).trim()) || '#ffffff';
  const reset = document.createElement('style');
  reset.textContent = 'html,body{margin:0;padding:0} '
    + 'html{background:' + bg + '} '
    + 'body{background:inherit} '
    + 'main{margin:0 auto;max-width:' + max + 'px}';
  doc.head.appendChild(reset);

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

/**
 * Serialized into page.evaluate by pipeline.js: detect the source document's
 * content max-width. Prefers the computed max-width of the container that
 * holds the most section-like children (AI pages center a max-width column);
 * falls back to that container's laid-out width, then the default.
 * @param {number} fallbackWidth returned when no container is found
 * @returns {number} max-width in px
 */
export function detectContentMaxWidthInPage(fallbackWidth) {
  const candidates = Array.from(
    document.querySelectorAll('main, [role="main"], body > div')
  );
  let best = null;
  for (const el of candidates) {
    const kids = el.querySelectorAll('section, article, [data-page], [data-slide]').length;
    if (!best || kids > best.kids) best = { el, kids };
  }
  if (!best) return fallbackWidth;
  const cs = getComputedStyle(best.el);
  const mw = parseFloat(cs.maxWidth);
  if (cs.maxWidth && cs.maxWidth !== 'none' && Number.isFinite(mw) && mw > 0) {
    return Math.round(mw);
  }
  const w = best.el.getBoundingClientRect().width;
  if (Number.isFinite(w) && w > 0) return Math.round(w);
  return fallbackWidth;
}
