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
