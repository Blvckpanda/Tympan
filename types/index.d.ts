/**
 * tympan — deterministic, secure, fast HTML→PDF converter.
 * One semantic section per page, runtime print-CSS defeated, self-verifying.
 */

export interface ConvertOptions {
  /** CSS selector overriding automatic section detection. */
  selector?: string;
  /** Page format. Default "a4". */
  format?: 'a4' | 'letter';
  /** Page orientation. Default "portrait" (landscape for slide decks). */
  orientation?: 'landscape' | 'portrait';
  /** Page background CSS color (default: the source's own html/body background). */
  background?: string;
  /** Page margins in inches. */
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Content width in px at which the source page is laid out. */
  contentWidth?: number;
  /** Also produce an email-optimized variant (images downscaled). */
  email?: boolean;
  /** Maximum image width (px) for the email variant. Default 1600. */
  emailMaxWidth?: number;
  /** JPEG quality (0-1) for the email variant. Default 0.82. */
  emailQuality?: number;
  /** Output path for the master PDF (default: input path with .pdf). */
  out?: string;
  /** Output path for the email PDF (default: master with -email suffix). */
  emailOut?: string;
  /** Text probe (string matched literally, or RegExp) asserted against the
   *  last page; case-insensitive and whitespace-flexible (extraction gaps
   *  of any width count as one space). */
  probe?: string;
  /** Only convert the first N sections (teaser/summary PDF). */
  teaser?: number;
  /** Add a PDF outline (bookmarks panel) with one entry per section. */
  outline?: boolean;
  /** PDF metadata title (default: the source document's <title>). */
  title?: string;
  /** PDF metadata author. */
  author?: string;
  /** PDF metadata subject. */
  subject?: string;
  /** PDF metadata creator (producing application). */
  creator?: string;
  /** Block every network request (offline conversion). */
  offline?: boolean;
  /** Hosts allowed despite the private-network blocklist (SSRF guard). */
  allowNet?: string[];
  /** Wait for this CSS selector before printing (charts, JS-mounted sections). */
  waitFor?: string;
  /** Timeout (ms) for `waitFor`. Default 10000. */
  waitTimeout?: number;
  /** Override the detected content max-width (px) of the clean column. */
  contentMaxWidth?: number;
  /**
   * Lay the document out at this width (px). Narrowing is allowed; widening is
   * capped at the printable column, because a layout wider than the paper is
   * what made Chromium silently scale every page down.
   */
  contentWidth?: number;
  /**
   * Print the whole body once and let Chromium paginate it, instead of one
   * section per page. Fills pages by flowing, not by shrinking; `--flow`.
   * Section mode stays the default, so existing output bytes do not move.
   */
  flow?: boolean;
  /** With `flow`: print "n / total" in the bottom margin (Chrome 131+). */
  pageNumbers?: boolean;
  /**
   * Layout picker: `deck` (default, one section per sheet), `flow` (sets   * `flow: true`), or `auto` — measures every section first and picks flow   * only when deck wastes more sheet area than `targetFill` allows or a   * section starts shrinking below 0.95 (`--layout`).
   */
  layout?: 'deck' | 'flow' | 'auto';
  /**
   * With `flow`: fill policy. `balanced` (default) flows natively; `tight`
   * tries a bounded micro-scale ladder (1, 0.98, 0.97) and keeps the   * fewest-pages winner (reported as `result.fillPolicy`); `loose` extends   * keep-together to `li, dd, dt` and accepts gaps.
   */
  fill?: 'balanced' | 'tight' | 'loose';
  /**
   * Static running footer the engine prints in the bottom margin
   * (Blink has no string-set, so it is static text; the book/contract
   * presets resolve it from the document <title> instead).
   */
  pageFooter?: string;
  /** (book/contract presets) resolve the running footer from <title>. */
  footerFromTitle?: boolean;
  /** Generate a Contents page with per-section sheet numbers (`--toc`). */
  toc?: boolean;
  /**
   * Documented option bundle: deck, report, book, invoice, contract.
   * Explicit flags win over every preset default.
   */
  preset?: 'deck' | 'report' | 'book' | 'invoice' | 'contract';
  /** Set false to skip self-verification. Default true. */
  verify?: boolean;
  /**
   * Share of the usable text area a page should carry before it is reported
   * as underfilled. Reporting only — nothing shrinks or reflows because of it.
   * Default 0.7 (TARGET_FILL).
   */
  targetFill?: number;
  /** Path to a Chromium executable (else TYMPAN_CHROMIUM / Playwright cache). */
  executablePath?: string;
  /** Progress callback: (event, data). */
  onProgress?: (event: string, data: unknown) => void;
  /**
   * Reuse an already-launched browser instead of launching one (batch runs).
   * A browser passed in is never closed by convert() — the caller owns it.
   */
  browser?: import('playwright').Browser;
}

export interface SectionDetection {
  strategy: 'selector' | 'page-section-class' | 'data-attribute' | 'semantic-children' | 'whole-document';
  confidence: number;
  sections: Array<{ html: string; id: string; title?: string | null; lead?: string | null; prelude?: boolean }>;
}

export interface OutputVerification {
  file: string;
  pages: number;
  expected: number;
  pagesOk: boolean;
  probeOk: boolean | null;
  sizeBytes: number;
}

/** One printed page's measurements, judged. Measured in the DOM before the
 * print — never read off the rendered pixels, where a painted background
 * makes a sparse page look full. */
export interface PageQuality {
  /** 1-based page number in the final PDF. */
  index: number;
  /** Detected section this page came from. */
  sectionId: string | null;
  /** Measured content height, carried through the shrink actually applied. */
  contentHeightPx: number;
  /** The usable text area: page height minus margins (px at 96/inch). */
  usableHeightPx: number;
  /** Height left blank at the bottom of the page (clamped at 0). */
  blankTailPx: number;
  /** contentHeightPx / usableHeightPx, 0-1. */
  fillRatio: number;
  /** Shrink factor applied to make the page fit (1 when nothing shrank). */
  scaleApplied: number;
  /** Shrink the width bound alone required (1 when the content fit the column). */
  widthScale: number;
  /** Why the page shrank — the two causes want opposite fixes. */
  scaledFor: 'height' | 'width' | 'none';
  /**
   * True when fillRatio is below the target (default 0.7) — the SECTION-mode
   * judgement. `null` when the caller said the run is flow (flow pages share
   * sheets, so "under 70%" is not a question the mode can answer); the same
   * tri-state as `keptTogether`'s unmeasured. Boolean when the caller did not
   * pass a layout, unchanged.
   */
  underfilled: boolean | null;
  /** True when the page's last block is a heading, stranding its section. */
  strandedHeading: boolean;
  /**
   * False when a `break-inside: avoid` block was split across pages. `null`
   * means unmeasured (flow mode: Chromium does not map a block to a page), and
   * is never the same claim as `true`.
   */
  keptTogether: boolean | null;
  /** Where the measurement came from: the DOM before printing, or the PDF. */
  measuredFrom?: 'dom' | 'pdf';
  /** Kind of the last block on the page. */
  lastBlockKind: 'heading' | 'text' | 'figure' | 'table' | null;
}

/** Document-level page-quality rollup. */
export interface QualitySummary {
  pages: number;
  targetFill: number;
  meanFill: number;
  minFill: number;
  /** 1-based page numbers below the target. */
  underfilledPages: number[];
  strandedHeadings: number[];
  splitKeepTogether: number[];
  /** Pages shrunk because their section was too tall (type size varies). */
  shrunkPages: number[];
  /** Pages shrunk because their content is wider than the column. */
  overflowPages: number[];
}

export interface SourceAssetRef {
  src: string;
  alt?: string;
  /** Printed page the image was missing from (null on the source-page list). */
  page?: number | null;
}

/**
 * What the document asked for and did not get. Gathered during the conversion
 * visit (read-only) and carried on the result so it can be reported or gated
 * on without a second run of the pipeline.
 */
export interface SourceAudit {
  /** The document's own print CSS, read through the CSSOM (never by regex). */
  printCss: { mediaPrint: number; pageRules: number; sheets: number; unreadableSheets: number };
  /** `position: fixed` blocks — printed once, at whatever they were over. */
  fixedElements: string[];
  /** Blocks sized to the viewport (vh), i.e. taller than the sheet. */
  viewportClamps: string[];
  /** Images that failed to load in the printed layout, per page. */
  brokenImages: SourceAssetRef[];
  /** Images that failed to load on the source page (fallback signal). */
  sourceBrokenImages: SourceAssetRef[];
  /** Requests refused by the security gate, with the reason. */
  blockedRequests: Array<{ url: string; reason: string }>;
  /** Number of <img> elements in the source document. */
  imageCount?: number | null;
}

export interface ConvertResult {
  /** Path of the master PDF. */
  master: string;
  /** Path of the email PDF (when options.email). */
  email: string | null;
  /** How sections were detected. */
  detection: SectionDetection;
  /** Content max-width (px) detected from the source container and applied. */
  contentMaxWidth: number;
  /** Content width the document asked for, before the column cap (px). */
  contentWidthRequested: number;
  /** Resolved page geometry, including `columnW` and `loadW`. */
  geometry: ReturnType<typeof resolveGeometry>;
  /** The resolved page background carried into the output. */
  background: string;
  /** Number of requests blocked by the security gate. */
  blockedRequests: number;
  /** Verification report (when options.verify !== false). */
  verification: {
    ok: boolean;
    /** Flow mode only: page count, blank pages, clipped pages, overflow. */
    mode?: 'flow' | 'section';
    pages?: number;
    pagesOk?: boolean;
    blankPages?: number[];
    clippedPages?: number[];
    overflowPx?: number;
    scaleApplied?: number;
    strandedHeadingPages?: number[];
    /** Flow mode: whether keep-together could be measured at all. */
    keepTogether?: { measured: boolean; blocks: number | null };
    probeOk?: boolean | null;
    sizeBytes?: number | null;
    sectionCount?: number;
    outputs?: OutputVerification[];
  };
  /** Flow mode only: the DOM overflow that verification checked. */
  flow?: {
    overflowPx: number;
    widthPx: number;
    pageNumbers: boolean;
    keepTogetherBlocks: number | null;
  };
  /** Flow mode: "n / total" printed in the bottom margin. */
  pageNumbers?: boolean;
  /** Resolved running footer (from --page-footer or a preset's title). */
  pageFooter?: string | null;
  /** Section or image pages inlined as data URIs when the request gate refused them. */
  assetInlining?: { inlined: number; urls: string[]; bytes: number; skipped: Array<{ url: string; reason: string }> };
  /** Set with --layout auto: the picked layout and the arithmetic behind it. */
  layoutChoice?: {
    picked: 'deck' | 'flow';
    reason: string;
    deckFill: number;
    flowFill: number;
    deckPages: number;
    flowPages: number;
  } | null;
  /** Set with --toc: the Contents metadata and per-section sheet numbers. */
  toc?: { pages: number; entries: number; stable: boolean; iterations: number; numbers: number[] } | null;
  /** Set with --fill tight: the bounded ladder and which candidate won. */
  fillPolicy?: { policy: string; scaleApplied: number; candidates: number[]; attempts: Array<{ scale: number; pages: number }> } | null;
  /** Set with --outline: how the outline destinations were mapped. */
  outline?: { entries: number; mappedBy: 'text-layer' | 'section-order' } | null;
  /** Pagination strategy used for this output. */
  layout: 'section' | 'flow';
  /** Per-page quality measurements, index-aligned with the final PDF. */
  pages: PageQuality[];
  /** Rollup of `pages`: fill, stranded headings, splits, shrinks. */
  quality: QualitySummary;
  /** Source-document audit behind the `tympan lint` rules. */
  audit: SourceAudit;
}

export declare function convert(inputPath: string, options?: ConvertOptions): Promise<ConvertResult>;

export interface BatchEntry {
  input: string;
  /** False when the conversion threw or self-verification failed. */
  ok: boolean;
  result: ConvertResult | null;
  error: string | null;
}

export interface BatchResult {
  ok: boolean;
  entries: BatchEntry[];
}

/**
 * Convert several inputs through one warm browser. A failure is contained:
 * the remaining inputs still convert and every input appears in `entries`.
 */
export declare function convertMany(
  inputs: string[],
  options?: ConvertOptions & {
    /** Per-input option overrides (typically `out`, since a batch has no single output path). */
    perInput?: (input: string, index: number) => ConvertOptions | undefined;
  }
): Promise<BatchResult>;

export declare function resolveGeometry(options?: ConvertOptions): {
  W: number;
  H: number;
  W_IN: number;
  H_IN: number;
  /** Printable column width (px): the sheet minus its side margins. */
  columnW: number;
  /** Print layout width (px), capped at `columnW`. */
  contentW: number;
  /** Width the source is rendered at while measuring (not the print width). */
  loadW: number;
  margins: { top: number; bottom: number; left: number; right: number };
};

export declare function findChromium(options?: { executablePath?: string }): string | null;

/** Environment/engine checks behind `tympan doctor`. */
export declare function enginePin(): { pinned: string | null; installed: string | null; exact: boolean };
export declare function doctorChecks(env: unknown): Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
export declare function runDoctor(): { checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }>; summary: { ok: boolean; failed: number }; nodeVersion: string };
export declare function formatDoctorReport(report: { checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }>; summary: { ok: boolean; failed: number } }): string;

/** Stable machine-readable report for `--json` output. */
export declare function buildJsonReport(result: unknown, meta?: { input?: string; totalMs?: number }): object;

/** Batch `--json` report: one entry per input, each in the single-document shape. */
export declare function buildBatchJsonReport(batch: BatchResult | unknown, meta?: { totalMs?: number }): object;

/** Share of the usable text area a page should carry before it is flagged. */
export declare const TARGET_FILL: number;
/** Content height as a share of the usable text area (0-1, clamped). */
export declare function fillRatio(contentHeightPx: number, usableHeightPx: number): number;
/** Height left blank at the bottom of a page (never negative). */
export declare function blankTailPx(contentHeightPx: number, usableHeightPx: number): number;
/** Judge one page from its raw measurements. */
export declare function judgePage(
  page: {
    index?: number;
    sectionId?: string | null;
    contentHeightPx: number;
    usableHeightPx: number;
    scaleApplied?: number;
    widthScale?: number;
    lastBlockKind?: string | null;
    keptTogether?: boolean;
  },
  options?: { targetFill?: number; layout?: 'section' | 'flow' }
): PageQuality;
/** Roll a document's pages up into one summary. */
export declare function summarizeQuality(
  pages: Array<Parameters<typeof judgePage>[0]>,
  options?: { targetFill?: number; layout?: 'section' | 'flow' }
): QualitySummary;
/** One human-readable line naming every quality finding present. */
export declare function formatQualityLine(summary: QualitySummary): string;

export type LintSeverity = 'error' | 'warning' | 'note';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** 1-based page the finding is about, when it is about one page. */
  page?: number;
  sectionId?: string | null;
  [detail: string]: unknown;
}

export interface LintReport {
  input: string | null;
  /** False only when the document has errors (a lost image, no pages). */
  ok: boolean;
  findings: LintFinding[];
  errors: number;
  warnings: number;
  notes: number;
  quality: QualitySummary | null;
}

export interface LintContext {
  input?: string;
  pages?: PageQuality[];
  quality?: QualitySummary | null;
  /** Resolved page geometry (metrics and column width come from here). */
  geometry?: { W_IN: number; H_IN: number; columnW?: number; contentW: number; margins: { top: number; bottom: number; left: number; right: number } };
  /** Width the source document was laid out at (px). */
  layoutWidthPx?: number;
  /** Width the source document ASKED for, before the column cap (px). */
  requestedLayoutWidthPx?: number;
  audit?: Partial<SourceAudit>;
  targetFill?: number;
  /** The output's print mode: flow pages are judged by the flow rules
   *  (flow-near-empty, flow-stranded-heading). Omitted: inferred from pages
   *  carrying `measuredFrom: 'pdf'`. */
  layout?: 'section' | 'flow' | null;
}

/** Severity ranking (higher wins when a run is summarized). */
export declare const SEVERITY_RANK: { error: number; warning: number; note: number };
/** Scale below which a shrink is a warning rather than a note (0.9). */
export declare const SCALE_WARN: number;
/** Spread across pages' scales that counts as inconsistent (0.05). */
export declare const SCALE_SPREAD: number;

/** Run every lint rule over one document's measurements (pure). */
export declare function lintDocument(ctx: LintContext): LintReport;
/** Totals across a lint run. */
export declare function summarizeLint(reports: LintReport[]): { errors: number; warnings: number; notes: number; ok: boolean };
/** A document that could not be converted, in lint-report shape. */
export declare function failureReport(input: string, message?: string): LintReport;
/** 0 clean, 1 findings that matter (`strict` also fails on warnings). */
export declare function lintExitCode(reports: LintReport[], opts?: { strict?: boolean }): 0 | 1;
/** Human-readable lint report (pure). */
export declare function formatLintReport(
  reports: LintReport[],
  opts?: { qualityLine?: (q: QualitySummary) => string }
): string;

/** Because the audit is opt-in, not always present. */
export interface A11yAudit {
  lang: string | null;
  h1Count: number;
  headingTotal: number;
  headingSkips: { from: string; to: string }[];
  imageTotal: number;
  missingAltCount: number;
  missingAlt: { src: string }[];
  controlTotal: number;
  unlabeledCount: number;
  unlabeled: string[];
  linkTotal: number;
  genericCount: number;
  genericLinks: { text: string }[];
  tableTotal: number;
  headerlessCount: number;
  headerlessTables: string[];
  lowContrastCount: number;
  lowestContrast: { describe: string; ratio: number; large: boolean } | null;
  lowContrast: { el: string; ratio: number; large: boolean }[];
}

/** One scanned PDF stream with its buckets, for `tympan bytes`. */
export interface ByteKindRollup {
  bytes: number;
  objects: number;
  largest: { num: number; kind: string; bytes: number; width: number | null; height: number | null; declaredBytes: number | null } | null;
  examples: Array<{ num: number; kind: string; bytes: number; width: number | null; height: number | null; declaredBytes: number | null }>;
}

/** Where in the produced PDF the bytes went (pure; no decompression). */
export interface ByteAudit {
  totalBytes: number;
  byKind: Record<string, ByteKindRollup>;
  structureBytes: number;
  structureObjects: number;
  streams: Array<{ num: number; kind: string; bytes: number; width: number | null; height: number | null; declaredBytes: number | null }>;
  pageCount: number | null;
  objectCount: number;
}

export declare const BYTE_KINDS: string[];
export declare function classifyStream(dict: string): string;
/** Audit the produced PDF's bytes from a Buffer (pure, zero-dep). */
export declare function auditPdfBytes(buf: Buffer | Uint8Array): ByteAudit;
/** Human-readable size audit (pure). */
export declare function formatBytesReport(
  reports: Array<{
    input: string | null;
    ok: boolean;
    error?: string;
    totalBytes?: number;
    pages?: number | null;
    mode?: string | null;
    audit?: ByteAudit;
  }>,
  opts?: { kbLine?: (n: number) => string }
): string;
/** One section measured for the page it would be printed on, without printing. */
export interface SectionMeasurement {
  id: string;
  title: string | null;
  /** Measured DOM height at the print column width (px). */
  heightPx: number;
  /** Real content width, scrollWidth included (px). */
  widthPx: number;
  /** Combined shrink the printer would start from. */
  scaleUsed: number;
  /** Shrink the width bound alone implies (1 when the content fits). */
  widthScaleUsed: number;
  contentHeightPx: number;
  usableHeightPx: number;
  lastBlockKind: 'heading' | 'text' | 'figure' | 'table' | null;
  brokenImages: SourceAssetRef[];
  /** Rendered path for preview, or null when no screenshot was taken. */
  shot: string | null;
}

/** Measure every section without printing anything. */
export declare function measureSections(
  browser: import('playwright').Browser,
  templateHtml: string,
  sections: Array<{ html: string; id: string; title?: string | null; prelude?: boolean }>,
  geo: ReturnType<typeof resolveGeometry>,
  options?: ConvertOptions & { shotDir?: string }
): Promise<SectionMeasurement[]>;

/**
 * In-page block measurement shared by the printer and the preview: height,
 * real content width, last block kind, failed images. Serialized into
 * page.evaluate, so it takes one serializable argument.
 */
export declare function measureBlockInPage(rootSelector?: string): {
  h: number;
  w: number;
  lastBlockKind: 'heading' | 'text' | 'figure' | 'table' | null;
  brokenImages: SourceAssetRef[];
};

/** Default port for `tympan preview`. */
export declare const PREVIEW_DEFAULT_PORT: number;
/** Sheet size in CSS px (96/inch) for a resolved geometry. */
export declare function sheetSizePx(geo: ReturnType<typeof resolveGeometry>): { w: number; h: number };
/** Content type for a served preview file (by extension, never sniffed). */
export declare function contentTypeFor(file: string): string;
/** The preview page (vanilla JS, no external scripts). Pure. */
export declare function previewPage(opts?: { title?: string }): string;

/** The JSON report the preview page renders. */
export interface PreviewReport {
  input: string;
  strategy: SectionDetection['strategy'];
  confidence: number;
  background: string;
  contentMaxWidth: number;
  geometry: ReturnType<typeof resolveGeometry>;
  sheet: { w: number; h: number };
  quality: QualitySummary;
  qualityLine: string;
  pages: Array<PageQuality & { title: string | null; heightPx: number; shot: string | null }>;
  findings: LintFinding[];
  summary: { errors: number; warnings: number; notes: number; ok: boolean };
  generatedAt: string;
}

/** Measure one document for preview (same path as convert, up to printing). */
export declare function buildPreviewReport(
  options: ConvertOptions & { input: string; shotDir?: string; teaser?: number }
): Promise<PreviewReport>;

/** Start the local preview server; `close()` stops it and its browser. */
export declare function createPreviewServer(
  options: ConvertOptions & { input: string; port?: number; shotDir?: string }
): Promise<{ url: string; port: number; refresh(why?: string): Promise<void>; close(): Promise<void>; report(): PreviewReport | null }>;

/** In-page source audit, serialized into page.evaluate by the pipeline. */
export declare function auditSourceInPage(): {
  printCss: SourceAudit['printCss'];
  fixedElements: string[];
  viewportClamps: string[];
  brokenImages: SourceAssetRef[];
  imageCount: number;
};

/** Default listen port for `tympan serve`. */
export declare const SERVE_DEFAULT_PORT: number;
/** Largest accepted JSON body for a serve job (bytes). */
export declare const MAX_BODY_BYTES: number;
/** Jobs a single tenant may hold at once. */
export declare const MAX_JOBS_PER_TENANT: number;
/** Design options a serve client may set; server policy is never client-set. */
export declare const ALLOWED_JOB_OPTIONS: string[];

/** Parse `TYMPAN_KEYS` (`key:tenant,key2:tenant2`) into a key → tenant map. */
export declare function parseApiKeys(spec: string): Map<string, string>;
/** Authorize a request by its headers (timing-safe; pure). */
export declare function authorize(
  headers: Record<string, string | string[] | undefined>,
  keys: Map<string, string>
): { ok: true; tenant: string } | { ok: false; reason: string };
/**
 * Validate a job request body. A `path`/`file` submission is refused by name,
 * and server-owned options (`offline`, `allowNet`) are dropped, not honored.
 */
export declare function validateJobRequest(
  body: unknown
): { ok: true; input: { kind: 'html' | 'url'; value: string }; options: Record<string, unknown> } | { ok: false; status: number; error: string };
/** The public view of a job: no tenant, no filesystem paths. */
export declare function publicJob(job: object, baseUrl?: string): object;
/** A bounded FIFO queue with a worker pool (pending + running is the bound). */
export declare function createJobQueue(opts: {
  concurrency?: number;
  run: (job: { id: string; status: string; [k: string]: unknown }) => Promise<unknown>;
  maxQueued?: number;
}): {
  enqueue(job: object): boolean;
  idle(): Promise<void>;
  stats(): { queued: number; active: number };
};

export interface ServeJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  report?: { pages: number | null; sizeBytes: number; qualityLine: string | null; quality: QualitySummary | null };
  pdfUrl?: string;
}

/** Start the conversion API server. */
export declare function createServeServer(options?: {
  port?: number;
  host?: string;
  keys?: Map<string, string>;
  concurrency?: number;
  ttlMs?: number;
  maxJobsPerTenant?: number;
  maxBodyBytes?: number;
  offline?: boolean;
  workdir?: string;
  convertImpl?: typeof convert;
  targetFill?: number;
}): Promise<{
  url: string;
  port: number;
  jobs: Map<string, ServeJob>;
  stats(): { queued: number; active: number; jobs: number; tenants: number };
  close(): Promise<void>;
}>;
/** Retention and concurrency policy a deploy is promising. */
export declare function servePolicy(options?: object): {
  concurrency: number;
  ttlMs: number;
  maxJobsPerTenant: number;
  maxBodyBytes: number;
  offline: boolean;
};
/** Resolved geometry for a job's options. */
export declare function jobGeometry(options?: ConvertOptions): ReturnType<typeof resolveGeometry>;

/** True when the argument is a glob pattern rather than a literal path. */
export declare function isGlobPattern(value: string): boolean;
/** True when the argument is a URL (never a path, never a pattern). */
export declare function isUrlInput(value: string): boolean;
/** Match a glob pattern (`*`, `?`, `[...]`, `**`) against one path. */
export declare function matchGlob(pattern: string, candidate: string): boolean;
/** Expand one pattern to sorted absolute file paths (`[]` when nothing matches). */
export declare function expandGlob(pattern: string, cwd?: string): string[];
/** Expand a CLI input list: URLs verbatim, paths resolved, globs in place. */
export declare function expandInputs(
  args: string[],
  options?: { cwd?: string }
): { inputs: string[]; unmatched: string[] };

/** Flag/value parser behind the CLI (pure). */
export declare function parseArgv(
  argv: string[],
  spec?: { valued?: string[]; repeatable?: string[]; boolean?: string[] }
): {
  positionals: string[];
  errors: string[];
  has(name: string): boolean;
  value(name: string): string | undefined;
  list(name: string): string[];
};

export interface FingerprintComparison {
  ok: boolean;
  reason: string | null;
  cells: number;
  differing: number;
  diffRatio: number;
  meanDelta: number;
  maxDelta: number;
  /** Per-cell flags (1 = different); present only when requested. */
  mask?: Array<0 | 1> | null;
}

/**
 * Compare two RGB fingerprints (flat arrays, 3 bytes per cell). Pure.
 * `ok` means the share of differing cells is within `tolerance` (default 2%).
 */
export declare function compareFingerprints(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  options?: { tolerance?: number; cellThreshold?: number; channels?: number; mask?: boolean }
): FingerprintComparison;

/** Row bands (shares of page height) that contain differing cells. Pure. */
export declare function diffBands(
  mask: Array<0 | 1> | null,
  gridWidth: number
): Array<{ top: number; bottom: number }>;
export declare const DIFF_SCALE: number;
export declare const DIFF_GAP: number;

/** Fingerprint grid for a page, preserving its aspect. */
export declare function fingerprintSize(w: number, h: number, width?: number): { w: number; h: number };
/** Stable per-input baseline directory name. */
export declare function goldenSlug(input: string): string;
/** Baseline file name for a 1-based page number. */
export declare function goldenPageName(n: number): string;
export declare const DEFAULT_TOLERANCE: number;
export declare const CELL_THRESHOLD: number;
export declare const FINGERPRINT_WIDTH: number;

export interface GoldenPageResult {
  page: number;
  ok: boolean;
  status: 'created' | 'updated' | 'match' | 'diff' | 'missing' | 'geometry-changed';
  file: string;
  grid: string;
  diffRatio?: number;
  differing?: number;
  cells?: number;
  meanDelta?: number;
  maxDelta?: number;
  baseline?: string;
  error?: string;
  /** Side-by-side review PNG written for this differing page (`--diff`). */
  diffFile?: string | null;
  /** Where on the sheet the change is, as shares of the page height. */
  diffBands?: Array<{ top: number; bottom: number }> | null;
}

export interface GoldenReport {
  ok: boolean;
  updated: boolean;
  /** True when the run was asked to write side-by-side review images. */
  diff: boolean;
  tolerance: number;
  goldenDir: string;
  entries: Array<{ input: string; ok: boolean; error: string | null; stale: string[]; pages: GoldenPageResult[] }>;
}

/** Pixel-golden regression: convert, fingerprint every page, compare with baselines. */
export declare function goldenTest(
  inputs: string[],
  options?: ConvertOptions & {
    goldenDir?: string;
    update?: boolean;
    tolerance?: number;
    keepDir?: string;
    fingerprintWidth?: number;
    /** Write a side-by-side PNG (baseline | current | differing cells). */
    diff?: boolean;
    /** Where those go (default `<goldenDir>/diff/<input>`). */
    diffDir?: string;
  }
): Promise<GoldenReport>;

/** Human-readable golden report (pure). */
export declare function formatGoldenReport(report: GoldenReport): string;
