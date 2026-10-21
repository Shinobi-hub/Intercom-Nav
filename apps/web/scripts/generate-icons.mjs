#!/usr/bin/env node
/**
 * Renders the PWA icons from public/icon.svg and public/icon-maskable.svg with headless Chromium:
 *   icon-192.png, icon-512.png                    (purpose "any", transparent rounded corners)
 *   icon-maskable-192.png, icon-maskable-512.png  (purpose "maskable", full bleed)
 *   apple-touch-icon.png                          (180×180, full bleed; iOS rounds the corners)
 *
 *   node apps/web/scripts/generate-icons.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = join(dirname(fileURLToPath(import.meta.url)), '../public');
const OUTPUTS = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-192.png', size: 192 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { src, out, size } of OUTPUTS) {
    const svg = await readFile(join(pub, src), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">
        <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">
      </body></html>`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    await page.screenshot({ path: join(pub, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`  ✓ ${out}`);
  }
} finally {
  await browser.close();
}
