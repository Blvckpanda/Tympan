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
    blockedRequests: result.blockedRequests ?? 0,
    verification: result.verification
      ? {
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
