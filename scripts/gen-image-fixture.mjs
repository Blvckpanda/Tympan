/**
 * gen-image-fixture.mjs — photo-like image fixture generator for the
 * email-variant test.
 *
 * Two modes:
 *   - import { writeImagesFixture } — generate at TEST TIME into a gitignored
 *     directory. Photo-like (noisy) images are multi-MB by nature; committing
 *     them as base64 bloats the repo for no reason.
 *   - node scripts/gen-image-fixture.mjs [out.html] — manual regeneration
 *     (defaults to test/out/, never test/fixtures/).
 *
 * Images are deterministic (hash noise + smooth gradients over a pure-Node
 * PNG writer — no deps). Photo-like content is the point: the email test's
 * strict-shrink assertion needs JPEG-friendly pixels. The original hard-edged
 * band pattern compressed equally in PNG and JPEG, which made the email
 * variant tie the master on size and the assertion lie about what it proved
 * (found 2026-09-29 when the portrait default exposed it).
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

/** Deterministic integer hash noise in [0,1) — no Math.random anywhere. */
function hashNoise(x, y, seed) {
  let h = (seed * 374761393 + x * 668265263 + y * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

/**
 * A photo-like deterministic PNG: smooth base gradients (JPEG's sweet spot)
 * plus ~12% luminance grain (photo realism). 2000x1200 truecolor.
 */
function photoPng(width, height, seed) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    const ny = y / height;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const base = [40 + 180 * nx, 60 + 150 * ny, 90 + 120 * (1 - nx)];
      for (let c = 0; c < 3; c++) {
        const n = (hashNoise(x, y, seed + c * 7) - 0.5) * 62;
        raw[p++] = Math.max(0, Math.min(255, Math.round(base[c] + n)));
      }
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

/**
 * Generate the image-deck fixture HTML (3 sections, one 2000x1200 image each)
 * at `outPath` and return the path.
 * @param {string} outPath
 * @returns {string}
 */
export function writeImagesFixture(outPath) {
  const sections = [11, 23, 37]
    .map((n) => {
      const png = photoPng(2000, 1200, n);
      const b64 = `data:image/png;base64,${png.toString('base64')}`;
      return `  <section class="page-section" id="img-${n}">
    <h1>Image Section ${n}</h1>
    <p>Embeds a deterministic 2000x1200 photo-like image (seed ${n}).</p>
    <img src="${b64}" alt="photo ${n}" width="100%">
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
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  return outPath;
}

// CLI: manual regeneration only — never writes into test/fixtures/.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || path.join(here, '..', 'test', 'out', 'ai-deck-images.html'));
  writeImagesFixture(out);
  console.log(`wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}
