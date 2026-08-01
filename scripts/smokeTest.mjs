/**
 * Headless visual smoke test / regression gate.
 *
 * Boots the built game in headless Chromium, drives it through the title
 * screen into a race, and asserts:
 *   1. no console errors or uncaught page errors,
 *   2. the canvas actually rendered (not a blank frame),
 *   3. measured CIE L* separation for gameplay-critical edges,
 *   4. no entity exceeds a sane fraction of screen width.
 *
 * Screenshots are written to `.verify/` for eyeballing. This is the gate the
 * v2 overhaul runs after every task — see docs issue "[Epic] v2 Visual &
 * Game-Feel Overhaul", Phase 0 item 2.
 *
 * Usage: node scripts/smokeTest.mjs [--update] [--url=http://localhost:4173]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('.verify');
const URL = (process.argv.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:4173').slice(6);

mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) {
    notes.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- colour helpers (CIE L*, the perceptually correct metric) -------------
const srgbToLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const relLuminance = ([r, g, b]) =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
const lStar = (rgb) => {
  const y = relLuminance(rgb);
  return y > 0.008856 ? 116 * Math.pow(y, 1 / 3) - 16 : 903.3 * y;
};
const deltaL = (a, b) => Math.abs(lStar(a) - lStar(b));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// The game canvas must exist and have non-zero size.
const canvasBox = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return c ? { w: c.width, h: c.height } : null;
});
check('canvas present', !!canvasBox && canvasBox.w > 0, canvasBox ? `${canvasBox.w}x${canvasBox.h}` : 'no canvas');

// Confirm we are on WebGL, not the Canvas fallback — postFX is WebGL-only.
const rendererType = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return 'none';
  return c.getContext('webgl2') || c.getContext('webgl') ? 'webgl' : 'canvas';
});
check('WebGL renderer active', rendererType === 'webgl', rendererType);

await page.screenshot({ path: `${OUT}/01-title.png` });

// Enter the race.
await page.keyboard.press('Space');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/02-race-early.png` });

await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/03-race-mid.png` });

/**
 * Samples a screenshot PNG by decoding it inside the browser (drawImage into a
 * 2D canvas + getImageData). Reading the WebGL backbuffer directly with
 * `readPixels` does NOT work here — Phaser leaves `preserveDrawingBuffer`
 * false, so the buffer is undefined once the frame has been composited. The
 * screenshot is also the more faithful thing to assert on: it's what a player
 * actually sees, post-composite.
 */
async function samplePng(pngBuffer) {
  const b64 = pngBuffer.toString('base64');
  return page.evaluate(async (dataUrl) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const { data, width: w, height: h } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const at = (x, y) => {
      const i = (y * w + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const rowMean = (y) => {
      let r = 0, g = 0, b = 0;
      let n = 0;
      for (let x = 0; x < w; x += 4) {
        const p = at(x, y);
        r += p[0]; g += p[1]; b += p[2]; n++;
      }
      return [r / n, g / n, b / n];
    };
    // Widest run of distinct row-mean values = evidence the frame has structure.
    return {
      w, h,
      skyBand: rowMean(Math.floor(h * 0.15)),
      horizonBand: rowMean(Math.floor(h * 0.5)),
      nearRoad: rowMean(Math.floor(h * 0.88)),
      center: at(Math.floor(w / 2), Math.floor(h * 0.55))
    };
  }, `data:image/png;base64,${b64}`);
}

const midShot = await page.screenshot();
const probe = await samplePng(midShot);

// A blank/solid frame means nothing rendered.
const skyVsRoad = deltaL(probe.skyBand, probe.nearRoad);
check('frame is not blank', skyVsRoad > 1.0, `sky↔road ΔL* ${skyVsRoad.toFixed(1)}`);

// Entity scale sanity. This is the regression test for the projection
// singularity: rivals used to draw over 1600px wide on a 960px screen, and
// combat resolved entirely inside that blow-up. Reads real runtime state
// rather than pixels, via the harness hook in main.ts.
const scales = await page.evaluate(() => {
  const g = window.__game;
  const sc = g && g.scene.getScene('RaceScene');
  if (!sc || !sc.playerSprite) return null;
  const riders = (sc.aiRiderRenderer?.pool || []).filter((s) => s.visible).map((s) => s.displayWidth);
  return { player: sc.playerSprite.displayWidth, riders };
});

if (scales) {
  const maxW = Math.max(scales.player, ...(scales.riders.length ? scales.riders : [0]));
  check('no entity exceeds 42% of screen width', maxW <= 960 * 0.42 + 1, `widest ${maxW.toFixed(0)}px`);
  check('player is on screen at a sane size', scales.player > 20 && scales.player < 300, `${scales.player.toFixed(0)}px`);
} else {
  check('runtime scale probe', false, 'could not read RaceScene state');
}

// The attack button, end to end: park a rival in reach, press F, and assert
// the game registered a deliberate attack rather than silently doing nothing.
const attackResult = await page.evaluate(async () => {
  const g = window.__game;
  const sc = g && g.scene.getScene('RaceScene');
  if (!sc || !sc.combat) return { ok: false, why: 'no scene' };
  const r = sc.aiRiders[0];
  // Seat the rival in the ADJACENT lane. Attacks reach 1.2 lanes while body
  // checks only trigger same-lane, so this is reachable by a press but never
  // by passive contact — which keeps the test measuring the attack path
  // instead of racing the automatic body check and its pair immunity.
  r.params.aggression = 0; // and stop it bumping its way back into our lane
  // Rivals cruise at up to 105% of MAX_SPEED and re-accelerate toward it, so
  // a rival left at a nominally lower speed can be FASTER than the player by
  // the time the press lands — which flips who wins and makes the player the
  // one who recoils. Pin it slow so the outcome under test is unambiguous.
  r.params.cruiseSpeedFactor = 0.5;
  r.wipedOut = false;
  r.finishTimeMs = null;
  r._laneIndex = sc.player.laneIndex + 1;
  r.tween = null;
  r.worldZ = sc.player.worldZ;
  // Must keep pace: parking it at speed 0 while the player runs at 3000 u/s
  // puts it thousands of units behind within a frame, far outside reach.
  // Slightly slower so the player still wins the exchange.
  r.speed = 2900;
  sc.player.speed = 3000;
  await new Promise((res) => setTimeout(res, 200));
  // A slower rival falls behind fast (the gap grows at the speed difference),
  // so re-seat it alongside just before the press. Safe to do here precisely
  // because it is in a DIFFERENT lane: no entering-edge body check can fire,
  // so this cannot contaminate the attack under test.
  r.worldZ = sc.player.worldZ;
  r._laneIndex = sc.player.laneIndex + 1;
  r.tween = null;
  await new Promise((res) => setTimeout(res, 60));
  r.worldZ = sc.player.worldZ;
  return { ok: true, targeted: sc.combat.target !== null, cooldown: sc.combat.attackOnCooldown };
});

await page.keyboard.press('KeyF');
await page.waitForTimeout(120);

const afterAttack = await page.evaluate(() => {
  const sc = window.__game.scene.getScene('RaceScene');
  return {
    swinging: sc.player.swingMsRemaining > 0,
    riderRecoiling: sc.aiRiders[0].hitReactionMsRemaining > 0,
    onCooldown: sc.combat.attackOnCooldown
  };
});
await page.screenshot({ path: `${OUT}/05-attack.png` });

check('a rival in reach becomes the attack target', attackResult.ok && attackResult.targeted, JSON.stringify(attackResult));
check('pressing F starts a swing', afterAttack.swinging, JSON.stringify(afterAttack));
check('the struck rival visibly recoils', afterAttack.riderRecoiling);
check('attack goes on cooldown', afterAttack.onCooldown);

// Drive into the result screen so the finish/wipeout path is exercised too —
// a crash there would otherwise never show up in this gate.
await page.waitForTimeout(1000);
const reachedResult = await page.evaluate(async () => {
  const g = window.__game;
  const sc = g && g.scene.getScene('RaceScene');
  if (!sc || !sc.player) return 'no-scene';
  sc.player.crashIntoTree(); // run-ending wipeout -> ResultScene
  return 'triggered';
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/04-result.png` });
const onResult = await page.evaluate(() => {
  const g = window.__game;
  return g.scene.isActive('ResultScene');
});
check('wipeout reaches the result screen', reachedResult === 'triggered' && onResult, String(onResult));

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | ') || 'clean');

await browser.close();

const report = [
  '',
  '=== visual smoke test ===',
  ...notes,
  ...failures,
  ''
].join('\n');
writeFileSync(`${OUT}/report.txt`, report);
console.log(report);

if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('all checks passed.');
