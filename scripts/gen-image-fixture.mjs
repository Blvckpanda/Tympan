/**
 * gen-image-fixture.mjs — regenerates test/fixtures/ai-deck-images.html.
 *
 * The fixture needs three ~2000px-wide embedded images so the email-variant
 * test can assert real downscaling. Images are generated deterministically
 * (pure Node: zlib + CRC32, no deps) and inlined as base64, so the repo stays
 * text-only and the fixture is reproducible:
 *
 *   node scripts/gen-image-fixture.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- minimal deterministic PNG writer (RGB, no filtering) ------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A deterministic test-pattern PNG: 32px gradient bands per channel so the
 * truecolor 2000x1200 image is real downscale work for the email pipeline
 * but still deflate-crushes to a small, commit-friendly fixture.
 */
function patternPng(width, height, seed) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    const by = (y >> 5) & 0xff;
    for (let x = 0; x < width; x++) {
      raw[p++] = (x >> 5) & 0xff;
      raw[p++] = (seed * 80) & 0xff;
      raw[p++] = (by + seed * 40) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sections = [1, 2, 3]
  .map((n) => {
    const png = patternPng(2000, 1200, n);
    const b64 = `data:image/png;base64,${png.toString('base64')}`;
    return `  <section class="page-section" id="img-${n}">
    <h1>Image Section ${n}</h1>
    <p>Embeds a deterministic 2000x1200 pattern (seed ${n}).</p>
    <img src="${b64}" alt="pattern ${n}" width="100%">
  </section>`;
  })
  .join('\n');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Images Fixture</title>
<style>
  body { font-family: Arial, sans-serif; }
  main { max-width: 870px; margin: 0 auto; }
  section { padding: 24px; border: 1px solid #ddd; margin-bottom: 16px; }
  img { display: block; }
</style>
</head>
<body>
<main>
${sections}
</main>
</body>
</html>
`;

const out = path.join(here, '..', 'test', 'fixtures', 'ai-deck-images.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
