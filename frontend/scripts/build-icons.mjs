// Rasterizes public/icon.svg into the PWA PNG icons (manifest + iOS apple-touch-icon).
// Run manually after editing icon.svg: `node scripts/build-icons.mjs`
// ponytail: reuses the already-installed playwright chromium instead of adding sharp/resvg.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(join(pub, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>*{margin:0}svg{display:block}</style>${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}`);
  await page.screenshot({ path: join(pub, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('wrote public/icon-192.png, public/icon-512.png');
