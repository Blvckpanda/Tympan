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

/** Content width at which the source page is laid out (landscape content @96dpi). */
export const CONTENT_W = 1026;

/** Portrait content width when the source does not declare one (@96dpi). */
export const PORTRAIT_CONTENT_W = 774;

/** Fallback width of the centered content column when detection finds nothing. */
export const DEFAULT_CONTENT_MAX_WIDTH = 870;

/** Clamp for the load-viewport width derived from the source (px). */
export const LOAD_WIDTH_MIN = 700;
export const LOAD_WIDTH_MAX = 1100;

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
 * Clamp a source-derived width to the range tympan lays out at.
 * @param {number} w
 * @returns {number}
 */
export function clampLoadWidth(w) {
  if (!Number.isFinite(w) || w <= 0) return PORTRAIT_CONTENT_W;
  return Math.round(Math.min(LOAD_WIDTH_MAX, Math.max(LOAD_WIDTH_MIN, w)));
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

  const firstStyle = document.querySelector('head style');
  if (firstStyle) {
    const st = document.createElement('style');
    st.textContent = firstStyle.textContent;
    doc.head.appendChild(st);
  }

  // Runtime/AI bundles inject <style> tags into <body>; without these the
  // extracted sections lose their styling entirely.
  for (const st of Array.from(document.body.querySelectorAll('style'))) {
    const clone = document.createElement('style');
    clone.textContent = st.textContent;
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
