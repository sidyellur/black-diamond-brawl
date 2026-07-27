/**
 * Sprite lab — renders every generated sprite at the scales the projection
 * actually uses, plus a silhouette pass, and writes a contact sheet.
 *
 * Authoring shaded pixel art with a code-edit -> rebuild -> boot -> race ->
 * squint loop does not work; you see one sprite, at one arbitrary size,
 * seconds after each change. This renders the whole set at 1x and at
 * projection-realistic widths side by side, so a change can be judged in one
 * look, and it runs headless so it can be part of the gate.
 *
 * The silhouette row is the important one. If a sprite does not read as its
 * subject in solid black, no amount of interior shading will save it once the
 * projection scales it down — that is the bar the reference project's critics
 * enforced, and it is the one my first prototype failed.
 *
 * Usage: npm run lab
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const OUT = resolve('.verify');
mkdirSync(OUT, { recursive: true });

const ROOT = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };
const server = createServer((q, s) => {
  let f = join(ROOT, (q.url || '/').split('?')[0] === '/' ? 'index.html' : decodeURIComponent((q.url || '/').split('?')[0]));
  if (!existsSync(f)) f = join(ROOT, 'index.html');
  s.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  s.end(readFileSync(f));
});
await new Promise((r) => server.listen(4174, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));

await page.goto('http://localhost:4174/?spritelab=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const report = await page.evaluate(() => window.__spriteLabReport || null);
await page.screenshot({ path: `${OUT}/sprite-lab.png`, fullPage: true });

await browser.close();
server.close();

if (report) {
  console.log('\n=== sprite lab ===');
  let failed = 0;
  for (const row of report) {
    const ok = row.outlineDeltaL >= row.min;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(26)} outline ΔL* ${row.outlineDeltaL
        .toFixed(1)
        .padStart(5)}  (min ${row.min})`
    );
  }
  console.log(`\ncontact sheet: ${OUT}/sprite-lab.png\n`);
  if (failed) {
    console.error(`${failed} sprite(s) below the outline contrast bar.`);
    process.exit(1);
  }
} else {
  console.log(`\nsprite lab rendered -> ${OUT}/sprite-lab.png (no report hook)\n`);
}
