/**
 * email.js — email-optimized variant helpers.
 *
 * The regression-tested order matters: downscale images IN the loaded page
 * FIRST (canvas → JPEG data URLs), THEN re-extract section HTML — reusing
 * pre-downscale HTML was the bug that made the email PDF as large as the
 * master.
 */

/**
 * In-page step (serialized by page.evaluate). Downscale every image over
 * `maxW` px wide to a JPEG data URL at `quality`. Skips non-natural-size and
 * already-small images; counts failures without throwing.
 */
export function downscaleImagesInPage({ maxW, quality }) {
  let resized = 0;
  let skipped = 0;
  let failed = 0;
  for (const img of Array.from(document.images)) {
    try {
      if (!img.naturalWidth) {
        skipped++;
        continue;
      }
      const scale = Math.min(1, maxW / img.naturalWidth);
      if (scale >= 1) {
        skipped++;
        continue;
      }
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      img.src = c.toDataURL('image/jpeg', quality);
      resized++;
    } catch (e) {
      failed++;
    }
  }
  return { resized, skipped, failed, total: document.images.length };
}

/**
 * Node-side helper: merge the footer band HTML into the last section
 * (same trick the proven pipeline uses for the contact section).
 */
export function mergeFooter(sections, footerHtml) {
  if (!footerHtml || !sections.length) return sections;
  const out = sections.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = {
    ...last,
    html: last.html.replace(
      /<\/section>\s*$/,
      `<div style="margin-top:2rem">${footerHtml}</div></section>`
    ),
  };
  return out;
}
