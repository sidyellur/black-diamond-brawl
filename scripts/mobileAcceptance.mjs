/** WebKit mobile coverage complements Chromium and real iOS simulator checks.
 * Uses a landscape iPhone-like viewport; safe-area variables emulate a notch
 * deterministically here while the simulator exercises actual env() values.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { webkit } from 'playwright';
const base = (process.argv.find(a => a.startsWith('--url=')) ?? '--url=http://127.0.0.1:4173').slice(6);
mkdirSync('.verify', { recursive: true });
const checks = [];
const errors = [];
const browser = await webkit.launch();
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', e => errors.push(String(e)));
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log(`PASS ${label}`); };
const race = () => page.evaluate(() => {
  const s = window.__game.scene.getScene('RaceScene');
  return { paused: s.paused, lane: s.player.laneIndex, airborne: s.player.airborne, elapsed: s.elapsedRaceMs, z: s.player.worldZ, muted: s.audio.isMuted };
});
const tap = async (x, y) => {
  const b = await page.locator('canvas').boundingBox();
  assert.ok(b);
  await page.touchscreen.tap(b.x + x * b.width / 960, b.y + y * b.height / 540);
};
const insets = async (left, right, bottom) => {
  await page.evaluate(({ left, right, bottom }) => {
    const css = document.documentElement.style;
    css.setProperty('--safe-area-left', `${left}px`);
    css.setProperty('--safe-area-right', `${right}px`);
    css.setProperty('--safe-area-bottom', `${bottom}px`);
  }, { left, right, bottom });
  await page.waitForFunction(({ left, right, bottom }) => {
    const b = document.querySelector('canvas').getBoundingClientRect();
    const fit = Math.min((innerWidth - left - right) / 960, (innerHeight - bottom) / 540);
    return b.left >= left - 1 && b.right <= innerWidth - right + 1 && b.bottom <= innerHeight - bottom + 1 && Math.abs(b.width - 960 * fit) < 2;
  }, { left, right, bottom });
};
try {
  const requests = [];
  page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.goto(`${base}/?seed=4242&touch=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game?.scene.isActive('TitleScene'));
  check('WebKit boots the bundled game with no external asset requests', requests.every(url => new URL(url).origin === new URL(base).origin));
  await insets(47, 47, 21);
  check('notch and home-indicator insets bound the whole game canvas', true);
  await page.waitForFunction(() => !window.__game.scene.getScene('TitleScene').cameras.main.fadeEffect.isRunning);
  await page.screenshot({ path: '.verify/ios-webkit-title.png' });
  await context.setOffline(true);
  await tap(178, 351);
  await page.waitForFunction(() => window.__game.scene.isActive('RaceScene'));
  await page.evaluate(() => {
    const s = window.__game.scene.getScene('RaceScene');
    s.obstacles.length = 0; s.pickups.length = 0; s.crestApexZs.length = 0;
    s.aiRiders.forEach((r, i) => { r.worldZ = -1e6 - i * 1000; });
  });
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').countdownMs === 0);
  check('touch Drop In starts a race while offline', !(await race()).paused);
  await tap(142, 497);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.laneIndex === 3);
  check('WebKit touch steering carves one lane', (await race()).lane === 3);
  await tap(812, 497);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').player.airborne);
  check('WebKit touch jump launches rider', (await race()).airborne);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.context?.state === 'running');
  check('real WebKit audio unlocks from touch', true);
  await tap(687, 30);
  check('touch sound toggle saves mute', (await race()).muted && await page.evaluate(() => localStorage.getItem('bdb-muted') === '1'));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.context?.state === 'suspended');
  check('background interruption suspends audio', true);
  const paused = await race();
  await page.waitForTimeout(500);
  check('interruption freezes race time and position', (await race()).elapsed === paused.elapsed && (await race()).z === paused.z);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  check('return to the game requires explicit Resume', (await race()).paused);
  check('foreground does not restart audio automatically', await page.evaluate(() => window.__game.scene.getScene('RaceScene').audio.context?.state === 'suspended'));
  await tap(480, 267);
  await page.waitForFunction(() => !window.__game.scene.getScene('RaceScene').paused);
  check('touch Resume returns to racing', !(await race()).paused);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').audio.context?.state === 'running');
  check('Resume gesture recovers the real audio context', true);
  await insets(0, 47, 21);
  await insets(47, 0, 21);
  check('either landscape notch side preserves safe touch bounds', true);
  await page.screenshot({ path: '.verify/ios-webkit-race.png' });
  await tap(902, 77);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').paused);
  await tap(480, 321);
  await page.waitForFunction(() => window.__game.scene.getScene('RaceScene').countdownMs > 0);
  check('offline retry starts the same mountain', await page.evaluate(() => window.__game.scene.getScene('RaceScene').seed === 4242));
  await context.setOffline(false);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game?.scene.isActive('TitleScene'));
  check('mute preference survives a browser reload', await page.evaluate(() => localStorage.getItem('bdb-muted') === '1'));
  await tap(178, 351);
  await page.waitForFunction(() => window.__game.scene.isActive('RaceScene'));
  check('reloaded audio mixer uses the persisted mute value', (await race()).muted);
  check('WebKit reports no uncaught errors', errors.length === 0);
} catch (error) {
  await page.screenshot({ path: '.verify/ios-webkit-failure.png' }).catch(() => {});
  throw error;
} finally {
  writeFileSync('.verify/ios-webkit-report.json', JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
