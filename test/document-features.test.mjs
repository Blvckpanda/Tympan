/**
 * document-features.test.mjs — proves the v0.2.0 document-level features on
 * real converted output: hyperlinks survive the merge (they did not before),
 * the outline is written when requested, and metadata lands in the catalog.
 * Needs Chromium; skips cleanly when unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'ai-deck-links.html');
const out = (n) => path.join(here, 'out', n);
const skip = findChromium() ? false : 'Chromium not available';

test('links survive the merge, outline + metadata land', { skip }, async () => {
  const result = await convert(fixture, {
    out: out('links.pdf'),
    outline: true,
    author: 'Test Author',
    verify: false,
  });
  try {
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(result.master));
    assert.equal(doc.getPageCount(), 2);

    // 1. Hyperlinks survive: every page carries its URI link annotation.
    let linkCount = 0;
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookup(i);
        const subtype = a.get(PDFName.of('Subtype'));
        if (subtype && subtype.toString() === '/Link') linkCount++;
      }
    }
    assert.equal(linkCount, 2, 'link annotations preserved');

    // 2. Outline exists with 2 entries (Count on the Outlines dict).
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
    assert.ok(outlines, 'Outlines entry in catalog');
    assert.equal(outlines.get(PDFName.of('Count')).toString(), '2');

    // 3. Metadata: author set, title defaulted from <title>.
    // (Producer stays pdf-lib's: its save() hardcodes it.)
    assert.equal(doc.getAuthor(), 'Test Author');
    assert.equal(doc.getTitle(), 'Links Fixture');
  } finally {
    await fs.promises.rm(result.master, { force: true });
  }
});
