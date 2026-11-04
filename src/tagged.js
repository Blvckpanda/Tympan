/**
 * tagged.js — the standards tail: what `--flow --tagged` adds to a print.
 *
 * Chromium's tagged PDF export (Playwright's `tagged` option, engine-pinned)
 * writes the structure tag tree (/StructTreeRoot, /MarkInfo, marked content
 * in the content streams). What it does NOT reliably write is the
 * self-description around it, and what it does write is not deterministic
 * (its writer stamps its own dates/producer). This module is the tail that
 * runs in finalize.js for a tagged print so the file is standards-shaped AND
 * byte-identical run to run:
 *
 *   /ViewerPreferences <</DisplayDocTitle true>>  (the title belongs in the
 *        reader's window title bar, not hidden behind the page)
 *   /Lang                                         (screen readers pick a voice)
 *   an /Metadata XMP packet the pipeline OWNS: deterministic timestamps, the
 *        tympan producer, the document's title/author/subject, and the
 *        PDF/UA-1 identifier. Replacing Chromium's packet is what removes its
 *        wall-clock dates, which is why this lives in finalize.js territory.
 *
 * Honest limits, which docs must state and code must not pretend past:
 *   - Deck/section mode merges one print per section with pdf-lib; the merged
 *     document cannot carry one shared structure tree, so `--tagged` is a
 *     flow-only flag (enforced upstream, error here is unreachable).
 *   - The structure tree is Chromium's, at its fidelity and its engine pin.
 *     tympan does not synthesize tags of its own. A downstream validator may
 *     still report engine-level findings (e.g. figure alt text) — those are
 *     the source document's to fix.
 *   - PDF/A conformance needs an embedded OutputIntent (ICC profile) that
 *     Chromium's writer does not emit. The XMP identification half is here;
 *     the OutputIntent half is not, and is not faked.
 */
import { createRequire } from 'node:module';
import { PDFName, PDFRawStream, PDFString } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { version: TYMPAN_VERSION } = require('../package.json');

/** The mirrored fixed epoch: same semantics as finalize.js's FIXED_DATE. */
export const TAGGED_XMP_DATE = '2000-01-01T00:00:00Z';

/** PDF/UA identifier version this pipeline asserts. */
export const PDF_UA_VERSION = '1';

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the deterministic XMP packet. Only the fields the document actually
 * supplies appear (absent dc:* entries stay absent so title-only documents
 * do not claim an author), and every value is XML-escaped.
 * @param {{title?: string|null, author?: string|null, subject?: string|null,
 *          creator?: string|null, producer?: string|null}} [opts]
 * @returns {string}
 */
export function buildTaggedXmp(opts = {}) {
  const producer = opts.producer ?? `tympan ${TYMPAN_VERSION}`;
  const lines = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">',
    '   <dc:format>application/pdf</dc:format>',
  ];
  if (opts.title) {
    lines.push(`   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(opts.title)}</rdf:li></rdf:Alt></dc:title>`);
  }
  if (opts.author) {
    lines.push(`   <dc:creator><rdf:Bag><rdf:li>${xmlEscape(opts.author)}</rdf:li></rdf:Bag></dc:creator>`);
  }
  if (opts.subject) {
    lines.push(`   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(opts.subject)}</rdf:li></rdf:Alt></dc:description>`);
  }
  if (opts.creator) {
    lines.push(`   <xmp:CreatorTool>${xmlEscape(opts.creator)}</xmp:CreatorTool>`);
  }
  lines.push(
    `   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>`,
    `   <xmp:CreateDate>${TAGGED_XMP_DATE}</xmp:CreateDate>`,
    `   <xmp:ModifyDate>${TAGGED_XMP_DATE}</xmp:ModifyDate>`,
    `   <pdfuaid:pdfuaid>${PDF_UA_VERSION}</pdfuaid:pdfuaid>`,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  );
  return lines.join('\n') + '\n';
}

/**
 * Apply the tagged tail to a loaded print, in place. Deterministic by
 * construction: dictionary keys are set in one fixed order, the XMP is
 * generated from the supplied fields only.
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {{lang?: string|null, title?: string|null, author?: string|null,
 *          subject?: string|null, creator?: string|null}} [opts]
 */
export function applyTaggedTail(doc, opts = {}) {
  const ctx = doc.context;
  doc.catalog.set(
    PDFName.of('ViewerPreferences'),
    ctx.obj({ DisplayDocTitle: true })
  );
  if (opts.lang) {
    doc.catalog.set(PDFName.of('Lang'), PDFString.of(String(opts.lang)));
  } else {
    // A tagged print without a documented language must not keep the
    // engine's locale fallback: /Lang naming the printing machine's locale
    // is both wrong and non-deterministic across machines. The gap is the
    // source's to fix — `tympan lint --a11y` names it (a11y-html-lang).
    doc.catalog.delete(PDFName.of('Lang'));
  }
  // Replace (not merge) Chromium's own metadata stream: ours is the
  // deterministic one, and the print's native packet carries wall-clock
  // dates that would make two runs differ.
  const xmpRef = ctx.nextRef();
  ctx.assign(
    xmpRef,
    PDFRawStream.of(
      ctx.obj({ Type: PDFName.of('Metadata'), Subtype: PDFName.of('XML') }),
      Buffer.from(buildTaggedXmp(opts), 'utf8')
    )
  );
  doc.catalog.set(PDFName.of('Metadata'), xmpRef);
}

/**
 * Structural read of a produced PDF: what the standards tail and the engine
 * put there, as booleans/strings a test can assert. The finalize save writes
 * with `useObjectStreams: false`, so the catalog-level markers from BOTH
 * producers are plain text in the file — a byte scan is an honest
 * structural check, not a text-format coincidence. (No external validator is
 * bundled; veraPDF needs a JVM its users may not have.)
 *
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {{structTreeRoot: boolean, markInfo: boolean, lang: string|null,
 *   displayDocTitle: boolean, uaId: string|null, xmpProducer: string|null,
 *   tagged: boolean}}
 */
export function inspectTagged(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
  const structTreeRoot = /\/StructTreeRoot\b/.test(text);
  const markInfo = /\/MarkInfo\s*<<[^>]*\/Marked\s+true/.test(text);
  const langMatch = text.match(/\/Lang\s*\(([^)]*)\)/);
  const lang = langMatch ? langMatch[1].trim() || null : null;
  const displayDocTitle = /\/ViewerPreferences\s*<<(?:[^>]|\n){0,120}\/DisplayDocTitle\s+true/.test(text);
  const uaMatch = text.match(/<pdfuaid:pdfuaid>\s*([^<\s]+)/);
  const uaId = uaMatch ? uaMatch[1] : null;
  const producerMatch = text.match(/<pdf:Producer>([^<]+)<\/pdf:Producer>/);
  const xmpProducer = producerMatch ? producerMatch[1] : null;
  return {
    structTreeRoot,
    markInfo,
    lang,
    displayDocTitle,
    uaId,
    xmpProducer,
    tagged: structTreeRoot && markInfo && !!uaId,
  };
}
