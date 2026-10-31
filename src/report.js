/**
 * report.js — machine-readable conversion report (`tympan deck.html --json`).
 *
 * A pure serializer over the convert() result: stable field names, no
 * derivation beyond summarizing detection, so CI can consume it without
 * importing tympan. Progress lines go to stderr; this object is the ONLY
 * thing on stdout in --json mode.
 */

/**
 * Build the JSON report from a convert() result.
 * @param {object} result convert() result
 * @param {object} [meta] { input, totalMs }
 * @returns {object} JSON-serializable report
 */
export function buildJsonReport(result, meta = {}) {
  return jsonReportFor(result, meta);
}

/**
 * Per-document report body (shared by single and batch reports, so a consumer
 * parses one shape for both).
 * @param {object} result
 * @param {object} meta
 * @returns {object}
 */
function jsonReportFor(result, meta = {}) {
  const d = result.detection || {};
  return {
    ok: !result.verification || result.verification.ok === true,
    input: meta.input ?? null,
    totalMs: meta.totalMs ?? null,
    master: result.master ?? null,
    email: result.email ?? null,
    detection: {
      strategy: d.strategy ?? null,
      confidence: d.confidence ?? null,
      sections: Array.isArray(d.sections) ? d.sections.length : null,
      prelude: Array.isArray(d.sections) ? d.sections.some((s) => s.prelude) : false,
    },
    background: result.background ?? null,
    contentMaxWidth: result.contentMaxWidth ?? null,
    // What the document asked for, and the sheet's own text column. Together
    // with contentMaxWidth these explain every scale in `pages`: a layout
    // wider than the column is the bug (and since 0.8 the clamp prevents it),
    // so CI can assert `contentMaxWidth <= geometry.columnW`.
    contentWidthRequested: result.contentWidthRequested ?? null,
    geometry: result.geometry
      ? {
          W_IN: result.geometry.W_IN,
          H_IN: result.geometry.H_IN,
          columnW: result.geometry.columnW,
          contentW: result.geometry.contentW,
          loadW: result.geometry.loadW,
          margins: result.geometry.margins,
        }
      : null,
    blockedRequests: result.blockedRequests ?? 0,
    layout: result.layout ?? 'section',
    // Plan §3.2: the JSON report states which mode was used AND why. The
    // result carries the pick and its arithmetic (`layoutChoice`); without
    // this field `--json` only said `layout: 'flow'` — the what, never the
    // why — and CI could not gate on the auto choice.
    layoutChoice: result.layoutChoice ?? null,
    // The remaining flow facts a caller can gate on, each null in section
    // mode or when the switch was off: the resolved running footer, the
    // Contents metadata and sheet numbers, the outline mapping, and the
    // fill ladder (`--fill tight`) with the candidate that won.
    pageFooter: result.pageFooter ?? null,
    toc: result.toc ?? null,
    outline: result.outline ?? null,
    fillPolicy: result.fillPolicy ?? null,
    // Flow-mode facts a caller can gate on: the page numbers switch, and the
    // DOM overflow verification measured (content wider than the column is
    // clipped by Chromium, so it must be visible).
    pageNumbers: result.pageNumbers ?? false,
    flow: result.flow ?? null,
    // Page-quality records, index-aligned with the final PDF. Null when a
    // caller hands in a result from before these existed, so consumers can
    // tell "not measured" apart from "measured, and clean".
    pages: Array.isArray(result.pages) ? result.pages : null,
    quality: result.quality ?? null,
    // What the document asked for and did not get (source print CSS, images
    // that failed to load, blocked requests, fixed/viewport-sized blocks).
    // `tympan lint` rules over this; CI can gate on it without a second run.
    audit: result.audit ?? null,
    // The two modes prove different things, so the report carries whichever
    // invariants actually ran instead of flattening flow into a section shape
    // (which is how a flow run once reported `{ok:true, outputs:[]}` — true,
    // and evidence of nothing).
    verification: result.verification
      ? result.verification.mode === 'flow'
        ? {
            mode: 'flow',
            ok: result.verification.ok,
            pages: result.verification.pages,
            pagesOk: result.verification.pagesOk,
            blankPages: result.verification.blankPages || [],
            clippedPages: result.verification.clippedPages || [],
            overflowPx: result.verification.overflowPx ?? 0,
            scaleApplied: result.verification.scaleApplied ?? 1,
            strandedHeadingPages: result.verification.strandedHeadingPages || [],
            keepTogether: result.verification.keepTogether || { measured: false, blocks: null },
            probeOk: result.verification.probeOk ?? null,
            sizeBytes: result.verification.sizeBytes ?? null,
          }
        : {
            mode: 'section',
            ok: result.verification.ok,
            outputs: (result.verification.outputs || []).map((o) => ({
              file: o.file,
              pages: o.pages,
              expected: o.expected,
              pagesOk: o.pagesOk,
              probeOk: o.probeOk ?? null,
              sizeBytes: o.sizeBytes,
            })),
          }
      : null,
  };
}

/**
 * Build the batch (`--json`) report from a convertMany() result: one entry per
 * input, each the same shape as buildJsonReport so consumers reuse one parser.
 * A failed input keeps its `input` and gains `ok:false`/`error` instead of
 * being dropped — a batch report must account for every input it was given.
 * @param {object} batch convertMany() result {ok, entries}
 * @param {object} [meta] { totalMs }
 * @returns {object} JSON-serializable report
 */
export function buildBatchJsonReport(batch, meta = {}) {
  const results = (batch?.entries || []).map((entry) =>
    entry.ok
      ? jsonReportFor(entry.result, { input: entry.input })
      : { ok: false, input: entry.input, error: entry.error ?? 'conversion failed' }
  );
  return {
    ok: results.every((r) => r.ok),
    count: results.length,
    failed: results.filter((r) => !r.ok).length,
    totalMs: meta.totalMs ?? null,
    results,
  };
}
