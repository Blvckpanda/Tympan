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
  /** Set false to skip self-verification. Default true. */
  verify?: boolean;
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
  sections: Array<{ html: string; id: string; title?: string | null; prelude?: boolean }>;
}

export interface OutputVerification {
  file: string;
  pages: number;
  expected: number;
  pagesOk: boolean;
  probeOk: boolean | null;
  sizeBytes: number;
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
  /** The resolved page background carried into the output. */
  background: string;
  /** Number of requests blocked by the security gate. */
  blockedRequests: number;
  /** Verification report (when options.verify !== false). */
  verification: { ok: boolean; sectionCount: number; outputs: OutputVerification[] };
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
  contentW: number;
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
}

/**
 * Compare two RGB fingerprints (flat arrays, 3 bytes per cell). Pure.
 * `ok` means the share of differing cells is within `tolerance` (default 2%).
 */
export declare function compareFingerprints(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  options?: { tolerance?: number; cellThreshold?: number; channels?: number }
): FingerprintComparison;

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
}

export interface GoldenReport {
  ok: boolean;
  updated: boolean;
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
  }
): Promise<GoldenReport>;

/** Human-readable golden report (pure). */
export declare function formatGoldenReport(report: GoldenReport): string;
