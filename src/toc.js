/**
 * toc.js — the generated "Contents" page (`--toc`, W3 in plan v0.8).
 *
 * Pure HTML/CSS synthesis, no printing: numbers arrive from whoever mapped
 * sections to sheets. Rows are capped so the page estimate used by BOTH
 * modes (a TOC is a page in section mode, a flowing block in flow mode)
 * stays honest: mez 1 overflow row shifts every number.
 *
 * Determinism: input order in, output order out, no dates, no randomness.
 */

export const TOC_ROWS_PER_PAGE = 40;

/**
 * How many sheets the TOC itself will occupy.
 * @param {number} sectionCount
 * @returns {number} >= 1
 */
export function estimateTocPages(sectionCount) {
  const rows = Math.max(0, Math.floor(sectionCount));
  if (!rows) return 1;
  return Math.ceil(rows / TOC_ROWS_PER_PAGE);
}

/**
 * Escape a string for HTML text content (titles come from the document).
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the TOC section HTML.
 * @param {Array<{title: string|null, id?: string, page: number}>} entries
 *   `page` is the 1-based sheet the section lands on after the TOC.
 * @returns {string}
 */
export function buildTocHtml(entries) {
  const rows = entries
    .map(
      (e) =>
        `      <li><span class="tympan-toc-title">${escapeHtml(e.title || e.id || 'Section')}</span>` +
        `<span class="tympan-toc-page">${Math.max(1, Math.floor(e.page))}</span></li>`
    )
    .join('\n');
  const css = [
    'section.tympan-toc { font-family: system-ui, sans-serif; }',
    'section.tympan-toc h2 { font-size: 1.6em; margin: 0 0 0.8em; }',
    'section.tympan-toc ol { list-style: none; margin: 0; padding: 0; }',
    'section.tympan-toc li { display: flex; align-items: baseline; gap: 0.75em; margin: 0.35em 0; }',
    'section.tympan-toc li + li { border-top: 1px dotted rgba(0,0,0,0.25); padding-top: 0.35em; }',
    'section.tympan-toc .tympan-toc-title { flex: 1 1 auto; }',
    'section.tympan-toc .tympan-toc-page { flex: 0 0 auto; color: #555; font-variant-numeric: tabular-nums; }',
  ].join('\n');
  return (
    `<section class="tympan-toc" id="tympan-toc">\n<style>${css}</style>\n` +
    '    <h2>Contents</h2>\n    <ol>\n' +
    rows +
    '\n    </ol>\n  </section>'
  );
}
