/**
 * platen — zero-config HTML→PDF converter for AI-generated documents.
 * One semantic section per page, runtime print-CSS defeated, self-verifying.
 */

export interface ConvertOptions {
  /** CSS selector overriding automatic section detection. */
  selector?: string;
  /** Page format. Default "a4". */
  format?: 'a4' | 'letter';
  /** Page orientation. Default "landscape". */
  orientation?: 'landscape' | 'portrait';
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
  /** Text probe (string or RegExp source) asserted against the last page. */
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
  /** Override the detected content max-width (px) of the clean column. */
  contentMaxWidth?: number;
  /** Set false to skip self-verification. Default true. */
  verify?: boolean;
  /** Path to a Chromium executable (else PLATEN_CHROMIUM / Playwright cache). */
  executablePath?: string;
  /** Progress callback: (event, data). */
  onProgress?: (event: string, data: unknown) => void;
}

export interface SectionDetection {
  strategy: 'selector' | 'page-section-class' | 'data-attribute' | 'semantic-children' | 'whole-document';
  confidence: number;
  sections: Array<{ html: string; id: string }>;
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
  /** Verification report (when options.verify !== false). */
  verification: { ok: boolean; sectionCount: number; outputs: OutputVerification[] };
}

export declare function convert(inputPath: string, options?: ConvertOptions): Promise<ConvertResult>;

export declare function resolveGeometry(options?: ConvertOptions): {
  W: number;
  H: number;
  W_IN: number;
  H_IN: number;
  contentW: number;
  margins: { top: number; bottom: number; left: number; right: number };
};

export declare function findChromium(options?: { executablePath?: string }): string | null;
