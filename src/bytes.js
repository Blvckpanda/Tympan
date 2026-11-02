/**
 * bytes.js — `tympan bytes`: the size instrument SPEC §4 Phase 2 requires.
 *
 * Phase 2 names "File-size optimization (resource dedupe, object streams,
 * image handling)" and gives it an exit criterion: "measured size reduction
 * vs baseline". Optimization before measurement is guessing — v0.8's own
 * dedupe probe recorded that 28 font programs deduplicate to almost nothing
 * (99.7% of their bytes are per-section glyph subsets) while printing once
 * (`--flow`) won 3.2x. This module is the instrument that makes such calls
 * boring: it converts with the same flags (`tympan bytes deck.html`), then
 * reads the produced PDF and reports WHERE the bytes are — images, embedded
 * font programs, content streams (the paint list), forms/shadings, metadata
 * and everything else (xref, dictionaries, the trailer).
 *
 * Two things it deliberately does NOT do:
 *   - It does not decompress. Sizes are the bytes each object occupies ON
 *     DISK after its /Filter, because that is what dominates the file and
 *     what an optimization pass would have to shrink. zlib stays out.
 *   - It does not judge. A photo-heavy deck legitimately spends 90% on
 *     images; a 90% font share is the per-section glyph-subset story the
 *     plan already measured. The report names the share and the largest
 *     objects; the caller decides what to optimize.
 *
 * Everything here is pure and I/O-free: auditPdfBytes takes a Buffer, so
 * the scan is unit-tested without Chromium, on hand-built PDFs and (end to
 * end, Chromium-guarded) on real Chromium output.
 */

/**
 * The report buckets, in the order the human report prints them.
 * `structure` (non-stream bytes: xref, dictionaries, the trailer) is
 * separate and printed last.
 */
export const BYTE_KINDS = ['image', 'font', 'form', 'content', 'metadata', 'other'];

/** Streams in the detail list: a report names the heaviest, not every one. */
const STREAM_DETAIL_CAP = 64;
/** Per-bucket example objects kept on the rollup (for --json consumers). */
const EXAMPLE_CAP = 3;

/**
 * Classify ONE stream by its dictionary words.
 *
 * Rule-ordered, names-only: /Subtype /Image wins (an SMask-carrying image
 * still says /Image); a font program declares itself (/FontFile2 for
 * TrueType, /Length1 on Type1); /Type /Metadata is metadata; the PDF 1.5
 * file-level plumbing — the xref stream and object streams — is plumbing,
 * not document payload, so it buckets as 'other' rather than masquerading
 * as content a page paints with; an XObject Form (or a bare /XObject —
 * some paint resource) is a form; everything else is a content stream a
 * page's /Contents points at.
 * @param {string} dict the object dictionary (text between `obj` and `stream`)
 * @returns {string} one of BYTE_KINDS
 */
export function classifyStream(dict) {
  if (/\/Subtype\s*\/Image\b/.test(dict)) return 'image';
  if (/\/FontFile\b/.test(dict) || /\/Length1\b/.test(dict)) return 'font';
  if (/\/Type\s*\/Metadata\b/.test(dict)) return 'metadata';
  if (/\/Type\s*\/XRef\b/.test(dict)) return 'other'; // /Type /XRef — the cross-reference stream
  if (/\/Type\s*\/ObjStm\b/.test(dict)) return 'other'; // /Type /ObjStm — packed dictionaries
  if (/\/Subtype\s*\/Form\b/.test(dict)) return 'form';
  // A bare /XObject carries no /Subtype — bucket with forms.
  if (/\/Type\s*\/XObject\b/.test(dict)) return 'form';
  return 'content';
}

/** Fresh per-kind rollup. */
function freshTotals() {
  const t = {};
  for (const k of BYTE_KINDS) t[k] = { bytes: 0, objects: 0, largest: null, examples: [] };
  return t;
}

const numeric = (dict, key) => {
  const m = new RegExp(`\\/${key}\\s+(\\d+)\\b`).exec(dict);
  return m ? Number(m[1]) : null;
};

/**
 * Walk a PDF's objects from its bytes and audit them (pure, zero-dep).
 *
 * Positional, resumable scan: after each object is consumed, the search
 * resumes past its `endobj` (or past its `endstream`), so binary stream
 * data — which CAN contain the words `obj` or `0 obj` — is never re-parsed
 * as structure. A `stream` keyword only counts when followed (PDF's own
 * rule) by \r\n or \n, so dictionary tokens like `/XRefStm` cannot trigger
 * it, and an object body saying "stream" in a name triggers nothing.
 *
 * Assumption, stated honestly: no `endstream` sequence appears inside
 * compressed stream data. Chromium (Skia) emits long streams flate, where
 * a false hit is possible but vanishingly rare; it would MERGE two stream
 * objects into one entry — byte totals stay honest, the object count
 * drifts by one. Page counting is best-effort on structure dicts only
 * (/Type /Page, distinct from /Type /Pages); the CLI carries the real
 * count from the conversion when it has one.
 *
 * @param {Buffer|Uint8Array} buf produced PDF bytes
 * @returns {{
 *   totalBytes: number,
 *   byKind: Record<string, {bytes: number, objects: number, largest: (object|null), examples: Array<object>}>,
 *   structureBytes: number,
 *   structureObjects: number,
 *   streams: Array<object>,
 *   pageCount: number|null,
 *   objectCount: number
 * }}
 */
export function auditPdfBytes(buf) {
  const raw = buf instanceof Buffer ? buf : Buffer.from(buf);
  const s = raw.toString('latin1');

  const byKind = freshTotals();
  const streams = [];
  let structureObjects = 0;
  let structureBytes = 0;
  let pageCount = null;

  const OBJ = /\b(\d+) \d+ obj\b/g;
  let m;
  while ((m = OBJ.exec(s)) !== null) {
    const num = Number(m[1]);
    const dictStart = m.index + m[0].length;
    const endObj = s.indexOf('endobj', dictStart);
    if (endObj === -1) break; // truncated input: keep what was scanned

    // Only a real stream keyword opens data: `obj`-adjacent, before this
    // object's endobj, followed by EOL, and terminated by `endstream`.
    const streamIdx = s.indexOf('stream', dictStart);
    if (streamIdx !== -1 && streamIdx < endObj) {
      const kwEnd = streamIdx + 'stream'.length;
      if (s[kwEnd] === '\n' || (s[kwEnd] === '\r' && s[kwEnd + 1] === '\n')) {
        const dataStart = s[kwEnd] === '\r' ? kwEnd + 2 : kwEnd + 1;
        const endStream = s.indexOf('endstream', dataStart);
        if (endStream !== -1) {
          let dataEnd = endStream;
          if (s[dataEnd - 1] === '\n') dataEnd--; // the EOL PDF wrote before it
          if (s[dataEnd - 1] === '\r') dataEnd--;
          const dict = s.slice(dictStart, streamIdx);
          const kind = classifyStream(dict);
          const entry = {
            num,
            kind,
            bytes: Math.max(0, dataEnd - dataStart),
            // Image geometry, when the dict declares it.
            width: numeric(dict, 'Width'),
            height: numeric(dict, 'Height'),
            declaredBytes: numeric(dict, 'Length'),
          };
          const k = byKind[kind];
          k.bytes += entry.bytes;
          k.objects++;
          if (!k.largest || entry.bytes > k.largest.bytes) k.largest = entry;
          if (k.examples.length < EXAMPLE_CAP) k.examples.push(entry);
          streams.push(entry);
          continue; // resume AFTER endstream: binary data is not structure
        }
      }
    }

    // Non-stream object: dictionaries count as structure; /Type /Page
    // (and not /Pages — word boundary) tallies the best-effort page count.
    structureObjects++;
    structureBytes += endObj + 6 - m.index;
    const dict = s.slice(dictStart, endObj);
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      /* the tree node — not a page */
    } else if (/\/Type\s*\/Page\b/.test(dict)) {
      pageCount = (pageCount || 0) + 1;
    }
  }

  return {
    totalBytes: raw.length,
    byKind,
    structureBytes,
    structureObjects,
    streams: streams.sort((a, b) => b.bytes - a.bytes).slice(0, STREAM_DETAIL_CAP),
    pageCount,
    objectCount: structureObjects + streams.length,
  };
}

/**
 * Human-readable audit. Pure: the CLI prints it, tests assert on it.
 * `structure` is computed as totalBytes minus every scanned byte so the
 * arithmetic always ties out (remaining stream bytes count into their
 * kind; the rest — xref, free entries, dict overhead outside counted
 * object words, the trailer — shows as structure).
 * @param {Array<object>} reports per input: {input, ok, error?, totalBytes?, pages?, mode?, audit?}
 * @param {object} [opts] { kbLine?: (n) => string }
 * @returns {string}
 */
export function formatBytesReport(reports, opts = {}) {
  const kb = opts.kbLine || ((n) => `${(n / 1024).toFixed(1)} KB`);
  const lines = [];
  for (const r of reports) {
    if (!r.ok) {
      lines.push(`[FAIL] ${r.input ?? '(unknown input)'}: ${r.error ?? 'conversion failed'}`);
      continue;
    }
    const a = r.audit;
    const scale = r.totalBytes ?? a.totalBytes ?? 1;
    const meta = `${r.pages != null ? `, ${r.pages} pages` : ''}${r.mode ? ` (${r.mode} mode)` : ''}`;
    lines.push(`[bytes] ${r.input} — ${kb(scale)}${meta}`);
    for (const kind of BYTE_KINDS) {
      const k = a.byKind[kind];
      if (!k || k.objects === 0) continue;
      const share = Math.round((k.bytes / scale) * 100);
      const big = k.largest
        ? `; largest #${k.largest.num} ${kb(k.largest.bytes)}` +
          (k.largest.width ? ` (${k.largest.width}x${k.largest.height})` : '')
        : '';
      lines.push(
        `     ${kind.padEnd(9)}${kb(k.bytes).padStart(10)} (${String(share).padStart(2)}%)  ${k.objects} object(s)${big}`
      );
    }
    const shareS = Math.round((a.structureBytes / scale) * 100);
    lines.push(
      `     ${'structure'.padEnd(9)}${kb(a.structureBytes).padStart(10)} (${String(shareS).padStart(2)}%)  ${a.structureObjects} object(s)  (xref, dicts, trailer)`
    );
  }
  const ok = reports.filter((r) => r.ok);
  const total = ok.reduce((n, r) => n + (r.totalBytes ?? (r.audit && r.audit.totalBytes)), 0);
  lines.push(
    `tympan bytes: ${reports.length} document(s), ${kb(total)} total` +
      (ok.length - reports.length ? `, ${reports.length - ok.length} failed` : '')
  );
  return lines.join('\n');
}
