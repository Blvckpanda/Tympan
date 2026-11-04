/**
 * tagged.js — the standards tail: what `--flow --tagged` and `--flow --pdfa`
 * add to a print.
 *
 * Chromium's tagged PDF export (Playwright's `tagged` option, engine-pinned)
 * writes the structure tag tree (/StructTreeRoot, /MarkInfo, marked content
 * in the content streams). What it does NOT reliably write is the
 * self-description around it, and what it does write is not deterministic
 * (its writer stamps its own dates/producer). This module is the tail that
 * runs in finalize.js for a standards-shaped print so the file is
 * standards-shaped AND byte-identical run to run:
 *
 *   /ViewerPreferences <</DisplayDocTitle true>>  (the title belongs in the
 *        reader's window title bar, not hidden behind the page)
 *   /Lang                                         (screen readers pick a voice)
 *   an /Metadata XMP packet the pipeline OWNS: deterministic timestamps, the
 *        tympan producer, the document's title/author/subject, the PDF/UA-1
 *        identifier, and — with `--pdfa` — the PDF/A-2 identification schema
 *        (pdfaid:part 2, conformance B). Replacing Chromium's packet is what
 *        removes its wall-clock dates, which is why this lives in
 *        finalize.js territory.
 *   an /OutputIntents entry (with `--pdfa`): GTS_PDFA1 bound to the embedded
 *        sRGB v2 profile in assets/icc/ — the measured characterization, not
 *        a synthesized pseudo-sRGB (see assets/icc/README.md), 456 bytes,
 *        CC0, zero npm dependencies.
 *
 * Honest limits, which docs must state and code must not pretend past:
 *   - Deck/section mode merges one print per section with pdf-lib; the merged
 *     document cannot carry one shared structure tree, so `--tagged` is a
 *     flow-only flag (enforced upstream, error here is unreachable). The
 *     PDF/A tail lands on the finished single print for the same reason.
 *   - The structure tree is Chromium's, at its fidelity and its engine pin.
 *     tympan does not synthesize tags of its own. A downstream validator may
 *     still report engine-level findings (the unmarked page-fill/clip ops;
 *     figure alt text) — those are the engine's or the source document's to
 *     fix, named in SPEC §6.
 *   - `--pdfa` claims PDF/A-2b at Chromium's pin: what a real validator
 *     (veraPDF) accepts and rejects on that output is measured and recorded
 *     in SPEC §6, not asserted.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { version: TYMPAN_VERSION } = require('../package.json');

/** The mirrored fixed epoch: same semantics as finalize.js's FIXED_DATE. */
export const TAGGED_XMP_DATE = '2000-01-01T00:00:00Z';

/** PDF/UA identifier version this pipeline asserts. */
export const PDF_UA_VERSION = '1';

/** PDF/A-2 identification this pipeline asserts with --pdfa. */
export const PDF_A_PART = '2';
export const PDF_A_CONFORMANCE = 'B';

/**
 * The embedded sRGB characterization profile, CC0 (see assets/icc/README.md).
 * Loaded lazily and cached: `--pdfa` runs pay one disk read each, nothing
 * else pays anything.
 */
const SRGB_PROFILE_PATH = fileURLToPath(new URL('../assets/icc/sRGB-v2-micro.icc', import.meta.url));
let srgbProfileCache = null;
export function loadSrgbProfile() {
  if (!srgbProfileCache) srgbProfileCache = fs.readFileSync(SRGB_PROFILE_PATH);
  return srgbProfileCache;
}

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
 *
 * PDF/A-2 clause 6.6.2.3.1 — MEASURED against veraPDF 1.30.3's PDF/A-2
 * model, not asserted: the pdfuaid identification schema — even DECLARED
 * exactly the way veraPDF's own metadata fixer declares it (nested
 * rdf:Description form, pdfx fields, prefix, property array) — is rejected
 * by the profile as "not predefined, not defined in extension schema", and
 * the pdf:ExtensionSchema CONTAINER PROPERTY itself is rejected by the same
 * rule (veraPDF's own --fixmetadata output fails it too). An XMP packet can
 * therefore hold attested-PDF/A identification OR the PDF/UA-1 identifier,
 * not both, at this validator build. Measured policy:
 *   --pdfa        writes pdfaid:part/conformance ONLY — the packet carries
 *                 zero non-predefined schema properties, and no pdfuaid
 *                 entry.
 *   --tagged      keeps pdfuaid:part (the UA-1 identification schema, which
 *                 the UA-1 profile validates natively).
 *   --tagged --pdfa   is refused at the flag level: the claims collide in
 *                 one packet, and dropping one silently would break a
 *                 promised artifact.
 *
 * @param {{title?: string|null, author?: string|null, subject?: string|null,
 *          creator?: string|null, producer?: string|null, pdfa?: boolean}} [opts]
 * @returns {string}
 */
export function buildTaggedXmp(opts = {}) {
  const producer = opts.producer ?? `tympan ${TYMPAN_VERSION}`;
  const lines = [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  ];
  if (opts.pdfa) {
    // PDF/A-2b policy (see the block doc): only predefined-schema properties
    // survive the validator at this build — pdf, dc, xmp, pdfaid. No pdfuaid,
    // no pdfx container.
    lines.push(
      '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
      '   <dc:format>application/pdf</dc:format>'
    );
  } else {
    lines.push(
      '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">',
      '   <dc:format>application/pdf</dc:format>'
    );
  }
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
  lines.push(`   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>`);
  lines.push(`   <xmp:CreateDate>${TAGGED_XMP_DATE}</xmp:CreateDate>`);
  lines.push(`   <xmp:ModifyDate>${TAGGED_XMP_DATE}</xmp:ModifyDate>`);
  if (opts.pdfa) {
    lines.push(
      `   <pdfaid:part>${PDF_A_PART}</pdfaid:part>`,
      `   <pdfaid:conformance>${PDF_A_CONFORMANCE}</pdfaid:conformance>`,
      '  </rdf:Description>'
    );
  } else {
    lines.push(`   <pdfuaid:part>${PDF_UA_VERSION}</pdfuaid:part>`, '  </rdf:Description>');
  }
  lines.push(
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
 *          subject?: string|null, creator?: string|null, pdfa?: boolean}} [opts]
 */
export function applyStandardsTail(doc, opts = {}) {
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

  // --pdfa: the archive claim is bound to a measured color space. The
  // OutputIntent pairs the profile embedded verbatim from assets/icc/ with
  // the pdfaid (XMP) identification the packet above already wrote — both
  // halves are required for PDF/A-2's DeviceRGB rules, and neither is
  // pretended: without `--pdfa` no OutputIntent lands and no claim is
  // written. N=3: the profile is RGB; the bytes are the measured sRGB
  // characterization (see assets/icc/README.md), never synthesized.
  if (opts.pdfa) {
    const profileRef = ctx.nextRef();
    ctx.assign(profileRef, PDFRawStream.of(ctx.obj({ N: 3 }), loadSrgbProfile()));
    const intentRef = ctx.nextRef();
    ctx.assign(
      intentRef,
      ctx.obj({
        Type: 'OutputIntent',
        S: 'GTS_PDFA1',
        OutputConditionIdentifier: PDFString.of('sRGB'),
        DestOutputProfile: profileRef,
      })
    );
    doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([intentRef]));
  }

  // PDF/UA-1 7.18: every visible link annotation carries an alternate
  // description. Chromium's print emits Link annots with no Contents and no
  // Alt entry, so the annotation fails both 7.18.1 and 7.18.5 even though
  // its target is right there in the annotation dictionary. The least-
  // invented description is the one the document already carries — the
  // link's own URI — and that is what this writes. A richer description
  // (the link's text) is the source's to give; nothing here is synthesized.
  for (const page of doc.getPages()) {
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (!(annotsRef instanceof PDFRef) && !(annotsRef instanceof PDFArray)) continue;
    const annots = annotsRef instanceof PDFRef ? doc.context.lookup(annotsRef, PDFArray) : annotsRef;
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.get(i);
      const dict = annot instanceof PDFRef ? doc.context.lookupMaybe(annot, PDFDict) : annot instanceof PDFDict ? annot : null;
      if (!dict) continue;
      if (String(dict.get(PDFName.of('Subtype'))) !== '/Link') continue;
      const contents = dict.get(PDFName.of('Contents'));
      if (contents && String(contents).trim() !== '()') continue;
      const action = dict.get(PDFName.of('A'));
      const actionDict = action instanceof PDFRef ? doc.context.lookupMaybe(action, PDFDict) : action instanceof PDFDict ? action : null;
      const uri = actionDict ? actionDict.get(PDFName.of('URI')) : null;
      // /URI arrives as a text string value; anything else is skipped rather
      // than guessed.
      const uriText = uri instanceof PDFString || uri instanceof PDFHexString ? uri.asString() : null;
      if (!uriText) continue;
      dict.set(PDFName.of('Contents'), PDFString.of(uriText));
    }
  }
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
 *   outputIntent: boolean, pdfaid: string|null, pdfaConformance: string|null,
 *   tagged: boolean}}
 */
export function inspectTagged(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
  const structTreeRoot = /\/StructTreeRoot\b/.test(text);
  const markInfo = /\/MarkInfo\s*<<[^>]*\/Marked\s+true/.test(text);
  const langMatch = text.match(/\/Lang\s*\(([^)]*)\)/);
  const lang = langMatch ? langMatch[1].trim() || null : null;
  const displayDocTitle = /\/ViewerPreferences\s*<<(?:[^>]|\n){0,120}\/DisplayDocTitle\s+true/.test(text);
  const uaMatch = text.match(/<pdfuaid:part>\s*([^<\s]+)/);
  const uaId = uaMatch ? uaMatch[1] : null;
  const producerMatch = text.match(/<pdf:Producer>([^<]+)<\/pdf:Producer>/);
  const xmpProducer = producerMatch ? producerMatch[1] : null;
  const outputIntent = /\/GTS_PDFA1\b/.test(text);
  const pdfaidMatch = text.match(/<pdfaid:part>\s*([^<\s]+)/);
  const conformanceMatch = text.match(/<pdfaid:conformance>\s*([^<\s]+)/);
  return {
    structTreeRoot,
    markInfo,
    lang,
    displayDocTitle,
    uaId,
    xmpProducer,
    outputIntent,
    pdfaid: pdfaidMatch ? pdfaidMatch[1] : null,
    pdfaConformance: conformanceMatch ? conformanceMatch[1] : null,
    tagged: structTreeRoot && markInfo && !!uaId,
  };
}
