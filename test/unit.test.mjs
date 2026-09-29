/**
 * unit.test.mjs — DOM-free unit tests for tympan's pure helpers.
 * Run: npm test   (node:test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeometry, resolveOutputs, cssColorToRgb } from '../src/pipeline.js';
import { clampLoadWidth } from '../src/template.js';
import { mergeFooter } from '../src/email.js';
import { withPrelude, describeDetection } from '../src/detect.js';
import { isPrivateTarget, requestGate } from '../src/security.js';
import { probeRegex } from '../src/verify.js';

test('resolveGeometry: portrait A4 is the default (v0.5 flip)', () => {
  const g = resolveGeometry({});
  assert.equal(g.W, 595.28);
  assert.equal(g.H, 841.89);
  assert.equal(g.W_IN, 8.27);
  assert.equal(g.H_IN, 11.69);
  assert.equal(g.contentW, 774);
  assert.deepEqual(g.margins, { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 });
});

test('resolveGeometry: landscape for slide decks', () => {
  const g = resolveGeometry({ orientation: 'landscape' });
  assert.equal(g.W, 841.89);
  assert.equal(g.H, 595.28);
  assert.equal(g.W_IN, 11.69);
  assert.equal(g.H_IN, 8.27);
  assert.equal(g.contentW, 1026);
});

test('resolveGeometry: letter format and margin overrides', () => {
  const g = resolveGeometry({ format: 'letter', margins: { top: 0.2 } });
  assert.equal(g.W, 612);
  assert.equal(g.H, 792);
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

test('cssColorToRgb: hex, rgb(), alpha-zero, named colors, junk', () => {
  assert.deepEqual(cssColorToRgb('#04060a'), { r: 4 / 255, g: 6 / 255, b: 10 / 255 });
  assert.deepEqual(cssColorToRgb('#fff'), { r: 1, g: 1, b: 1 });
  assert.deepEqual(cssColorToRgb('rgb(4, 6, 10)'), { r: 4 / 255, g: 6 / 255, b: 10 / 255 });
  assert.deepEqual(cssColorToRgb('white'), { r: 1, g: 1, b: 1 });
  assert.equal(cssColorToRgb('rgba(0, 0, 0, 0)'), null); // fully transparent -> no paint
  assert.equal(cssColorToRgb('banana'), null);
  assert.equal(cssColorToRgb(''), null);
});

test('isPrivateTarget: loopback, private ranges, metadata endpoints; public hosts pass', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.15', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'fd00:ec2::254', 'box.local', 'svc.internal']) {
    assert.ok(isPrivateTarget(h), h + ' must be private');
  }
  for (const h of ['example.com', '8.8.8.8', 'fonts.googleapis.com', '2606:4700::1111', '172.32.0.1', '169.253.0.1', '11.0.0.1']) {
    assert.ok(!isPrivateTarget(h), h + ' must not be private');
  }
});

test('withPrelude: inserts the prelude page BEFORE the sections (none lost)', () => {
  const sections = [
    { html: '<section id="a">a</section>', id: 'a' },
    { html: '<section id="b">b</section>', id: 'b' },
  ];
  const out = withPrelude(sections, { html: '<div class="hero">cover</div>', title: 'Cover' });
  assert.equal(out.length, 3, 'prelude + 2 sections');
  assert.equal(out[0].id, 'prelude');
  assert.equal(out[0].prelude, true);
  assert.equal(out[0].title, 'Cover');
  assert.equal(out[1].id, 'a', 'first section preserved');
  assert.equal(out[2].id, 'b');
  assert.equal(withPrelude(sections, null), sections); // no prelude -> unchanged
});

test('clampLoadWidth clamps to 700..1100 and falls back to portrait width', () => {
  assert.equal(clampLoadWidth(1026), 1026);
  assert.equal(clampLoadWidth(3000), 1100);
  assert.equal(clampLoadWidth(320), 700);
  assert.equal(clampLoadWidth(NaN), 774);
});

/** Minimal fake of the Playwright route surface for gate-decision tests. */
function fakeRoute(url) {
  const calls = [];
  const mainFrame = { page: () => null }; // identity matters for the nav check
  return {
    calls,
    request: () => ({
      url: () => url,
      isNavigationRequest: () => false,
      frame: () => mainFrame,
    }),
    abort: async () => calls.push('abort'),
    continue: async () => calls.push('continue'),
  };
}

function gatePolicy(over = {}) {
  return { offline: false, allowed: new Set(), mainUrl: 'file:///doc.html', ...over };
}

test('requestGate: file reads, metadata and private nets blocked; source + allowlist pass', async () => {
  // non-top-level file:// read from the page -> blocked
  let r = fakeRoute('file:///C:/secret.txt');
  await requestGate(gatePolicy(), r);
  assert.deepEqual(r.calls, ['abort']);
  // cloud metadata + private nets -> blocked
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9/x', 'http://10.1.2.3/i.png', 'http://192.168.1.4/']) {
    r = fakeRoute(url);
    await requestGate(gatePolicy(), r);
    assert.deepEqual(r.calls, ['abort'], url);
  }
  // the top-level source document itself -> allowed
  r = fakeRoute('file:///doc.html');
  const navFrame = { page: () => ({ mainFrame: () => navFrame }) }; // frame() === mainFrame
  r.request = () => ({ url: () => 'file:///doc.html', isNavigationRequest: () => true, frame: () => navFrame });
  await requestGate(gatePolicy(), r);
  assert.deepEqual(r.calls, ['continue']);
  // public host -> allowed
  r = fakeRoute('https://fonts.googleapis.com/css2?family=Inter');
  await requestGate(gatePolicy(), r);
  assert.deepEqual(r.calls, ['continue']);
  // allowlist wins over the private-range blocklist
  r = fakeRoute('http://10.1.2.3/i.png');
  await requestGate(gatePolicy({ allowed: new Set(['10.1.2.3']) }), r);
  assert.deepEqual(r.calls, ['continue']);
});

test('requestGate: offline mode blocks every non-file request', async () => {
  let r = fakeRoute('https://cdn.example.com/x.png');
  await requestGate(gatePolicy({ offline: true }), r);
  assert.deepEqual(r.calls, ['abort']);
  // the source document itself is NEVER blocked, even offline — it goes
  // through the top-level navigation exemption (a non-nav file:// read IS
  // blocked: that is page content trying to read local files)
  r = fakeRoute('file:///C:/doc.html');
  const offlineNavFrame = { page: () => ({ mainFrame: () => offlineNavFrame }) };
  r.request = () => ({ url: () => 'file:///C:/doc.html', isNavigationRequest: () => true, frame: () => offlineNavFrame });
  await requestGate(gatePolicy({ offline: true, mainUrl: 'file:///C:/doc.html' }), r);
  assert.deepEqual(r.calls, ['continue']);
  // allowlist does NOT punch through offline mode
  r = fakeRoute('https://cdn.example.com/x.png');
  await requestGate(gatePolicy({ offline: true, allowed: new Set(['cdn.example.com']) }), r);
  assert.deepEqual(r.calls, ['abort']);
});
