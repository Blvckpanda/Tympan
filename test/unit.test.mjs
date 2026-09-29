/**
 * unit.test.mjs — DOM-free unit tests for tympan's pure helpers.
 * Run: npm test   (node:test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeometry, resolveOutputs } from '../src/pipeline.js';
import { mergeFooter } from '../src/email.js';
import { describeDetection } from '../src/detect.js';
import { probeRegex } from '../src/verify.js';

test('resolveGeometry: landscape A4 defaults', () => {
  const g = resolveGeometry({});
  assert.equal(g.W, 841.89);
  assert.equal(g.H, 595.28);
  assert.equal(g.W_IN, 11.69);
  assert.equal(g.H_IN, 8.27);
  assert.equal(g.contentW, 1026);
  assert.deepEqual(g.margins, { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 });
});

test('resolveGeometry: portrait swaps page dims, keeps margins', () => {
  const g = resolveGeometry({ orientation: 'portrait' });
  assert.equal(g.W, 595.28);
  assert.equal(g.H, 841.89);
  assert.equal(g.margins.top, 0.4);
});

test('resolveGeometry: letter format and margin overrides', () => {
  const g = resolveGeometry({ format: 'letter', margins: { top: 0.2 } });
  assert.equal(g.W, 792);
  assert.equal(g.margins.top, 0.2);
  assert.equal(g.margins.bottom, 0.4);
});

test('resolveOutputs: strips .html, derives -email path', () => {
  const o = resolveOutputs('C:/docs/proposal.html', { email: true });
  assert.equal(o.master, 'C:/docs/proposal.pdf');
  assert.equal(o.email, 'C:/docs/proposal-email.pdf');
});

test('resolveOutputs: explicit out wins', () => {
  const o = resolveOutputs('C:/docs/proposal.html', { out: 'C:/tmp/x.pdf' });
  assert.equal(o.master, 'C:/tmp/x.pdf');
  assert.equal(o.email, 'C:/tmp/x-email.pdf');
});

test('mergeFooter: injects footer into last section only', () => {
  const sections = [
    { id: 'a', html: '<section id="a"><p>a</p></section>' },
    { id: 'b', html: '<section id="b"><p>b</p></section>' },
  ];
  const out = mergeFooter(sections, '<div class="text-center">footer</div>');
  assert.equal(out.length, 2);
  assert.ok(out[1].html.includes('footer'));
  assert.ok(out[1].html.endsWith('</section>'));
  assert.ok(!out[0].html.includes('footer'));
});

test('mergeFooter: no-op without footer or sections', () => {
  const sections = [{ id: 'a', html: '<section id="a"></section>' }];
  assert.equal(mergeFooter(sections, null), sections);
  assert.deepEqual(mergeFooter([], '<div>x</div>'), []);
});

test('describeDetection formats strategy and confidence', () => {
  const d = { strategy: 'data-attribute', confidence: 0.85, sections: [{}, {}, {}] };
  assert.equal(describeDetection(d), '3 sections (data-attribute, 85%)');
  assert.equal(
    describeDetection({ strategy: 'whole-document', confidence: 0.2, sections: [{}] }),
    '1 section (whole-document, 20%)'
  );
});

test('probeRegex: survives unstable extraction whitespace and case', () => {
  // The extraction artifact that broke real-deck probes (0.4.0 finding):
  // pdfjs joins put 1-3 spaces between words of the same sentence.
  const text = 'challenging for   a   solo   developer working on a timeline.';
  assert.ok(probeRegex('solo developer').test(text));
  assert.ok(probeRegex('SOLO DEVELOPER').test(text));
  assert.ok(probeRegex(/solo developer/).test(text));
  assert.ok(probeRegex('for a solo').test(text));
  assert.ok(!probeRegex('solo typographer').test(text));
});

test('probeRegex: string probes match literally, regex probes stay regexes', () => {
  assert.ok(probeRegex('Q10 (Your Personal Scope)').test('Q10 (Your Personal Scope) begins')); // ( ) are text, not groups
  assert.ok(!probeRegex('Q10 (Your Personal Scope)').test('Q10 X')); // not a wildcard pattern
  assert.ok(probeRegex(/Q\d/).test('Q7 — something')); // explicit regex keeps semantics
  assert.ok(probeRegex(/a b c/).test('a  b   c')); // literal spaces in a regex source are flexed
  assert.ok(probeRegex(/a {2}b/).test('a  b')); // space before a quantifier stays the quantified atom (no throw)
});
