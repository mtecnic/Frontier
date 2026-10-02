// Render the PWA icons from the SVG artwork in client/src/art.ts (needs Playwright + Chromium).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART } from '../client/src/art.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'client/static/icons');
mkdirSync(dir, { recursive: true });

const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect x="44" y="14" width="8" height="68" rx="3" fill="#fff"/><path d="M52 16l30 11-30 12z" fill="#fff"/><rect x="26" y="78" width="44" height="6" rx="3" fill="#fff"/></svg>`;

const jobs = [
  ['icon-192.png', ART.logo, 192],
  ['icon-512.png', ART.logo, 512],
  ['maskable-512.png', ART.logo, 512],
  ['apple-touch-icon.png', ART.logo, 180],
  ['badge-96.png', badge, 96],
];

const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(opts);
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, svg, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: join(dir, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', name);
}
await browser.close();
writeFileSync(join(dir, 'favicon.svg'), ART.logo.replace('<rect width="512" height="512" fill="#1d3a3f"/>', '<rect width="512" height="512" rx="96" fill="#1d3a3f"/>'));
console.log('wrote favicon.svg');
